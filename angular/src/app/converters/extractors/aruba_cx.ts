/**
 * Extractor for Aruba AOS-CX: reads the output of "show running-config" and returns
 * what it says as a vendor-neutral `Device`.
 *
 * The commands the extractor understands are in the rule tables below, one line per
 * command. A command without a rule is reported as not converted.
 *
 * An AOS-CX configuration is made of indented blocks, and a block can hold another one:
 *
 *     interface 1/1/1
 *         no shutdown
 *         no routing
 *         vlan access 10
 *         aaa authentication port-access dot1x authenticator
 *             enable
 */
import { addOnce, Device, newDevice, newPort, newSnmp, Port, SourceFile, Speed, Vlan } from '../model';
import { commandKey, Report } from '../report';
import { readIndentedBlocks } from '../readers/indented_blocks';
import { readIosCapture } from '../readers/ios_capture';
import { sourceLines, Statement, textAfter } from '../readers/statement';
import { expandArubaInterfaceRange, readArubaInterface } from './aruba_cx_interfaces';
import { ArubaSnmp, arubaSnmpServerRules, arubaSnmpv3Rules, finishArubaSnmp, newArubaSnmp, readArubaSnmp } from './aruba_cx_snmp';
import { addMissingLags, NOT_A_SWITCH_PORT, referencedVlans, stormControlOf, StormTraffic } from './common';
import { ignore, rule, RuleTable } from './rules';
import { expandVlanRanges, isIpAddress, isVlanId, parseVlanList, subnetOf, VlanRange } from './values';

/** After these keywords comes another keyword, so two words name the command in a report. */
const GLOBAL_KEYWORDS = new Set(['aaa', 'ip', 'ipv6', 'port-access', 'radius', 'router', 'snmp-server', 'snmpv3']);
const PORT_KEYWORDS = new Set(['aaa', 'apply', 'arp', 'ip', 'ipv6', 'port-access', 'qos', 'spanning-tree', 'vlan']);
const NO_KEYWORDS: ReadonlySet<string> = new Set();

const STORM_TRAFFIC: Record<string, StormTraffic> = { broadcast: 'broadcast', multicast: 'multicast', 'unknown-unicast': 'unicast' };
const SPEEDS: Record<string, Speed> = { '10': '10m', '100': '100m', '1000': '1g', '10m': '10m', '100m': '100m', '1g': '1g', '2.5g': '2.5g', '5g': '5g', '10g': '10g', '25g': '25g', '40g': '40g', '100g': '100g' };

/** The ports that AOS-CX uses when the configuration names none. */
const RADIUS_AUTH_PORT = 1812;
const RADIUS_ACCT_PORT = 1813;
const RADIUS_TIMEOUT = 5;
const TACACS_PORT = 49;
const COA_PORT = 3799;
const SYSLOG_PORTS: Record<string, number> = { udp: 514, tcp: 1470, tls: 6514 };

/* ------------------------------------------------------------ what is read */

/** 802.1X or MAC authentication of a port: the lines under "aaa authentication port-access dot1x authenticator" or "... mac-auth". */
interface AuthMethod {
  enabled: boolean;
  reauth: boolean;
  reauthPeriod?: number;
  /** Clients that were authenticated before are let in again while no RADIUS server answers. */
  cachedReauth: boolean;
}

interface PortSecurity {
  enabled: boolean;
  clientLimit?: number;
  sticky: boolean;
}

/** A port while its commands are read. `finishPort` turns it into a `Port`. */
interface PortDraft {
  port: Port;
  line: number;
  /** True after "routing", false after "no routing", undefined when the port says neither. */
  routing?: boolean;
  /** The port has an address of its own: it is a routed port, whatever the model of the switch. */
  hasAddress: boolean;
  /** True after "shutdown", false after "no shutdown", undefined when the port says neither. */
  shutdown?: boolean;
  accessVlan?: number;
  nativeVlan?: number;
  /** "vlan trunk native <id> tag": the native VLAN is sent with its tag. */
  nativeTagged: boolean;
  /** "vlan trunk allowed": undefined without the command. */
  allowed?: VlanRange[] | 'all';
  /** "spanning-tree port-type": true for admin-edge, false for admin-network. */
  adminEdge?: boolean;
  bpduGuard: boolean;
  dot1x: AuthMethod;
  macAuth: AuthMethod;
  /** "aaa authentication port-access auth-mode": client-mode when the port does not say. */
  authMode?: string;
  clientLimit?: number;
  criticalRole?: string;
  rejectRole?: string;
  portSecurity: PortSecurity;
  /** "rate-limit <traffic> <rate> <unit>": the rate in percent, or undefined when it is in kbps or pps. */
  storm: Map<StormTraffic, number | undefined>;
  /** On a link aggregation: what follows "lacp mode". */
  lacpMode?: string;
  /** Commands of the port without a rule. They are reported when the port is converted. */
  unknown: Array<{ command: string; line: number }>;
}

