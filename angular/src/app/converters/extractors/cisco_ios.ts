/**
 * Extractor for Cisco IOS and IOS-XE: reads a file and returns what it says as a
 * vendor-neutral `Device`.
 *
 * The commands the extractor understands are in the rule tables below, one line per
 * command. A command without a rule is reported as not converted.
 */
import { Device, Duplex, newDevice, newPort, Port, SourceFile, Speed, StormControl, Vlan, addOnce } from '../model';
import { commandKey, Report } from '../report';
import { readIndentedBlocks } from '../readers/indented_blocks';
import { abbreviates, readIosCapture } from '../readers/ios_capture';
import { sourceLines, Statement, textAfter } from '../readers/statement';
import { expandCiscoInterfaceRange, readCiscoInterface } from './cisco_interfaces';
import { addMissingLags, NOT_A_SWITCH_PORT, referencedVlans } from './common';
import { ignore, rule, RuleTable } from './rules';
import { expandVlanRanges, isIpAddress, isIpv4, isVlanId, parseVlanList, subnetOf, VlanRange } from './values';

/** FDDI and Token Ring VLANs that every Catalyst has and that no port uses. */
const LEGACY_VLANS = [1002, 1003, 1004, 1005];

/** After these keywords comes another keyword, so two words name the command in a report. */
const GLOBAL_KEYWORDS = new Set(['aaa', 'crypto', 'ip', 'ipv6', 'logging', 'mac', 'ntp', 'router', 'snmp-server', 'spanning-tree', 'vlan']);
const PORT_KEYWORDS = new Set(['access-session', 'authentication', 'auto', 'cdp', 'dot1x', 'ip', 'ipv6', 'lldp', 'logging', 'mls', 'power', 'service-policy', 'snmp', 'spanning-tree', 'storm-control', 'switchport', 'udld']);

/** The kinds of traffic of "storm-control <traffic> level". Some switches say "unknown-unicast". */
type StormTraffic = 'broadcast' | 'multicast' | 'unicast';
const STORM_TRAFFIC: Array<[string, StormTraffic]> = [
  ['broadcast', 'broadcast'],
  ['multicast', 'multicast'],
  ['unicast', 'unicast'],
  ['unknown-unicast', 'unicast'],
];
const SPEEDS: Record<string, Speed> = { '10': '10m', '100': '100m', '1000': '1g', '2500': '2.5g', '5000': '5g', '10000': '10g', '25000': '25g', '40000': '40g', '100000': '100g' };

/* ------------------------------------------------------------ what is read */

/** A port while its commands are read. `finishPort` turns it into a `Port`. */
interface PortDraft {
  port: Port;
  line: number;
  /** False after "no switchport". */
  switchport: boolean;
  /** What follows "switchport mode". */
  modeCommand?: string;
  accessVlan?: number;
  voiceVlan?: number;
  nativeVlan?: number;
  /** "switchport trunk allowed vlan": undefined without the command, [] after "none". */
  allowed?: VlanRange[] | 'all';
  removed: VlanRange[];
  /** True or false after "spanning-tree portfast ...", undefined without the command. */
  portfast?: boolean;
  bpduGuard: boolean;
  dot1x: boolean;
  mab: boolean;
  portSecurity: boolean;
  portSecurityMaximum?: number;
  periodicReauthentication: boolean;
  reauthenticationTimer?: number;
  /** "storm-control <traffic> level ...": the level in percent, or undefined when it is in bits or packets per second. */
  storm: Map<StormTraffic, number | undefined>;
  stormShutdown: boolean;
  /** Commands of the port without a rule. They are reported when the port is converted. */
  unknown: Array<{ command: string; line: number }>;
}

interface RadiusDraft {
  host?: string;
  authPort: number;
  acctPort: number;
  timeout: number;
}

interface TacacsDraft {
  host?: string;
  port: number;
}

interface Context {
  device: Device;
  report: Report;
  vlans: Map<number, Vlan>;
  drafts: Map<string, PortDraft>;
  /** "spanning-tree portfast default": access ports are edge ports unless they say otherwise. */
  portfastDefault: boolean;
  /** "ip dhcp snooping vlan ...". */
  dhcpSnooping: VlanRange[];
  /** VLANs that have a VLAN interface: they exist on the switch, with or without an address. */
  sviVlans: number[];
  banners: Map<string, string>;
}

/* -------------------------------------------------------------- port rules */

function vlanId(text: string): number | undefined {
  return isVlanId(text) ? Number(text) : undefined;
}

/** A handler for a command that carries one VLAN id. */
function withVlan(set: (draft: PortDraft, id: number) => void): (draft: PortDraft, m: { id: string }) => void | false {
  return (draft, m) => {
    const id = vlanId(m.id);
    if (id === undefined) return false;
    set(draft, id);
    return undefined;
  };
}

function withVlanList(set: (draft: PortDraft, ranges: VlanRange[]) => void): (draft: PortDraft, m: { list: string }) => void | false {
  return (draft, m) => {
    const ranges = parseVlanList(m.list);
    if (!ranges) return false;
    set(draft, ranges);
    return undefined;
  };
}

/** Every VLAN but those of the list. */
function complement(ranges: VlanRange[]): VlanRange[] {
  const result: VlanRange[] = [];
  let next = 1;
  for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
    if (range.from > next) result.push({ from: next, to: range.from - 1 });
    next = Math.max(next, range.to + 1);
  }
  if (next <= 4094) result.push({ from: next, to: 4094 });
  return result;
}

const portRules = new RuleTable<PortDraft>(
  [
    rule('description <text...>', (draft, _m, statement) => {
      draft.port.description = textAfter(statement, 1);
    }),
    rule('shutdown', (draft) => {
      draft.port.disabled = true;
    }),
    rule('no shutdown', (draft) => {
      draft.port.disabled = false;
    }),

    // Layer 2
    rule('no switchport', (draft) => {
      draft.switchport = false;
    }),
    rule('switchport', (draft) => {
      draft.switchport = true;
    }),
    rule('switchport mode <mode...>', (draft, m) => {
      draft.modeCommand = m.mode.toLowerCase();
    }),
    rule('switchport access vlan <id>', withVlan((draft, id) => (draft.accessVlan = id))),
    rule('switchport voice vlan <id>', (draft, m) => {
      // "dot1p", "none" and "untagged" are not VLANs
      draft.voiceVlan = vlanId(m.id);
    }),
    rule('switchport trunk native vlan <id>', withVlan((draft, id) => (draft.nativeVlan = id))),
    rule('switchport trunk allowed vlan none', (draft) => {
      draft.allowed = [];
    }),
    rule('switchport trunk allowed vlan all', (draft) => {
      draft.allowed = 'all';
    }),
    rule('switchport trunk allowed vlan add <list>', withVlanList((draft, ranges) => {
      // Added to "all", the list changes nothing.
      if (draft.allowed !== 'all') draft.allowed = [...(draft.allowed ?? []), ...ranges];
    })),
    rule('switchport trunk allowed vlan remove <list>', withVlanList((draft, ranges) => {
      if (draft.allowed === 'all' || draft.allowed === undefined) draft.allowed = complement(ranges);
      else draft.removed.push(...ranges);
    })),
    rule('switchport trunk allowed vlan except <list>', withVlanList((draft, ranges) => {
      draft.allowed = complement(ranges);
    })),
    rule('switchport trunk allowed vlan <list>', withVlanList((draft, ranges) => {
      draft.allowed = ranges;
      draft.removed = [];
    })),
    rule('channel-group <id> mode <mode>', (draft, m) => {
      draft.port.lag = { name: `Port-channel${m.id}`, lacp: m.mode.toLowerCase() !== 'on' };
    }),
    rule('channel-group <id>', (draft, m) => {
      draft.port.lag = { name: `Port-channel${m.id}`, lacp: false };
    }),

    // Physical layer
    rule('speed <speed...>', (draft, m) => {
      draft.port.speed = SPEEDS[m.speed] ?? 'auto';
    }),
    rule('duplex <duplex>', (draft, m) => {
      const duplex = m.duplex.toLowerCase();
      if (duplex !== 'auto' && duplex !== 'half' && duplex !== 'full') return false;
      draft.port.duplex = duplex as Duplex;
      return undefined;
    }),
    rule('mtu <bytes>', (draft, m) => {
      if (!/^\d+$/.test(m.bytes)) return false;
      draft.port.mtu = Number(m.bytes);
      return undefined;
    }),
    rule('power inline never', (draft) => {
      draft.port.poe = false;
    }),
    rule('auto qos ...', (draft) => {
      draft.port.qos = true;
    }),

    // Spanning tree
    rule('spanning-tree portfast', (draft) => {
      draft.portfast = true;
    }),
    rule('spanning-tree portfast edge', (draft) => {
      draft.portfast = true;
    }),
    rule('spanning-tree portfast trunk', (draft) => {
      draft.portfast = true;
    }),
    rule('spanning-tree portfast edge trunk', (draft) => {
      draft.portfast = true;
    }),
    rule('spanning-tree portfast disable', (draft) => {
      draft.portfast = false;
    }),
    rule('spanning-tree portfast network', (draft) => {
      draft.portfast = false;
    }),
    rule('spanning-tree portfast normal', (draft) => {
      draft.portfast = false;
    }),
    // A port with BPDU guard is converted as an edge port: this is the Mist setting that
    // disables a port when it receives a BPDU.
    rule('spanning-tree bpduguard enable', (draft) => {
      draft.bpduGuard = true;
    }),

    // 802.1X and MAC authentication
    rule('dot1x pae authenticator', (draft) => {
      draft.dot1x = true;
    }),
    rule('mab ...', (draft) => {
      draft.mab = true;
    }),
    rule('authentication host-mode <mode>', (draft, m) => {
      draft.port.auth.multipleSupplicants = ['multi-auth', 'multi-domain'].includes(m.mode.toLowerCase());
    }),
    rule('access-session host-mode <mode>', (draft, m) => {
      draft.port.auth.multipleSupplicants = ['multi-auth', 'multi-domain'].includes(m.mode.toLowerCase());
    }),
    rule('authentication periodic', (draft) => {
      draft.periodicReauthentication = true;
    }),
    rule('authentication timer reauthenticate <seconds>', (draft, m) => {
      // "server" leaves the interval to the RADIUS server
      if (/^\d+$/.test(m.seconds)) draft.reauthenticationTimer = Number(m.seconds);
    }),
    rule('authentication event fail action authorize vlan <id>', withVlan((draft, id) => (draft.port.auth.serverRejectVlan = id))),
    rule('authentication event fail retry <count> action authorize vlan <id>', withVlan((draft, id) => (draft.port.auth.serverRejectVlan = id))),
    rule('authentication event server dead action authorize vlan <id>', withVlan((draft, id) => (draft.port.auth.serverFailVlan = id))),
    rule('authentication event server dead action reinitialize vlan <id>', withVlan((draft, id) => (draft.port.auth.serverFailVlan = id))),
    rule('authentication event no-response action authorize vlan <id>', withVlan((draft, id) => (draft.port.auth.guestVlan = id))),

    // Port security
    rule('switchport port-security', (draft) => {
      draft.portSecurity = true;
    }),
    rule('switchport port-security maximum <count>', (draft, m) => {
      if (!/^\d+$/.test(m.count)) return false;
      draft.portSecurityMaximum = Number(m.count);
      return undefined;
    }),
    rule('switchport port-security mac-address sticky', (draft) => {
      draft.port.persistMac = true;
    }),

    // Storm control and DHCP snooping
    rule('storm-control action shutdown', (draft) => {
      draft.stormShutdown = true;
    }),
    ignore('storm-control action trap'),
    rule('storm-control <traffic> level <levels...>', (draft, m) => {
      const traffic = STORM_TRAFFIC.find(([word]) => abbreviates(m.traffic.toLowerCase(), word, 1))?.[1];
      // "level 10.00 5.00": the rising level, then the falling one. "level bps 10m", "level pps 500": not a percentage.
      const [rising] = m.levels.split(' ');
      if (traffic === undefined || !/^(\d+(\.\d+)?|bps|pps)$/i.test(rising)) return false;
      draft.storm.set(traffic, /^\d/.test(rising) ? Number(rising) : undefined);
      return undefined;
    }),
    rule('ip dhcp snooping trust', (draft) => {
      draft.port.dhcpTrusted = true;
    }),

    ignore(
      'exit',
      'switchport nonegotiate',
      'switchport trunk encapsulation ...',
      'switchport port-security violation ...',
      'switchport port-security aging ...',
      'negotiation auto',
      'keepalive ...',
      'mdix auto',
      'cdp enable',
      'lldp transmit',
      'lldp receive',
      'snmp trap ...',
      'logging event ...',
      'load-interval <seconds>',
      'carrier-delay ...',
      'flowcontrol ...',
      'udld port ...',
      'channel-protocol ...',
      'lacp rate ...',
      'lacp port-priority ...',
      'power inline auto ...',
      'power inline static ...',
      'power inline port ...',
      'spanning-tree link-type ...',
      'spanning-tree bpduguard disable',
      'ip dhcp snooping limit ...',
      'ip arp inspection trust',
      'ip arp inspection limit ...',
      'ip device tracking ...',
      'device-tracking attach-policy ...',
      'vrf forwarding <name>',
      'macro description ...',
      // Settings of 802.1X whose Mist equivalent is the port usage itself or its defaults
      'authentication port-control ...',
      'access-session port-control ...',
      'authentication order ...',
      'authentication priority ...',
      'authentication violation ...',
      'authentication event server alive action reinitialize',
      'authentication event server dead action authorize voice',
      'authentication timer restart <seconds>',
      'authentication timer inactivity ...',
      'authentication control-direction ...',
      'dot1x timeout ...',
      'dot1x max-req <count>',
      'dot1x max-reauth-req <count>',
      'access-session closed',
    ),
  ],
  // "no <command>" turns a setting off: apart from the ones above, that is the state a port usage starts from.
  { ignoreCase: true, abbreviations: true, otherwise: [ignore('no ...')] },
);