/** A role of "port-access role": only the VLAN it gives is read. */
interface Role {
  vlan?: number;
  vlanName?: string;
}

interface RadiusDraft {
  host: string;
  authPort: number;
  acctPort: number;
  timeout?: number;
}

interface Context {
  device: Device;
  report: Report;
  vlans: Map<number, Vlan>;
  drafts: Map<string, PortDraft>;
  snmp: ArubaSnmp;
  roles: Map<string, Role>;
  /** "dhcpv4-snooping": DHCP snooping is turned on for the switch. Each VLAN then says whether it is snooped. */
  dhcpSnooping: boolean;
  snoopedVlans: number[];
  /** The VLANs marked "voice": the switch announces them to the phones. */
  voiceVlans: number[];
  /** VLANs that have a VLAN interface. */
  sviVlans: number[];
  /** The ports that link the members of a stack (VSF). */
  vsfLinks: Set<string>;
  radius: RadiusDraft[];
  /** "radius-server timeout": the timeout of the servers that have none of their own. */
  radiusTimeout?: number;
  coaEnabled: boolean;
  coaPort?: number;
  banners: Map<string, string>;
}

function newAuthMethod(): AuthMethod {
  return { enabled: false, reauth: false, cachedReauth: false };
}

/* -------------------------------------------------------------- port rules */

function vlanId(text: string): number | undefined {
  return isVlanId(text) ? Number(text) : undefined;
}