/* ----------------------------------------------------- rules of sub-blocks */

interface VlanBlock {
  ids: number[];
  context: Context;
}

const vlanBlockRules = new RuleTable<VlanBlock>(
  [
    rule('name <name...>', (block, _m, statement) => {
      // A name belongs to a block that declares one VLAN.
      if (block.ids.length === 1) vlanOf(block.context, block.ids[0]).name ??= textAfter(statement, 1);
    }),
    ignore('exit', 'state ...', 'mtu <bytes>', 'private-vlan ...', 'remote-span', 'media ...'),
  ],
  { ignoreCase: true, abbreviations: true, otherwise: [ignore('no ...')] },
);

interface SviBlock {
  id: number;
  context: Context;
}

const sviRules = new RuleTable<SviBlock>(
  [
    rule('description <text...>', (svi, _m, statement) => {
      const vlan = vlanOf(svi.context, svi.id);
      vlan.alias = textAfter(statement, 1);
      vlan.declared = true;
    }),
    rule('ip address <address> <mask> ...', (svi, m) => {
      const subnet = subnetOf(`${m.address} ${m.mask}`);
      if (subnet === null) return false;
      const vlan = vlanOf(svi.context, svi.id);
      vlan.declared = true;
      // A running configuration lists the secondary addresses before the primary one.
      if (m.rest.toLowerCase().startsWith('secondary')) addOnce(vlan.subnets, subnet);
      else if (!vlan.subnets.includes(subnet)) vlan.subnets.unshift(subnet);
      return undefined;
    }),
    ignore('exit', 'ip address dhcp ...', 'shutdown', 'load-interval <seconds>'),
  ],
  { ignoreCase: true, abbreviations: true, otherwise: [ignore('no ...')] },
);

/** "address ipv4 10.0.0.80 auth-port 1812 acct-port 1813": the number after a keyword. */
function optionAfter(words: string[], keyword: string): number | undefined {
  const index = words.findIndex((word) => word.toLowerCase() === keyword);
  const value = index >= 0 ? words[index + 1] : undefined;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

const radiusServerRules = new RuleTable<RadiusDraft>(
  [
    rule('address <family> <host> ...', (server, m, statement) => {
      server.host = m.host;
      server.authPort = optionAfter(statement.words, 'auth-port') ?? server.authPort;
      server.acctPort = optionAfter(statement.words, 'acct-port') ?? server.acctPort;
    }),
    rule('timeout <seconds>', (server, m) => {
      if (/^\d+$/.test(m.seconds)) server.timeout = Number(m.seconds);
    }),
    ignore('exit', 'key ...', 'pac key ...', 'retransmit <count>', 'automate-tester ...', 'non-standard'),
  ],
  { ignoreCase: true, abbreviations: true },
);

const tacacsServerRules = new RuleTable<TacacsDraft>(
  [
    rule('address <family> <host> ...', (server, m, statement) => {
      server.host = m.host;
      server.port = optionAfter(statement.words, 'port') ?? server.port;
    }),
    rule('port <port>', (server, m) => {
      if (/^\d+$/.test(m.port)) server.port = Number(m.port);
    }),
    ignore('exit', 'key ...', 'timeout <seconds>', 'single-connection'),
  ],
  { ignoreCase: true, abbreviations: true },
);

interface CoaBlock {
  port: number;
}

const dynamicAuthorRules = new RuleTable<CoaBlock>(
  [
    rule('port <port>', (coa, m) => {
      if (/^\d+$/.test(m.port)) coa.port = Number(m.port);
    }),
    ignore('exit', 'client ...', 'server-key ...', 'auth-type ...', 'ignore ...'),
  ],
  { ignoreCase: true, abbreviations: true },
);

/* ------------------------------------------------------------ global rules */

function vlanOf(context: Context, id: number): Vlan {
  let vlan = context.vlans.get(id);
  if (!vlan) {
    vlan = { id, subnets: [], declared: false, dhcpSnooping: false };
    context.vlans.set(id, vlan);
  }
  return vlan;
}

function draftOf(context: Context, name: string, statement: Statement): PortDraft | undefined {
  const read = readCiscoInterface(name);
  if (read.kind === 'svi') return undefined;
  let draft = context.drafts.get(read.name);
  if (!draft) {
    const port = newPort(read.name, read.kind);
    port.junosName = read.junosName;
    if (read.kind === 'lag' && read.number !== undefined) port.aeIndex = read.number - 1;
    draft = { port, line: statement.line, switchport: true, removed: [], bpduGuard: false, dot1x: false, mab: false, portSecurity: false, periodicReauthentication: false, storm: new Map(), stormShutdown: false, unknown: [] };
    context.drafts.set(read.name, draft);
  }
  return draft;
}

/** Runs the commands of a block on what the block configures, and reports those without a rule. */
function readBlock<T>(context: Context, table: RuleTable<T>, target: T, statement: Statement): void {
  for (const child of statement.children) {
    if (table.apply(target, child) === 'unknown') context.report.notConverted(`${commandKey(statement.words, GLOBAL_KEYWORDS)}: ${commandKey(child.words, GLOBAL_KEYWORDS)}`, child.line);
  }
}

function readInterface(context: Context, name: string, statement: Statement): void {
  const read = readCiscoInterface(name);
  if (read.kind === 'svi') {
    if (read.number === undefined || LEGACY_VLANS.includes(read.number) || !isVlanId(String(read.number))) return;
    addOnce(context.sviVlans, read.number);
    readBlock(context, sviRules, { id: read.number, context }, statement);
    return;
  }
  const draft = draftOf(context, name, statement);
  if (!draft) return;
  draft.port.lines.push(...sourceLines(statement));
  // The commands of an interface that is not a switch port have no place in a port usage.
  if (read.kind !== 'physical' && read.kind !== 'lag') return;
  for (const child of statement.children) {
    if (portRules.apply(draft, child) === 'unknown') draft.unknown.push({ command: commandKey(child.words, PORT_KEYWORDS), line: child.line });
  }
}

function addServers(words: string[], add: (address: string) => void): void {
  // "ip name-server vrf Mgmt-vrf 10.0.0.53 10.0.1.53": the name of a VRF is not a server
  for (let index = 0; index < words.length; index++) {
    if (words[index].toLowerCase() === 'vrf') index += 1;
    else if (isIpAddress(words[index])) add(words[index]);
  }
}

/** The server of "ntp server [vrf <name>] [ip] <server> [options]". */
function firstServer(words: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index].toLowerCase();
    if (word === 'vrf') index += 1;
    else if (word !== 'ip' && word !== 'ipv6') return words[index];
  }
  return undefined;
}