function count(text: string): number | undefined {
  return /^\d+$/.test(text) ? Number(text) : undefined;
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

/** The lines of a nested block. Its settings can also follow its name on the same line. */
function nestedLines(statement: Statement, nameLength: number): Statement[] {
  const rest = statement.words.slice(nameLength);
  return rest.length > 0 ? [{ words: rest, text: rest.join(' '), line: statement.line, children: [] }, ...statement.children] : statement.children;
}

/** Runs the lines of a block that is nested in an interface, and keeps those without a rule for the report. */
function readNested<T>(draft: PortDraft, label: string, table: RuleTable<T>, target: T, lines: Statement[]): void {
  for (const line of lines) {
    if (table.apply(target, line) === 'unknown') draft.unknown.push({ command: `${label}: ${commandKey(line.words, NO_KEYWORDS)}`, line: line.line });
  }
}

const authMethodRules = new RuleTable<AuthMethod>(
  [
    rule('enable', (method) => {
      method.enabled = true;
    }),
    rule('disable', (method) => {
      method.enabled = false;
    }),
    rule('reauth', (method) => {
      method.reauth = true;
    }),
    rule('reauth-period <seconds>', (method, m) => {
      if (count(m.seconds) === undefined) return false;
      method.reauthPeriod = count(m.seconds);
      return undefined;
    }),
    rule('cached-reauth', (method) => {
      method.cachedReauth = true;
    }),
    // Timers and retries: Mist has its own
    ignore('cached-reauth-period <seconds>', 'eapol-timeout <seconds>', 'max-eapol-requests <count>', 'max-retries <count>', 'quiet-period <seconds>', 'discovery-period <seconds>', 'initial-auth-response-timeout <seconds>', 'radius server-group <name>', 'auth-method <method>'),
  ],
  { otherwise: [ignore('no ...')] },
);

const portSecurityRules = new RuleTable<PortSecurity>(
  [
    rule('enable', (security) => {
      security.enabled = true;
    }),
    rule('disable', (security) => {
      security.enabled = false;
    }),
    rule('client-limit <count>', (security, m) => {
      if (count(m.count) === undefined) return false;
      security.clientLimit = count(m.count);
      return undefined;
    }),
    rule('sticky-learn enable', (security) => {
      security.sticky = true;
    }),
    // The addresses that are allowed belong to one port of one switch
    ignore('mac-address ...'),
  ],
  { otherwise: [ignore('no ...')] },
);

const portRules = new RuleTable<PortDraft>(
  [
    rule('description <text...>', (draft, _m, statement) => {
      draft.port.description = textAfter(statement, 1);
    }),
    rule('shutdown', (draft) => {
      draft.shutdown = true;
    }),
    rule('no shutdown', (draft) => {
      draft.shutdown = false;
    }),

    // Layer 2
    rule('routing', (draft) => {
      draft.routing = true;
    }),
    rule('no routing', (draft) => {
      draft.routing = false;
    }),
    rule('ip address ...', (draft) => {
      draft.hasAddress = true;
    }),
    rule('vlan access <id>', withVlan((draft, id) => (draft.accessVlan = id))),
    rule('vlan trunk native <id>', withVlan((draft, id) => (draft.nativeVlan = id))),
    rule('vlan trunk native <id> tag', withVlan((draft, id) => {
      draft.nativeVlan = id;
      draft.nativeTagged = true;
    })),
    rule('vlan trunk allowed all', (draft) => {
      draft.allowed = 'all';
    }),
    rule('vlan trunk allowed <list>', (draft, m) => {
      const ranges = parseVlanList(m.list);
      if (!ranges) return false;
      // On the switch, the command adds to the VLANs that the trunk already allows.
      if (draft.allowed !== 'all') draft.allowed = [...(draft.allowed ?? []), ...ranges];
      return undefined;
    }),
    rule('lag <id>', (draft, m) => {
      if (count(m.id) === undefined) return false;
      // Whether the aggregation runs LACP is said on the aggregated interface: see `extractArubaCx`.
      draft.port.lag = { name: `lag${m.id}`, lacp: false };
      return undefined;
    }),
    rule('lacp mode <mode>', (draft, m) => {
      draft.lacpMode = m.mode;
    }),

    // Physical layer
    rule('speed <speed...>', (draft, m) => readSpeed(draft, m.speed.split(' '))),
    rule('mtu <bytes>', (draft, m) => {
      if (count(m.bytes) === undefined) return false;
      draft.port.mtu = count(m.bytes);
      return undefined;
    }),
    rule('no power-over-ethernet', (draft) => {
      draft.port.poe = false;
    }),
    rule('qos trust <mode>', (draft, m) => {
      draft.port.qos = m.mode !== 'none';
    }),

    // Spanning tree
    rule('spanning-tree port-type <type>', (draft, m) => {
      if (m.type !== 'admin-edge' && m.type !== 'admin-network') return false;
      draft.adminEdge = m.type === 'admin-edge';
      return undefined;
    }),
    // A port with BPDU guard is converted as an edge port: this is the Mist setting that
    // disables a port when it receives a BPDU.
    rule('spanning-tree bpdu-guard', (draft) => {
      draft.bpduGuard = true;
    }),

    // 802.1X and MAC authentication
    rule('aaa authentication port-access dot1x authenticator ...', (draft, _m, statement) => readNested(draft, 'dot1x authenticator', authMethodRules, draft.dot1x, nestedLines(statement, 5))),
    rule('aaa authentication port-access mac-auth ...', (draft, _m, statement) => readNested(draft, 'mac-auth', authMethodRules, draft.macAuth, nestedLines(statement, 4))),
    rule('aaa authentication port-access auth-mode <mode>', (draft, m) => {
      draft.authMode = m.mode;
    }),
    rule('aaa authentication port-access client-limit <count>', (draft, m) => {
      if (count(m.count) === undefined) return false;
      draft.clientLimit = count(m.count);
      return undefined;
    }),
    rule('aaa authentication port-access critical-role <role>', (draft, m) => {
      draft.criticalRole = m.role;
    }),
    rule('aaa authentication port-access reject-role <role>', (draft, m) => {
      draft.rejectRole = m.role;
    }),

    // Port security
    rule('port-access port-security ...', (draft, _m, statement) => readNested(draft, 'port-security', portSecurityRules, draft.portSecurity, nestedLines(statement, 2))),

    // Storm control and DHCP snooping
    rule('rate-limit <traffic> <rate> <unit>', (draft, m) => {
      const traffic = STORM_TRAFFIC[m.traffic];
      if (traffic === undefined || !/^\d+$/.test(m.rate) || !['percent', 'kbps', 'pps'].includes(m.unit)) return false;
      draft.storm.set(traffic, m.unit === 'percent' ? Number(m.rate) : undefined);
      return undefined;
    }),
    rule('dhcpv4-snooping trust', (draft) => {
      draft.port.dhcpTrusted = true;
    }),

    ignore(
      'exit',
      'lacp ...',
      'loop-protect ...',
      'lldp ...',
      'cdp ...',
      'flow-control ...',
      'energy-efficient-ethernet',
      'power-over-ethernet ...',
      'arp inspection trust',
      'spanning-tree bpdu-filter',
      'spanning-tree root-guard',
      'spanning-tree tcn-guard',
      'spanning-tree loop-guard',
      'spanning-tree link-type ...',
      'spanning-tree cost ...',
      'spanning-tree port-priority ...',
      'client track ip ...',
      // Settings of 802.1X whose Mist equivalent is the port usage itself or its defaults
      'aaa authentication port-access auth-precedence ...',
      'aaa authentication port-access auth-priority ...',
      'port-access onboarding-method ...',
      'port-access allow-flood-traffic ...',
    ),
  ],
  // "no <command>" turns a setting off: apart from the ones above, that is the state a port usage starts from.
  { otherwise: [ignore('no ...')] },
);

/**
 * "speed auto", "speed auto 1g", "speed 1000-full", "speed 10g".
 * A port that advertises several speeds has no equivalent: it stays on auto, and the report says so.
 */
function readSpeed(draft: PortDraft, words: string[]): void | false {
  const port = draft.port;
  if (words[0] === 'auto') {
    const speeds = words.slice(1).map((word) => SPEEDS[word]);
    if (speeds.includes(undefined as unknown as Speed)) return false;
    port.speed = speeds.length === 1 ? speeds[0] : 'auto';
    port.duplex = 'auto';
    if (speeds.length > 1) draft.unknown.push({ command: 'speed auto, with a list of speeds', line: draft.line });
    return undefined;
  }
  const fixed = /^(\d+)-(full|half)$/.exec(words[0] ?? '');
  const speed = SPEEDS[fixed ? fixed[1] : (words[0] ?? '')];
  if (speed === undefined || words.length !== 1) return false;
  port.speed = speed;
  port.duplex = fixed ? (fixed[2] as 'full' | 'half') : 'auto';
  return undefined;
}

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
    rule('description <text...>', (block, _m, statement) => {
      if (block.ids.length === 1) vlanOf(block.context, block.ids[0]).alias ??= textAfter(statement, 1);
    }),
    rule('voice', (block) => {
      block.ids.forEach((id) => addOnce(block.context.voiceVlans, id));
    }),
    rule('dhcpv4-snooping', (block) => {
      block.ids.forEach((id) => addOnce(block.context.snoopedVlans, id));
    }),
    ignore('exit', 'shutdown', 'vsx-sync', 'arp inspection', 'ip igmp ...', 'ipv6 mld ...', 'nd-snooping ...', 'dhcpv6-snooping', 'dhcpv4-snooping ...'),
  ],
  { otherwise: [ignore('no ...')] },
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
    rule('ip address <address> ...', (svi, m) => {
      const subnet = subnetOf(m.address);
      if (subnet === null) return false;
      const vlan = vlanOf(svi.context, svi.id);
      vlan.declared = true;
      if (m.rest.startsWith('secondary')) addOnce(vlan.subnets, subnet);
      else if (!vlan.subnets.includes(subnet)) vlan.subnets.unshift(subnet);
      return undefined;
    }),
    ignore('exit', 'shutdown', 'ip dhcp', 'ip mtu <bytes>', 'ip helper-address ...', 'vrf attach <name>', 'l3-counters ...'),
  ],
  { otherwise: [ignore('no ...')] },
);