function addSyslog(context: Context, words: string[]): void | false {
  const host = firstServer(words);
  if (host === undefined || !isIpAddress(host)) return false;
  const transport = words.findIndex((word) => word.toLowerCase() === 'transport');
  const server = { host, protocol: transport >= 0 ? (words[transport + 1] ?? 'udp').toLowerCase() : 'udp', port: optionAfter(words, 'port') ?? 514 };
  addOnce(context.device.system.syslogServers, server, (a, b) => a.host === b.host && a.port === b.port && a.protocol === b.protocol);
  return undefined;
}

function addRadius(context: Context, server: RadiusDraft): void {
  if (server.host === undefined) return;
  const same = (a: { host: string; port: number }, b: { host: string; port: number }): boolean => a.host === b.host && a.port === b.port;
  // Port 0 turns authentication or accounting off for the server.
  if (server.authPort > 0) addOnce(context.device.system.radius.auth, { host: server.host, port: server.authPort, timeout: server.timeout }, same);
  if (server.acctPort > 0) addOnce(context.device.system.radius.acct, { host: server.host, port: server.acctPort, timeout: server.timeout }, same);
}

function addTacacs(context: Context, server: TacacsDraft): void {
  if (server.host === undefined) return;
  const same = (a: { host: string; port: number }, b: { host: string; port: number }): boolean => a.host === b.host && a.port === b.port;
  addOnce(context.device.system.tacacs.auth, { host: server.host, port: server.port }, same);
  addOnce(context.device.system.tacacs.acct, { host: server.host, port: server.port }, same);
}

const globalRules = new RuleTable<Context>(
  [
    rule('hostname <name>', (context, m) => {
      context.device.hostname = m.name;
    }),

    // Interfaces
    rule('interface range <spec...>', (context, m, statement) => {
      const names = expandCiscoInterfaceRange(m.spec);
      if (!names) return false;
      names.forEach((name) => readInterface(context, name, statement));
      return undefined;
    }),
    rule('interface <name...>', (context, m, statement) => (/^range\b/i.test(m.name) ? false : readInterface(context, m.name, statement))),

    // VLANs
    ignore('vlan internal ...', 'vlan dot1q ...', 'vlan configuration ...', 'vlan group ...', 'vlan access-map ...', 'vlan filter ...'),
    rule('vlan <ids>', (context, m, statement) => {
      const ranges = parseVlanList(m.ids);
      if (!ranges) return false;
      const ids = ranges.flatMap((range) => Array.from({ length: range.to - range.from + 1 }, (_unused, index) => range.from + index)).filter((id) => !LEGACY_VLANS.includes(id));
      ids.forEach((id) => (vlanOf(context, id).declared = true));
      readBlock(context, vlanBlockRules, { ids, context }, statement);
      return undefined;
    }),
    rule('ip dhcp snooping vlan <list>', (context, m) => {
      const ranges = parseVlanList(m.list);
      if (!ranges) return false;
      context.dhcpSnooping.push(...ranges);
      return undefined;
    }),

    // Spanning tree
    rule('spanning-tree portfast default', (context) => {
      context.portfastDefault = true;
    }),
    rule('spanning-tree portfast edge default', (context) => {
      context.portfastDefault = true;
    }),

    // Name resolution, time, logs
    rule('ip name-server ...', (context, _m, statement) => addServers(statement.words.slice(2), (address) => addOnce(context.device.system.dnsServers, address))),
    rule('ip domain name <domain>', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
    rule('ip domain-name <domain>', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
    rule('ip domain list <domain>', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
    rule('ip domain-list <domain>', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
    rule('ntp server ...', (context, _m, statement) => {
      const server = firstServer(statement.words.slice(2));
      if (server === undefined) return false;
      addOnce(context.device.system.ntpServers, server);
      return undefined;
    }),
    rule('logging host ...', (context, _m, statement) => addSyslog(context, statement.words.slice(2))),
    // "logging 10.0.0.60" is the older form of "logging host 10.0.0.60"
    rule('logging <address>', (context, m) => (isIpv4(m.address) ? addSyslog(context, [m.address]) : false)),
    rule('banner <type> ...', (context, m, statement) => {
      if (statement.body !== undefined) context.banners.set(m.type.toLowerCase(), statement.body);
    }),

    // RADIUS and TACACS+
    rule('radius server <name>', (context, _m, statement) => {
      const server: RadiusDraft = { authPort: 1812, acctPort: 1813, timeout: 5 };
      readBlock(context, radiusServerRules, server, statement);
      addRadius(context, server);
    }),
    // The older form, on one line. Its default ports are the ones RADIUS had before 1812 and 1813.
    rule('radius-server host <host> ...', (context, m, statement) => {
      addRadius(context, { host: m.host, authPort: optionAfter(statement.words, 'auth-port') ?? 1645, acctPort: optionAfter(statement.words, 'acct-port') ?? 1646, timeout: optionAfter(statement.words, 'timeout') ?? 5 });
    }),
    rule('tacacs server <name>', (context, _m, statement) => {
      const server: TacacsDraft = { port: 49 };
      readBlock(context, tacacsServerRules, server, statement);
      addTacacs(context, server);
    }),
    rule('tacacs-server host <host> ...', (context, m, statement) => {
      addTacacs(context, { host: m.host, port: optionAfter(statement.words, 'port') ?? 49 });
    }),
    rule('aaa server radius dynamic-author', (context, _m, statement) => {
      // Change of authorization. Cisco listens on port 1700 unless told otherwise.
      const coa: CoaBlock = { port: 1700 };
      readBlock(context, dynamicAuthorRules, coa, statement);
      context.device.system.radius.coaPort = coa.port;
    }),

    // Commands with no place in a Mist template. Anything not listed here is reported.
    ignore(
      'exit',
      'end',
      'enable ...',
      'configure ...',
      'write ...',
      'copy ...',
      'show ...',
      'do ...',
      'terminal ...',
      'version <version>',
      'service ...',
      'boot-start-marker',
      'boot-end-marker',
      'boot ...',
      'username ...',
      'clock ...',
      'switch <member> provision ...',
      'license ...',
      'diagnostic ...',
      'memory ...',
      'redundancy',
      'transceiver ...',
      'call-home',
      'platform ...',
      'archive',
      'file ...',
      'alias ...',
      'line ...',
      'login ...',
      'vtp ...',
      'errdisable ...',
      'lldp ...',
      'cdp ...',
      'udld ...',
      'port-channel load-balance ...',
      'stack-mac ...',
      'mac address-table ...',
      'crypto pki ...',
      'aaa new-model',
      'aaa session-id ...',
      'dot1x system-auth-control',
      'ip http ...',
      'ip ssh ...',
      'ip scp ...',
      'ip tftp ...',
      'ip ftp ...',
      'ip forward-protocol ...',
      'ip default-gateway <address>',
      'ip classless',
      'ip subnet-zero',
      'ip cef ...',
      'ip domain lookup ...',
      'ip domain-lookup ...',
      'ip dhcp snooping',
      'ip dhcp snooping information ...',
      'ip dhcp snooping database ...',
      'ip device tracking ...',
      'device-tracking ...',
      'spanning-tree mode <mode>',
      'spanning-tree extend system-id',
      'spanning-tree portfast bpduguard default',
      'spanning-tree portfast edge bpduguard default',
      'spanning-tree portfast bpdufilter default',
      'spanning-tree portfast edge bpdufilter default',
      'spanning-tree loopguard default',
      'logging ...',
      'ntp ...',
      'vrf definition Mgmt-vrf',
      'control-plane',
    ),
  ],
  { ignoreCase: true, abbreviations: true, otherwise: [ignore('no ...')] },
);

/* ------------------------------------------------- configuration scripts */

interface CommandSet {
  matches(words: string[]): boolean;
}

/** For a command that opens a block, the rules of the commands inside the block. */
function blockRulesOf(statement: Statement): CommandSet | undefined {
  const [first, second] = statement.words.map((word) => word.toLowerCase());
  if (second === undefined) return undefined;
  if (abbreviates(first, 'interface', 3)) return portRules;
  if (first === 'vlan') return parseVlanList(second) ? vlanBlockRules : undefined;
  if (first === 'radius' && second === 'server') return radiusServerRules;
  if (first === 'tacacs' && second === 'server') return tacacsServerRules;
  return undefined;
}

/**
 * A running configuration indents the commands of a block. The commands typed or
 * pasted in configuration mode are often not indented:
 *
 *     interface GigabitEthernet1/0/9
 *     description Printer
 *     switchport access vlan 30
 *     exit
 *
 * As on the device, a command that follows the opening of a block belongs to the
 * block until "exit", a "!" line, or a command that only exists outside the block.
 */
function foldScriptBlocks(statements: Statement[]): Statement[] {
  const folded: Statement[] = [];
  let open: { statement: Statement; rules: CommandSet } | undefined;
  for (const statement of statements) {
    if (open && !statement.separator) {
      const first = statement.words[0].toLowerCase();
      if (first === 'exit') {
        open = undefined;
        continue;
      }
      const known = open.rules.matches(statement.words);
      const outsideOnly = !known && first !== 'no' && globalRules.matches(statement.words);
      // The indented lines that follow a command without indentation were read as its block.
      // When the command is one of the open block, they are commands of that block too.
      const belongs = statement.children.length > 0 ? known : !outsideOnly;
      if (belongs && blockRulesOf(statement) === undefined) {
        open.statement.children.push({ ...statement, children: [] }, ...statement.children);
        continue;
      }
    }
    open = undefined;
    folded.push(statement);
    // A block that has indented commands can still be followed by commands that lost their indentation.
    const rules = statement.separator ? undefined : blockRulesOf(statement);
    if (rules) open = { statement, rules };
  }
  return folded;
}

/* ------------------------------------------------------------- finishing */

/** Turns what was read on a port into a port, once the whole file is read. */
function finishPort(context: Context, draft: PortDraft, knownVlans: number[]): void {
  const port = draft.port;
  const note = (text: string): void => context.report.portNote('warning', 'port-mode', text, draft.line, port.name);

  if (!draft.switchport) {
    port.mode = 'routed';
    return;
  }
  const command = draft.modeCommand ?? 'access';
  const mode = command.split(' ')[0];
  if (abbreviates(mode, 'trunk', 2)) port.mode = 'trunk';
  else if (abbreviates(mode, 'access', 2)) port.mode = 'access';
  else if (abbreviates(mode, 'dynamic', 2)) {
    // The mode is negotiated with the neighbour. The settings of the port say what it was meant for.
    port.mode = draft.accessVlan === undefined && (draft.nativeVlan !== undefined || draft.allowed !== undefined) ? 'trunk' : 'access';
    note(`"switchport mode ${command}" is negotiated with the neighbour: converted as ${port.mode === 'trunk' ? 'a trunk' : 'an access port'}`);
  } else {
    port.mode = 'access';
    note(`"switchport mode ${mode}" has no equivalent: converted as an access port`);
  }

  if (port.mode === 'access') {
    // Without "switchport access vlan", a port is in VLAN 1.
    port.accessVlan = draft.accessVlan ?? 1;
    port.voiceVlan = draft.voiceVlan;
  } else {
    port.nativeVlan = draft.nativeVlan;
    if (draft.allowed === undefined || draft.allowed === 'all') port.allowedVlans = 'all';
    else {
      // The VLAN database of a Cisco switch is often not in the file: a short range is taken as written.
      const allowed = expandVlanRanges(draft.allowed, knownVlans, true);
      const removed = draft.removed.flatMap((range) => (allowed === 'all' ? [] : allowed.filter((id) => id >= range.from && id <= range.to)));
      port.allowedVlans = allowed === 'all' ? 'all' : allowed.filter((id) => !removed.includes(id) && !LEGACY_VLANS.includes(id));
    }
  }

  port.stpEdge = draft.bpduGuard || (draft.portfast ?? (port.mode === 'access' && context.portfastDefault));
  // With a fixed speed and a fixed duplex, the port does not negotiate.
  port.autoneg = port.speed === 'auto' || port.duplex === 'auto';
  port.auth.dot1x = draft.dot1x || draft.mab;
  port.auth.macAuth = draft.mab;
  port.auth.macAuthOnly = draft.mab && !draft.dot1x;
  if (draft.periodicReauthentication) port.auth.reauthInterval = draft.reauthenticationTimer;
  if (draft.portSecurity) port.macLimit = draft.portSecurityMaximum ?? 1;
  port.stormControl = stormControlOf(context, draft);
}

/**
 * A Cisco switch has one level per kind of traffic. Mist has one level for the port and says
 * which kinds of traffic it applies to: the highest level is kept, so that nothing that
 * passed before is dropped.
 */
function stormControlOf(context: Context, draft: PortDraft): StormControl | undefined {
  const note = (code: string, text: string): void => context.report.portNote('warning', code, text, draft.line, draft.port.name);
  const levels = [...draft.storm.entries()].filter((entry): entry is [StormTraffic, number] => entry[1] !== undefined);
  if (levels.length < draft.storm.size) note('storm-control-unit', 'Storm control with a level in bits or packets per second has no equivalent, Mist takes a percentage: left out');
  if (levels.length === 0) return undefined;
  const percentages = levels.map(([, level]) => Math.min(100, Math.max(Math.round(level), level > 0 ? 1 : 0)));
  if (new Set(percentages).size > 1) note('storm-control-levels', 'Storm control has one level per kind of traffic and Mist has one for the port: the highest one is kept');
  const limited = (traffic: StormTraffic): boolean => levels.some(([kind]) => kind === traffic);
  return {
    percentage: Math.max(...percentages),
    broadcast: limited('broadcast'),
    multicast: limited('multicast'),
    registeredMulticast: limited('multicast'),
    unknownUnicast: limited('unicast'),
    shutdown: draft.stormShutdown,
  };
}

/** The VLANs that a port names one by one: they exist on the switch even when nothing else in the file says so. */
function namedVlans(draft: PortDraft): number[] {
  const ids = [draft.accessVlan, draft.voiceVlan, draft.nativeVlan, draft.port.auth.guestVlan, draft.port.auth.serverFailVlan, draft.port.auth.serverRejectVlan].filter((id): id is number => id !== undefined);
  if (Array.isArray(draft.allowed)) {
    const listed = expandVlanRanges(draft.allowed, [], true);
    if (listed !== 'all') ids.push(...listed);
  }
  return ids;
}

/* ------------------------------------------------------------- entry point */

export function extractCiscoIos(file: SourceFile, report: Report): Device {
  const capture = readIosCapture(file.text);
  const context: Context = {
    device: newDevice(file.name, 'cisco-ios'),
    report,
    vlans: new Map(),
    drafts: new Map(),
    portfastDefault: false,
    dhcpSnooping: [],
    sviVlans: [],
    banners: new Map(),
  };

  // The VLAN table comes from the VLAN database of the switch: its names are the names of the VLANs.
  for (const row of capture.vlanTable) {
    if (LEGACY_VLANS.includes(row.id) || !isVlanId(String(row.id))) continue;
    const vlan = vlanOf(context, row.id);
    vlan.declared = true;
    vlan.name ??= row.name;
  }

  for (const statement of foldScriptBlocks(readIndentedBlocks(capture.config))) {
    if (statement.separator) continue;
    if (globalRules.apply(context, statement) === 'unknown') report.notConverted(commandKey(statement.words, GLOBAL_KEYWORDS), statement.line);
  }

  const device = context.device;
  device.hostname ??= capture.promptHostname;
  device.system.banner = context.banners.get('motd') ?? context.banners.get('login');

  // Ports. The VLANs that ports name one by one are known before the lists of allowed VLANs are
  // resolved, so that a wide range ("2-4094") gives the VLANs of this switch, wherever the port is in the file.
  const drafts = [...context.drafts.values()];
  // A member of a link aggregation gets its VLANs from the aggregated interface, when the file has it.
  const configuredLags = new Set(drafts.filter((draft) => draft.port.kind === 'lag').map((draft) => draft.port.name));
  const withOwnVlans = (port: Port): boolean => (port.kind === 'physical' || port.kind === 'lag') && !(port.lag && configuredLags.has(port.lag.name));
  const known = [...new Set([...context.vlans.keys(), ...context.sviVlans, ...drafts.filter((draft) => withOwnVlans(draft.port)).flatMap(namedVlans)])];
  const ports: Port[] = [];
  for (const draft of drafts) {
    const port = draft.port;
    const reason = NOT_A_SWITCH_PORT[port.kind];
    if (reason !== undefined) {
      report.info('interface-skipped', `Interface ${port.name}: ${reason}, not converted`, [draft.line]);
      continue;
    }
    finishPort(context, draft, known);
    if (port.mode === 'routed') {
      report.warning('routed-port', `Interface ${port.name}: routed port ("no switchport"), not converted`, [draft.line]);
      continue;
    }
    if (port.kind === 'physical' && port.junosName === undefined) {
      report.warning('port-name', `Interface ${port.name}: the position of the port cannot be translated, not converted`, [draft.line]);
      continue;
    }
    ports.push(port);
    draft.unknown.forEach((entry) => report.portSettingNotConverted(entry.command, entry.line, port.name));
  }
  for (const lag of ports.filter((port) => port.kind === 'lag')) {
    const members = ports.filter((port) => port.lag?.name === lag.name);
    lag.lacp = members.length === 0 || members.some((member) => member.lag?.lacp);
  }
  // Port-channel1 is ae0 on a Juniper switch.
  device.ports = addMissingLags(ports, (name) => Number(/\d+$/.exec(name)?.[0] ?? 1) - 1, report);
  // The VLANs that ports refer to exist, even when nothing else in the file declares them.
  for (const port of device.ports) if (!port.lag) referencedVlans(port).forEach((id) => vlanOf(context, id));

  // DHCP snooping is enabled on the listed VLANs that the switch has.
  const snooping = expandVlanRanges(context.dhcpSnooping, [...context.vlans.keys()], false);
  for (const vlan of context.vlans.values()) vlan.dhcpSnooping = snooping === 'all' || snooping.includes(vlan.id);
  // A link aggregation is trusted when the file says so on the aggregation or on one of its members.
  for (const lag of device.ports.filter((port) => port.kind === 'lag')) {
    if (device.ports.some((port) => port.lag?.name === lag.name && port.dhcpTrusted)) lag.dhcpTrusted = true;
  }
  // With DHCP snooping, a Cisco switch trusts a trunk only when the trunk says so. A Juniper switch trusts every trunk.
  if (context.dhcpSnooping.length > 0) {
    for (const port of device.ports) {
      if (port.mode !== 'trunk' || port.lag || port.dhcpTrusted !== undefined) continue;
      port.dhcpTrusted = false;
      const line = context.drafts.get(port.name)?.line ?? 0;
      report.portNote('warning', 'dhcp-untrusted-trunk', 'DHCP snooping: the trunk has no "ip dhcp snooping trust", DHCP servers are refused on it', line, port.name);
    }
  }

  device.vlans = [...context.vlans.values()];
  report.flush();
  return device;
}