/** A role gives many things to the clients that get it. Its VLAN is what a port usage can say. */
const roleRules = new RuleTable<Role>(
  [
    rule('vlan access name <name...>', (role, m) => {
      role.vlanName = m.name;
    }),
    rule('vlan access <id>', (role, m) => {
      if (vlanId(m.id) === undefined) return false;
      role.vlan = vlanId(m.id);
      return undefined;
    }),
  ],
  { otherwise: [ignore('...')] },
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

/** The part of a command that is safe to show. "aaa authentication port-access <setting>" is named by its setting. */
function keyOf(words: string[], keywords: ReadonlySet<string>): string {
  if (words.length >= 4 && words.slice(0, 3).join(' ') === 'aaa authentication port-access' && /^[a-z][a-z0-9-]*$/.test(words[3])) return words.slice(0, 4).join(' ');
  return commandKey(words, keywords);
}

/** Runs the commands of a block on what the block configures, and reports those without a rule. */
function readBlock<T>(context: Context, table: RuleTable<T>, target: T, statement: Statement): void {
  for (const child of statement.children) {
    if (table.apply(target, child) === 'unknown') context.report.notConverted(`${keyOf(statement.words, GLOBAL_KEYWORDS)}: ${keyOf(child.words, GLOBAL_KEYWORDS)}`, child.line);
  }
}

function readInterface(context: Context, name: string, statement: Statement): void {
  const read = readArubaInterface(name);
  if (read.kind === 'svi') {
    if (read.number === undefined || !isVlanId(String(read.number))) return;
    addOnce(context.sviVlans, read.number);
    readBlock(context, sviRules, { id: read.number, context }, statement);
    return;
  }
  let draft = context.drafts.get(read.name);
  if (!draft) {
    const port = newPort(read.name, read.kind);
    port.junosName = read.junosName;
    // lag 1 is ae0 on a Juniper switch.
    if (read.kind === 'lag' && read.number !== undefined) port.aeIndex = read.number - 1;
    draft = { port, line: statement.line, hasAddress: false, nativeTagged: false, bpduGuard: false, dot1x: newAuthMethod(), macAuth: newAuthMethod(), portSecurity: { enabled: false, sticky: false }, storm: new Map(), unknown: [] };
    context.drafts.set(read.name, draft);
  }
  draft.port.lines.push(...sourceLines(statement));
  // The commands of an interface that is not a switch port have no place in a port usage.
  if (read.kind !== 'physical' && read.kind !== 'lag') return;
  for (const child of statement.children) {
    if (portRules.apply(draft, child) === 'unknown') draft.unknown.push({ command: keyOf(child.words, PORT_KEYWORDS), line: child.line });
  }
}

/**
 * The options of a server line: "radius-server host 10.0.0.80 key ciphertext <key> timeout 5 port 1812 vrf mgmt".
 * The key is skipped, so that a key that reads like a keyword is not taken for one.
 */
function serverOptions(words: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === 'key') index += ['plaintext', 'ciphertext'].includes(words[index + 1] ?? '') ? 2 : 1;
    else if (index + 1 < words.length) options.set(word, words[++index]);
  }
  return options;
}

function numberOption(options: Map<string, string>, name: string): number | undefined {
  return count(options.get(name) ?? '');
}

/** "logging <host> [udp | tcp | tls [<port>]] [severity <level>] [vrf <name>]". */
function addSyslog(context: Context, host: string, words: string[]): void | false {
  // The other commands that start with "logging" are followed by a keyword.
  if (!isIpAddress(host) && !host.includes('.')) return false;
  const transport = words.findIndex((word) => word in SYSLOG_PORTS);
  const protocol = transport >= 0 ? words[transport] : 'udp';
  const server = { host, protocol, port: count(words[transport + 1] ?? '') ?? SYSLOG_PORTS[protocol] };
  addOnce(context.device.system.syslogServers, server, (a, b) => a.host === b.host && a.port === b.port && a.protocol === b.protocol);
  return undefined;
}

const globalRules = new RuleTable<Context>(
  [
    rule('hostname <name>', (context, m) => {
      context.device.hostname = m.name;
    }),
    rule('banner <type> ...', (context, m, statement) => {
      if (statement.body !== undefined) context.banners.set(m.type, statement.body);
    }),

    // SNMP has its own tables of rules.
    rule('snmp-server ...', (context, _m, statement) => {
      context.device.system.snmp = context.snmp.snmp;
      return readArubaSnmp(context.snmp, arubaSnmpServerRules, statement);
    }),
    rule('snmpv3 ...', (context, _m, statement) => {
      context.device.system.snmp = context.snmp.snmp;
      return readArubaSnmp(context.snmp, arubaSnmpv3Rules, statement);
    }),

    // Interfaces. A script can name several ports on one line.
    rule('interface <name...>', (context, m, statement) => {
      (expandArubaInterfaceRange(m.name) ?? [m.name]).forEach((name) => readInterface(context, name, statement));
    }),

    // VLANs
    rule('vlan <ids>', (context, m, statement) => {
      const ranges = parseVlanList(m.ids);
      if (!ranges) return false;
      const ids = ranges.flatMap((range) => Array.from({ length: range.to - range.from + 1 }, (_unused, index) => range.from + index));
      ids.forEach((id) => (vlanOf(context, id).declared = true));
      readBlock(context, vlanBlockRules, { ids, context }, statement);
      return undefined;
    }),
    rule('dhcpv4-snooping', (context) => {
      context.dhcpSnooping = true;
    }),

    // The roles that 802.1X gives to the clients, and the links of a stack
    rule('port-access role <name>', (context, m, statement) => {
      const role: Role = context.roles.get(m.name) ?? {};
      context.roles.set(m.name, role);
      statement.children.forEach((child) => roleRules.apply(role, child));
    }),
    rule('vsf member <id>', (context, _m, statement) => {
      for (const child of statement.children) {
        // "link 1 1/1/25", "link 1 1/1/25,1/1/26"
        if (child.words[0] === 'link' && child.words[2] !== undefined) (expandArubaInterfaceRange(child.words[2]) ?? [child.words[2]]).forEach((name) => context.vsfLinks.add(name));
      }
    }),

    // Name resolution, time, logs
    rule('ip dns server-address <address> ...', (context, m) => (isIpAddress(m.address) ? addOnce(context.device.system.dnsServers, m.address) : false)),
    rule('ip dns domain-name <domain> ...', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
    rule('ip dns domain-list <domain> ...', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
    rule('ntp server <server> ...', (context, m) => addOnce(context.device.system.ntpServers, m.server)),
    rule('logging <host> ...', (context, m) => addSyslog(context, m.host, m.rest === '' ? [] : m.rest.split(' '))),

    // RADIUS and TACACS+
    rule('radius-server host <host> ...', (context, m) => {
      const options = serverOptions(m.rest === '' ? [] : m.rest.split(' '));
      context.radius.push({ host: m.host, authPort: numberOption(options, 'port') ?? RADIUS_AUTH_PORT, acctPort: numberOption(options, 'acct-port') ?? RADIUS_ACCT_PORT, timeout: numberOption(options, 'timeout') });
    }),
    rule('radius-server timeout <seconds>', (context, m) => {
      if (count(m.seconds) === undefined) return false;
      context.radiusTimeout = count(m.seconds);
      return undefined;
    }),
    rule('tacacs-server host <host> ...', (context, m) => {
      const options = serverOptions(m.rest === '' ? [] : m.rest.split(' '));
      const server = { host: m.host, port: numberOption(options, 'port') ?? TACACS_PORT };
      const same = (a: { host: string; port: number }, b: { host: string; port: number }): boolean => a.host === b.host && a.port === b.port;
      addOnce(context.device.system.tacacs.auth, server, same);
      addOnce(context.device.system.tacacs.acct, { ...server }, same);
    }),
    rule('radius dyn-authorization enable', (context) => {
      context.coaEnabled = true;
    }),
    rule('radius dyn-authorization port <port>', (context, m) => {
      if (count(m.port) === undefined) return false;
      context.coaPort = count(m.port);
      return undefined;
    }),

    // Commands with no place in a Mist template. Anything not listed here is reported.
    ignore(
      'exit',
      'end',
      'configure ...',
      'show ...',
      'write ...',
      'copy ...',
      'user ...',
      'ssh ...',
      'https-server ...',
      'clock ...',
      'cli-session',
      'session-timeout <minutes>',
      'ntp ...',
      'logging ...',
      'vsf ...',
      'lldp ...',
      'cdp ...',
      'spanning-tree ...',
      'loop-protect ...',
      'dhcpv4-snooping ...',
      'client track ip ...',
      'radius-server ...',
      'tacacs-server ...',
      'radius dyn-authorization ...',
      // The groups of servers, and 802.1X and MAC authentication turned on for the switch
      'aaa group server ...',
      'aaa accounting port-access ...',
      'aaa authentication port-access dot1x authenticator',
      'aaa authentication port-access mac-auth',
    ),
  ],
  { otherwise: [ignore('no ...')] },
);

/* ------------------------------------------------------------- finishing */

/** The VLAN that a role gives, by its id or by its name. */
function vlanOfRole(context: Context, name: string): number | undefined {
  const role = context.roles.get(name);
  if (role?.vlan !== undefined) return role.vlan;
  if (role?.vlanName === undefined) return undefined;
  return [...context.vlans.values()].find((vlan) => vlan.name === role.vlanName)?.id;
}

/** What a port is when its block does not say, and how its ranges of VLANs are read. See `extractArubaCx`. */
interface Defaults {
  routed: boolean;
  shutdown: boolean;
  rangesAsWritten: boolean;
}

/** Turns what was read on a port into a port, once the whole file is read. */
function finishPort(context: Context, draft: PortDraft, knownVlans: number[], defaults: Defaults): void {
  const port = draft.port;
  const note = (severity: 'info' | 'warning', code: string, text: string): void => context.report.portNote(severity, code, text, draft.line, port.name);

  // A port that says nothing is what the model of the switch makes it. A port with a VLAN is a switch port.
  const layer2 = draft.accessVlan !== undefined || draft.nativeVlan !== undefined || draft.allowed !== undefined || port.lag !== undefined;
  if (draft.routing ?? (draft.hasAddress || (!layer2 && defaults.routed))) {
    port.mode = 'routed';
    return;
  }
  port.disabled = draft.shutdown ?? defaults.shutdown;

  if (draft.nativeVlan === undefined && draft.allowed === undefined) {
    // Without "vlan access", a port is in VLAN 1.
    port.mode = 'access';
    port.accessVlan = draft.accessVlan ?? 1;
  } else {
    port.mode = 'trunk';
    const allowed = draft.allowed === undefined || draft.allowed === 'all' ? 'all' : expandVlanRanges(draft.allowed, knownVlans, defaults.rangesAsWritten);
    if (draft.nativeTagged) {
      // Nothing leaves the port without a tag: the native VLAN is one more VLAN of the trunk.
      port.allowedVlans = allowed === 'all' || draft.nativeVlan === undefined || allowed.includes(draft.nativeVlan) ? allowed : [draft.nativeVlan, ...allowed];
    } else {
      port.nativeVlan = draft.nativeVlan;
      port.allowedVlans = allowed;
    }
    // AOS-CX has no voice VLAN on a port: a port for a phone and a computer is a trunk with the
    // VLAN of the computer as its native VLAN and a VLAN marked "voice".
    const tagged = port.allowedVlans === 'all' ? [] : port.allowedVlans.filter((id) => id !== port.nativeVlan);
    if (port.nativeVlan !== undefined && port.allowedVlans !== 'all' && tagged.length === 1 && context.voiceVlans.includes(tagged[0])) {
      port.mode = 'access';
      port.accessVlan = port.nativeVlan;
      port.voiceVlan = tagged[0];
      port.nativeVlan = undefined;
      port.allowedVlans = [];
      note('info', 'voice-vlan', 'A trunk with a native VLAN and one VLAN marked "voice" is a port for a phone and a computer: converted as an access port with a voice VLAN');
    }
  }

  port.stpEdge = draft.bpduGuard || (draft.adminEdge ?? false);
  // With a fixed speed and a fixed duplex, the port does not negotiate.
  port.autoneg = port.speed === 'auto' || port.duplex === 'auto';

  const dot1x = draft.dot1x.enabled;
  const macAuth = draft.macAuth.enabled;
  const auth = port.auth;
  auth.dot1x = dot1x || macAuth;
  auth.macAuth = macAuth;
  auth.macAuthOnly = macAuth && !dot1x;
  if (auth.dot1x) {
    // In client mode every client authenticates, up to the limit of the port. In device mode the first one opens the port.
    auth.multipleSupplicants = draft.authMode === 'multi-domain' || (draft.authMode !== 'device-mode' && (draft.clientLimit ?? 1) > 1);
    const method = dot1x ? draft.dot1x : draft.macAuth;
    if (method.reauth) auth.reauthInterval = method.reauthPeriod;
    auth.bypassWhenServerDown = (dot1x && draft.dot1x.cachedReauth) || (macAuth && draft.macAuth.cachedReauth);
    if (draft.criticalRole !== undefined) {
      // The role of the clients that arrive while no RADIUS server answers
      auth.serverFailVlan = vlanOfRole(context, draft.criticalRole);
      if (auth.serverFailVlan === undefined) {
        auth.permitWhenServerDown = true;
        if (!context.roles.has(draft.criticalRole)) note('warning', 'role-unknown', 'The role of "critical-role" is not in the file: while no RADIUS server answers, the clients are let in on the VLAN of the port');
      }
    }
    if (draft.rejectRole !== undefined) {
      auth.serverRejectVlan = vlanOfRole(context, draft.rejectRole);
      if (auth.serverRejectVlan === undefined) note('warning', 'role-without-vlan', 'The role of "reject-role" gives no VLAN that the file names: the clients that the RADIUS server rejects stay out');
    }
  }
  if (draft.portSecurity.enabled) {
    port.macLimit = draft.portSecurity.clientLimit ?? 1;
    port.persistMac = draft.portSecurity.sticky;
  }
  // The limit of multicast also holds the broadcast back.
  if (draft.storm.has('multicast') && !draft.storm.has('broadcast')) draft.storm.set('broadcast', draft.storm.get('multicast'));
  port.stormControl = stormControlOf(draft.storm, false, (code, text) => note('warning', code, text));
}

/** The VLANs that a port names one by one, and those of its ranges when ranges are taken as written. */
function namedVlans(draft: PortDraft, rangesAsWritten: boolean): number[] {
  const ids = [draft.accessVlan, draft.nativeVlan].filter((id): id is number => id !== undefined);
  if (Array.isArray(draft.allowed)) {
    const listed = expandVlanRanges(draft.allowed, [], rangesAsWritten);
    if (listed !== 'all') ids.push(...listed);
  }
  return ids;
}

/* ------------------------------------------------------------- entry point */

export function extractArubaCx(file: SourceFile, report: Report): Device {
  // A capture of an AOS-CX terminal has the prompts and the header of a Cisco IOS one.
  const capture = readIosCapture(file.text);
  const context: Context = {
    device: newDevice(file.name, 'aruba-cx'),
    report,
    vlans: new Map(),
    drafts: new Map(),
    snmp: newArubaSnmp(newSnmp(), report),
    roles: new Map(),
    dhcpSnooping: false,
    snoopedVlans: [],
    voiceVlans: [],
    sviVlans: [],
    vsfLinks: new Set(),
    radius: [],
    coaEnabled: false,
    banners: new Map(),
  };

  // The settings of an interface that are found outside an interface: the file lost its indentation.
  const outOfBlock: number[] = [];
  for (const statement of readIndentedBlocks(capture.config)) {
    if (statement.separator) continue;
    if (globalRules.apply(context, statement) !== 'unknown') continue;
    if (portRules.matches(statement.words)) outOfBlock.push(statement.line);
    else report.notConverted(keyOf(statement.words, GLOBAL_KEYWORDS), statement.line);
  }
  if (outOfBlock.length > 0) {
    report.warning('not-indented', 'Settings of an interface are written outside an interface and are not read. The converter needs the lines of each block indented, as "show running-config" prints them', outOfBlock);
  }

  const device = context.device;
  const system = device.system;
  device.hostname ??= capture.promptHostname;
  system.banner = context.banners.get('motd') ?? context.banners.get('exec');
  const sameServer = (a: { host: string; port: number }, b: { host: string; port: number }): boolean => a.host === b.host && a.port === b.port;
  for (const server of context.radius) {
    const timeout = server.timeout ?? context.radiusTimeout ?? RADIUS_TIMEOUT;
    addOnce(system.radius.auth, { host: server.host, port: server.authPort, timeout }, sameServer);
    addOnce(system.radius.acct, { host: server.host, port: server.acctPort, timeout }, sameServer);
  }
  if (context.coaEnabled) system.radius.coaPort = context.coaPort ?? COA_PORT;
  if (context.roles.size > 0) {
    report.info('roles', `The file has ${context.roles.size} port-access role${context.roles.size === 1 ? '' : 's'}. Roles are not converted: they are read for the VLAN of "critical-role" and "reject-role"`);
  }

  // What a port that says nothing is depends on the model of the switch, and a running configuration
  // only shows what differs from it: a file with "no routing" is the file of a switch whose ports
  // are routed unless they say so, and a file with "no shutdown" the file of a switch whose ports
  // are shut down unless they say so.
  const drafts = [...context.drafts.values()];
  const switchPorts = drafts.filter((draft) => draft.port.kind === 'physical' || draft.port.kind === 'lag');
  const defaults: Defaults = {
    routed: switchPorts.some((draft) => draft.routing === false),
    shutdown: switchPorts.some((draft) => draft.shutdown === false),
    // A trunk can only allow the VLANs that the switch has, and a running configuration lists them: a range
    // stands for the VLANs of the file that are in it. A file without any VLAN is not complete: its ranges are taken as written.
    rangesAsWritten: ![...context.vlans.values()].some((vlan) => vlan.declared),
  };

  const known = [...new Set([...context.vlans.keys(), ...context.sviVlans, ...switchPorts.flatMap((draft) => namedVlans(draft, defaults.rangesAsWritten))])];
  const ports: Port[] = [];
  const routedLags = new Set<string>();
  for (const draft of drafts) {
    const port = draft.port;
    const reason = context.vsfLinks.has(port.name) ? 'link between the members of the stack (VSF)' : NOT_A_SWITCH_PORT[port.kind];
    if (reason !== undefined) {
      report.info('interface-skipped', `Interface ${port.name}: ${reason}, not converted`, [draft.line]);
      continue;
    }
    finishPort(context, draft, known, defaults);
    if (port.mode === 'routed') {
      if (port.kind === 'lag') routedLags.add(port.name);
      report.portNote('warning', 'routed-port', 'Routed port, not converted', draft.line, port.name);
      continue;
    }
    if (port.kind === 'physical' && port.junosName === undefined) {
      report.warning('port-name', `Interface ${port.name}: the position of the port cannot be translated, not converted`, [draft.line]);
      continue;
    }
    ports.push(port);
    draft.unknown.forEach((entry) => report.portSettingNotConverted(entry.command, entry.line, port.name));
  }
  // Whether an aggregation runs LACP is said on the aggregated interface.
  const lacpOf = (name: string): boolean => context.drafts.get(name)?.lacpMode !== undefined;
  const converted = ports.filter((port) => !(port.lag && routedLags.has(port.lag.name)));
  for (const port of converted) {
    if (port.kind === 'lag') port.lacp = lacpOf(port.name);
    if (port.lag) port.lag.lacp = lacpOf(port.lag.name);
  }
  device.ports = addMissingLags(converted, (name) => Number(/\d+$/.exec(name)?.[0] ?? 1) - 1, report);
  // The VLANs that ports refer to exist, even when nothing else in the file declares them.
  for (const port of device.ports) if (!port.lag) referencedVlans(port).forEach((id) => vlanOf(context, id));

  // DHCP snooping is turned on for the switch, then on each VLAN.
  for (const vlan of context.vlans.values()) vlan.dhcpSnooping = context.dhcpSnooping && context.snoopedVlans.includes(vlan.id);
  // A link aggregation is trusted when the file says so on the aggregation or on one of its members.
  for (const lag of device.ports.filter((port) => port.kind === 'lag')) {
    if (device.ports.some((port) => port.lag?.name === lag.name && port.dhcpTrusted)) lag.dhcpTrusted = true;
  }
  // With DHCP snooping, an AOS-CX switch trusts a trunk only when the trunk says so. A Juniper switch trusts every trunk.
  if (context.dhcpSnooping && context.snoopedVlans.length > 0) {
    for (const port of device.ports) {
      if (port.mode !== 'trunk' || port.lag || port.dhcpTrusted !== undefined) continue;
      port.dhcpTrusted = false;
      const line = context.drafts.get(port.name)?.line ?? 0;
      report.portNote('warning', 'dhcp-untrusted-trunk', 'DHCP snooping: the trunk has no "dhcpv4-snooping trust", DHCP servers are refused on it', line, port.name);
    }
  }

  finishArubaSnmp(context.snmp);
  device.vlans = [...context.vlans.values()];
  report.flush();
  return device;
}
