/**
 * Extractor for Junos in "display set" form: reads a file and returns what it says
 * as a vendor-neutral `Device`.
 *
 * A Junos configuration spreads the settings of a port over several places
 * (interfaces, protocols dot1x, protocols rstp, switch-options, poe...) and can give
 * them to many ports at once through an interface range. The file is therefore read
 * in three passes, whatever the order of its lines:
 *
 *   1. the VLANs and their ids,
 *   2. the interfaces, where the statements of an interface range are applied to each
 *      of its ports before the statements of the port itself,
 *   3. everything else, which refers to the ports and VLANs found before.
 *
 * The statements the extractor understands are in the rule tables below. A statement
 * without a rule is reported as not converted.
 */
import { addOnce, Device, newDevice, newPort, Port, SourceFile, Speed, StormControl, SyslogServer, TacacsServer, Vlan } from '../model';
import { Report } from '../report';
import { readSetLines } from '../readers/set_lines';
import { Statement } from '../readers/statement';
import { addMissingLags, NOT_A_SWITCH_PORT, referencedVlans } from './common';
import { expandMember, expandMemberRange, readJunosInterface, wildcardMember } from './junos_interfaces';
import { ignore, rule, RuleTable } from './rules';
import { expandVlanRanges, isVlanId, parseVlanList, subnetOf } from './values';

const SPEEDS: Speed[] = ['auto', '10m', '100m', '1g', '2.5g', '5g', '10g', '25g', '40g', '100g'];
const STP_PROTOCOLS = ['rstp', 'mstp', 'vstp', 'stp'];

/* ------------------------------------------------------------ what is read */

/** A port while its statements are read. `finishPort` turns it into a `Port`. */
interface PortDraft {
  port: Port;
  line: number;
  trunk: boolean;
  /** The port has "family ethernet-switching". */
  switching: boolean;
  /** The port has an address or tagged units of its own. */
  routed: boolean;
  /** "vlan members": names, ids, ranges of ids or "all", as written. */
  members: Array<{ vlan: string; fromRange: boolean }>;
  nativeVlan?: string;
  voiceVlan?: string;
  guestVlan?: string;
  serverFailVlan?: string;
  serverRejectVlan?: string;
  /** True while the statements of an interface range are applied to the port. */
  readingRange: boolean;
  /** The lines of the file that are about the port, by line number. */
  source: Map<number, string>;
  /** "family ethernet-switching storm-control <profile>". */
  stormProfile?: string;
  /** Switches without ELS: "ethernet-switching-options storm-control interface <port>". */
  storm?: StormDraft;
}

/** A storm control profile, or the storm control of a port on a switch without ELS. */
interface StormDraft {
  percentage?: number;
  /** The level is in kilobits per second. */
  kbps: boolean;
  noBroadcast: boolean;
  noMulticast: boolean;
  noRegisteredMulticast: boolean;
  noUnregisteredMulticast: boolean;
  noUnknownUnicast: boolean;
  shutdown: boolean;
}

function newStorm(): StormDraft {
  return { kbps: false, noBroadcast: false, noMulticast: false, noRegisteredMulticast: false, noUnregisteredMulticast: false, noUnknownUnicast: false, shutdown: false };
}

/** "bandwidth-percentage 10", "no-broadcast"...: the options of storm control. False for an option without a rule. */
function readStormOption(storm: StormDraft, words: string[]): boolean {
  const [option, value] = words;
  if (option === undefined) return true;
  if ((option === 'bandwidth-percentage' || option === 'level') && number(value ?? '') !== undefined) storm.percentage = Math.min(100, Number(value));
  else if (option === 'bandwidth-level' || option === 'bandwidth') storm.kbps = true;
  else if (option === 'no-broadcast') storm.noBroadcast = true;
  else if (option === 'no-multicast') storm.noMulticast = true;
  else if (option === 'no-registered-multicast') storm.noRegisteredMulticast = true;
  else if (option === 'no-unregistered-multicast') storm.noUnregisteredMulticast = true;
  else if (option === 'no-unknown-unicast') storm.noUnknownUnicast = true;
  else return false;
  return true;
}

interface RadiusDraft {
  port?: number;
  acctPort?: number;
  coaPort?: number;
  timeout?: number;
}

interface Context {
  device: Device;
  report: Report;
  vlans: Map<number, Vlan>;
  /** Id of each VLAN by its name, as written. */
  vlanIds: Map<string, number>;
  drafts: Map<string, PortDraft>;
  /** The ports of each interface range. */
  ranges: Map<string, string[]>;
  /** Subnets of the layer 3 interfaces: "irb.10". */
  layer3: Map<string, string[]>;
  radius: Map<string, RadiusDraft>;
  /** "access profile <name> radius": the servers a profile uses for authentication and accounting. */
  radiusProfiles: Map<string, { auth: string[]; acct: string[] }>;
  dot1xProfile?: string;
  syslog: Map<string, SyslogServer>;
  tacacsAuth: Map<string, TacacsServer>;
  tacacsAcct: Map<string, TacacsServer>;
  /** "forwarding-options storm-control-profiles <name>". */
  stormProfiles: Map<string, StormDraft>;
  /** Switches without ELS: "ethernet-switching-options storm-control interface all". */
  stormAll?: StormDraft;
  /** Switches without ELS: "ethernet-switching-options storm-control action-shutdown". */
  stormShutdown: boolean;
  /** "vlans <vlan> forwarding-options dhcp-security group <group>": its ports, and whether it trusts them. */
  dhcpGroups: Map<string, { trusted?: boolean; ports: PortDraft[] }>;
}

function number(text: string): number | undefined {
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function vlanOf(context: Context, id: number): Vlan {
  let vlan = context.vlans.get(id);
  if (!vlan) {
    vlan = { id, subnets: [], declared: false, dhcpSnooping: false };
    context.vlans.set(id, vlan);
  }
  return vlan;
}

function normalised(name: string): string {
  return name.toLowerCase().replace(/[ &:-]+/g, '_');
}

/** The id of a VLAN given by its id or by its name. Names are matched as written first, then without regard to case. */
function vlanIdOf(context: Context, reference: string): number | undefined {
  if (isVlanId(reference)) return Number(reference);
  const exact = context.vlanIds.get(reference);
  if (exact !== undefined) return exact;
  for (const [name, id] of context.vlanIds) if (normalised(name) === normalised(reference)) return id;
  return undefined;
}

/* --------------------------------------------------------- interface rules */

/** Statements under "interfaces <port>", without those two words. */
const interfaceRules = new RuleTable<PortDraft>([
  rule('description <text...>', (draft, m) => {
    draft.port.description = m.text;
  }),
  rule('disable', (draft) => {
    draft.port.disabled = true;
  }),
  rule('mtu <bytes>', (draft, m) => {
    draft.port.mtu = number(m.bytes);
  }),
  rule('speed <speed>', (draft, m) => setSpeed(draft, m.speed)),
  rule('ether-options speed <speed>', (draft, m) => setSpeed(draft, m.speed)),
  rule('link-mode <mode>', (draft, m) => setDuplex(draft, m.mode)),
  rule('ether-options link-mode <mode>', (draft, m) => setDuplex(draft, m.mode)),
  rule('ether-options no-auto-negotiation', (draft) => {
    draft.port.autoneg = false;
  }),
  rule('ether-options 802.3ad <lag>', (draft, m) => joinLag(draft, m.lag)),
  rule('gigether-options 802.3ad <lag>', (draft, m) => joinLag(draft, m.lag)),
  rule('fastether-options 802.3ad <lag>', (draft, m) => joinLag(draft, m.lag)),
  rule('aggregated-ether-options lacp <mode>', (draft, m) => {
    if (m.mode !== 'active' && m.mode !== 'passive') return false;
    draft.port.lacp = true;
    return undefined;
  }),

  // Layer 2
  rule('unit <unit> family ethernet-switching', (draft) => {
    draft.switching = true;
  }),
  rule('unit <unit> family ethernet-switching interface-mode <mode>', (draft, m) => setMode(draft, m.mode)),
  // Switches without ELS (EX2200, EX3300, EX4200...) say "port-mode"
  rule('unit <unit> family ethernet-switching port-mode <mode>', (draft, m) => setMode(draft, m.mode)),
  rule('unit <unit> family ethernet-switching vlan members <vlan>', (draft, m) => {
    draft.switching = true;
    draft.members.push({ vlan: m.vlan, fromRange: draft.readingRange });
  }),
  rule('native-vlan-id <vlan>', (draft, m) => {
    draft.nativeVlan = m.vlan;
  }),
  rule('unit <unit> family ethernet-switching storm-control <profile>', (draft, m) => {
    draft.switching = true;
    draft.stormProfile = m.profile;
  }),
  rule('unit <unit> family ethernet-switching native-vlan-id <vlan>', (draft, m) => {
    draft.switching = true;
    draft.nativeVlan = m.vlan;
  }),

  // Layer 3: a port with an address or tagged units of its own is not a switch port
  rule('unit <unit> family inet ...', (draft) => {
    draft.routed = true;
  }),
  rule('unit <unit> family inet6 ...', (draft) => {
    draft.routed = true;
  }),
  rule('unit <unit> vlan-id <id>', (draft) => {
    draft.routed = true;
  }),
  rule('vlan-tagging', (draft) => {
    draft.routed = true;
  }),

  ignore(
    'ether-options 802.3ad lacp ...',
    'gigether-options 802.3ad lacp ...',
    'ether-options auto-negotiation',
    'ether-options flow-control',
    'ether-options no-flow-control',
    'aggregated-ether-options ...',
    'unit <unit> description ...',
    'unit <unit> family ethernet-switching recovery-timeout <seconds>',
    'traps',
    'no-traps',
  ),
]);

function setSpeed(draft: PortDraft, speed: string): void {
  // "auto-10m-100m" and the like have no equivalent in a port usage
  draft.port.speed = SPEEDS.includes(speed as Speed) ? (speed as Speed) : 'auto';
}

function setDuplex(draft: PortDraft, mode: string): void | false {
  if (mode === 'full-duplex') draft.port.duplex = 'full';
  else if (mode === 'half-duplex') draft.port.duplex = 'half';
  else if (mode === 'automatic') draft.port.duplex = 'auto';
  else return false;
  return undefined;
}

function setMode(draft: PortDraft, mode: string): void | false {
  if (mode !== 'trunk' && mode !== 'access' && mode !== 'tagged-access') return false;
  draft.switching = true;
  draft.trunk = mode !== 'access';
  return undefined;
}

function joinLag(draft: PortDraft, lag: string): void | false {
  if (!/^ae\d+$/.test(lag)) return false;
  // Whether the aggregation runs LACP is said on the aggregated interface: see `finish`.
  draft.port.lag = { name: lag, lacp: false };
  return undefined;
}

/** Statements under "protocols dot1x authenticator interface <port>", without those words. */
const dot1xRules = new RuleTable<PortDraft>([
  rule('supplicant <mode>', (draft, m) => {
    draft.port.auth.multipleSupplicants = m.mode === 'multiple';
  }),
  rule('mac-radius restrict', (draft) => {
    draft.port.auth.macAuth = true;
    draft.port.auth.macAuthOnly = true;
  }),
  rule('mac-radius ...', (draft) => {
    draft.port.auth.macAuth = true;
  }),
  rule('guest-vlan <vlan>', (draft, m) => {
    draft.guestVlan = m.vlan;
  }),
  rule('server-reject-vlan <vlan> ...', (draft, m) => {
    draft.serverRejectVlan = m.vlan;
  }),
  rule('server-fail use-cache', (draft) => {
    draft.port.auth.bypassWhenServerDown = true;
  }),
  rule('server-fail permit', (draft) => {
    draft.port.auth.permitWhenServerDown = true;
  }),
  rule('server-fail vlan-name <vlan>', (draft, m) => {
    draft.serverFailVlan = m.vlan;
  }),
  rule('reauthentication <seconds>', (draft, m) => {
    draft.port.auth.reauthInterval = number(m.seconds);
  }),
  ignore('server-fail deny', 'no-reauthentication', 'retries <count>', 'quiet-period <seconds>', 'transmit-period <seconds>', 'supplicant-timeout <seconds>', 'server-timeout <seconds>', 'maximum-requests <count>'),
]);

/* ------------------------------------------------------------ global rules */

/**
 * The ports that a statement outside "interfaces" refers to: a port, with or without
 * its unit, an interface range, "all", or a name with wildcards.
 */
function portsOf(context: Context, reference: string, statement: Statement): PortDraft[] {
  const ports = referredPorts(context, reference, statement);
  for (const draft of ports) draft.source.set(statement.line, statement.text);
  return ports;
}

function referredPorts(context: Context, reference: string, statement: Statement): PortDraft[] {
  const name = reference.replace(/\.\d+$/, '');
  const switchPorts = [...context.drafts.values()].filter((draft) => draft.port.kind === 'physical' || draft.port.kind === 'lag');
  const range = context.ranges.get(name);
  if (range) return switchPorts.filter((draft) => range.includes(draft.port.name));
  // A member of a link aggregation is not a switch port of its own.
  const standalone = switchPorts.filter((draft) => !draft.port.lag);
  if (name === 'all') return standalone;
  // In "switch-options voip", "access-ports" stands for every access port.
  if (name === 'access-ports') return standalone.filter((draft) => !draft.trunk);
  if (/[*?]/.test(name)) return standalone.filter((draft) => wildcardMember(name).test(draft.port.name));
  const draft = context.drafts.get(name);
  if (!draft) context.report.portNote('info', 'port-not-configured', 'A setting refers to a port that the file does not configure under "interfaces": left out', statement.line, name);
  return draft && switchPorts.includes(draft) ? [draft] : [];
}

/**
 * A statement outside "interfaces" that names a port is one of the lines of that port,
 * converted or not: the details of the port show what the file says about it.
 */
function noteNamedPorts(context: Context, statement: Statement): void {
  for (const word of statement.words) {
    const draft = context.drafts.get(word.replace(/\.\d+$/, ''));
    if (draft && (draft.port.kind === 'physical' || draft.port.kind === 'lag')) draft.source.set(statement.line, statement.text);
  }
}

function stormProfileOf(context: Context, name: string): StormDraft {
  let profile = context.stormProfiles.get(name);
  if (!profile) {
    profile = newStorm();
    context.stormProfiles.set(name, profile);
  }
  return profile;
}

/** The storm control of a port: its profile, or on a switch without ELS its own options or those of "all". */
function stormControlOf(context: Context, draft: PortDraft): StormControl | undefined {
  const note = (code: string, text: string): void => context.report.portNote('warning', code, text, draft.line, draft.port.name);
  let storm = draft.storm ?? context.stormAll;
  if (draft.stormProfile !== undefined) {
    storm = context.stormProfiles.get(draft.stormProfile);
    if (!storm) note('storm-control-profile', 'The storm control profile of the port is not defined in the file: left out');
  }
  if (!storm) return undefined;
  if (storm.kbps && storm.percentage === undefined) {
    note('storm-control-unit', 'Storm control with a level in bits or packets per second has no equivalent, Mist takes a percentage: left out');
    return undefined;
  }
  if (storm.noUnregisteredMulticast) note('storm-control-unregistered', 'Storm control: "no-unregistered-multicast" has no equivalent, the multicast that no host has joined stays limited');
  return {
    // Without a level, Junos limits the traffic to 80 % of the bandwidth
    percentage: storm.percentage ?? 80,
    broadcast: !storm.noBroadcast,
    multicast: !storm.noMulticast,
    registeredMulticast: !storm.noRegisteredMulticast,
    unknownUnicast: !storm.noUnknownUnicast,
    shutdown: storm.shutdown || (draft.stormProfile === undefined && context.stormShutdown),
  };
}

function radiusOf(context: Context, host: string): RadiusDraft {
  let server = context.radius.get(host);
  if (!server) {
    server = {};
    context.radius.set(host, server);
  }
  return server;
}

/** "port 1812", "accounting-port 1813", "secret ..." after the address of a RADIUS server. */
function readRadiusOption(context: Context, host: string, option: string): void {
  const server = radiusOf(context, host);
  const [keyword, value] = option.split(' ');
  const port = value === undefined ? undefined : number(value);
  if (port === undefined) return;
  if (keyword === 'port') server.port = port;
  else if (keyword === 'accounting-port') server.acctPort = port;
  else if (keyword === 'dynamic-request-port') server.coaPort = port;
  else if (keyword === 'timeout') server.timeout = port;
}

function profileOf(context: Context, name: string): { auth: string[]; acct: string[] } {
  let profile = context.radiusProfiles.get(name);
  if (!profile) {
    profile = { auth: [], acct: [] };
    context.radiusProfiles.set(name, profile);
  }
  return profile;
}

function serverOf<T extends { host: string }>(servers: Map<string, T>, host: string, create: () => T): T {
  let server = servers.get(host);
  if (!server) {
    server = create();
    servers.set(host, server);
  }
  return server;
}

const syslogOf = (context: Context, host: string): SyslogServer => serverOf(context.syslog, host, () => ({ host, protocol: 'udp', port: 514 }));
const tacacsOf = (servers: Map<string, TacacsServer>, host: string): TacacsServer => serverOf(servers, host, () => ({ host, port: 49 }));

/** Statements that are not under "interfaces", with their full path. */
const globalRules = new RuleTable<Context>([
  // Read in the first two passes
  ignore('vlans <name> vlan-id <id>', 'interfaces ...'),

  // VLANs
  rule('vlans <name> l3-interface <unit>', (context, m) => {
    const id = vlanIdOf(context, m.name);
    if (id === undefined) return;
    for (const subnet of context.layer3.get(m.unit) ?? []) addOnce(vlanOf(context, id).subnets, subnet);
  }),
  // "display set" prints the options of dhcp-security, when it has some, in place of the bare statement
  rule('vlans <name> forwarding-options dhcp-security ...', (context, m, statement) => {
    const id = vlanIdOf(context, m.name);
    if (id !== undefined) vlanOf(context, id).dhcpSnooping = true;
    // "group UPLINKS overrides trusted" and "group UPLINKS interface ge-0/0/47": the ports that may face a DHCP server
    const [keyword, name, option, value] = statement.words.slice(4);
    if (keyword !== 'group' || name === undefined) return;
    const group = context.dhcpGroups.get(`${m.name} ${name}`) ?? { ports: [] };
    context.dhcpGroups.set(`${m.name} ${name}`, group);
    if (option === 'overrides' && (value === 'trusted' || value === 'untrusted')) group.trusted = value === 'trusted';
    if (option === 'interface' && value !== undefined) group.ports.push(...portsOf(context, value, statement));
  }),

  // Storm control
  rule('forwarding-options storm-control-profiles <name> action-shutdown', (context, m) => {
    stormProfileOf(context, m.name).shutdown = true;
  }),
  rule('forwarding-options storm-control-profiles <name> all ...', (context, m, statement) => (readStormOption(stormProfileOf(context, m.name), statement.words.slice(4)) ? undefined : false)),
  // Switches without ELS have no profile: the options are written for a port, or for all of them
  rule('ethernet-switching-options storm-control action-shutdown', (context) => {
    context.stormShutdown = true;
  }),
  rule('ethernet-switching-options storm-control interface <port> ...', (context, m, statement) => {
    const options = statement.words.slice(4);
    if (m.port === 'all') {
      context.stormAll ??= newStorm();
      return readStormOption(context.stormAll, options) ? undefined : false;
    }
    let known = true;
    for (const draft of portsOf(context, m.port, statement)) {
      draft.storm ??= newStorm();
      known = readStormOption(draft.storm, options);
    }
    return known ? undefined : false;
  }),
  rule('ethernet-switching-options secure-access-port interface <port> dhcp-trusted', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.port.dhcpTrusted = true;
  }),
  rule('ethernet-switching-options secure-access-port interface <port> no-dhcp-trusted', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.port.dhcpTrusted = false;
  }),
  rule('ethernet-switching-options secure-access-port vlan <name> examine-dhcp', (context, m) => {
    const id = vlanIdOf(context, m.name);
    if (id !== undefined) vlanOf(context, id).dhcpSnooping = true;
  }),
  // Switches without ELS can list the ports of a VLAN under the VLAN
  rule('vlans <name> interface <port>', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.members.push({ vlan: m.name, fromRange: false });
  }),
  ignore('vlans <name> description ...'),

  // System
  rule('system host-name <name>', (context, m) => {
    context.device.hostname = m.name;
  }),
  rule('system name-server <address> ...', (context, m) => addOnce(context.device.system.dnsServers, m.address)),
  rule('system domain-search <domain>', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
  rule('system domain-name <domain>', (context, m) => addOnce(context.device.system.dnsSuffixes, m.domain)),
  rule('system ntp server <server> ...', (context, m) => addOnce(context.device.system.ntpServers, m.server)),
  rule('system login message <text...>', (context, m) => {
    // "display set" writes the line breaks of the message as \n
    context.device.system.banner = m.text.replace(/\\n/g, '\n');
  }),
  rule('system syslog host <host> port <port>', (context, m) => {
    syslogOf(context, m.host).port = number(m.port) ?? 514;
  }),
  rule('system syslog host <host> transport <protocol>', (context, m) => {
    syslogOf(context, m.host).protocol = m.protocol;
  }),
  rule('system syslog host <host> ...', (context, m) => {
    syslogOf(context, m.host);
  }),

  // TACACS+ and RADIUS
  rule('system tacplus-server <host> port <port>', (context, m) => {
    tacacsOf(context.tacacsAuth, m.host).port = number(m.port) ?? 49;
  }),
  rule('system tacplus-server <host> ...', (context, m) => {
    tacacsOf(context.tacacsAuth, m.host);
  }),
  rule('system accounting destination tacplus server <host> port <port>', (context, m) => {
    tacacsOf(context.tacacsAcct, m.host).port = number(m.port) ?? 49;
  }),
  rule('system accounting destination tacplus server <host> ...', (context, m) => {
    tacacsOf(context.tacacsAcct, m.host);
  }),
  rule('access radius-server <host> ...', (context, m) => readRadiusOption(context, m.host, m.rest)),
  rule('access profile <profile> radius-server <host> ...', (context, m) => readRadiusOption(context, m.host, m.rest)),
  rule('access profile <profile> radius authentication-server <host>', (context, m) => addOnce(profileOf(context, m.profile).auth, m.host)),
  rule('access profile <profile> radius accounting-server <host>', (context, m) => addOnce(profileOf(context, m.profile).acct, m.host)),
  rule('protocols dot1x authenticator authentication-profile-name <profile>', (context, m) => {
    context.dot1xProfile = m.profile;
  }),

  // Settings of the ports that are written outside "interfaces"
  rule('protocols dot1x authenticator interface <port> ...', (context, m, statement) => {
    const words = statement.words.slice(5);
    const known = words.length === 0 || dot1xRules.matches(words);
    for (const draft of portsOf(context, m.port, statement)) {
      draft.port.auth.dot1x = true;
      if (words.length > 0) dot1xRules.apply(draft, { ...statement, words });
      if (!known) context.report.portSettingNotConverted(`dot1x ${words[0]}`, statement.line, draft.port.name);
    }
  }),
  rule('protocols <protocol> interface <port> edge', (context, m, statement) => {
    if (!STP_PROTOCOLS.includes(m.protocol)) return false;
    for (const draft of portsOf(context, m.port, statement)) draft.port.stpEdge = true;
    return undefined;
  }),
  rule('class-of-service interfaces <port> ...', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.port.qos = true;
  }),
  rule('poe interface <port> disable', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.port.poe = false;
  }),
  rule('switch-options interface <port> interface-mac-limit <count> ...', (context, m, statement) => {
    const limit = number(m.count);
    if (limit === undefined) return false;
    for (const draft of portsOf(context, m.port, statement)) draft.port.macLimit = limit;
    return undefined;
  }),
  rule('ethernet-switching-options secure-access-port interface <port> mac-limit <count> ...', (context, m, statement) => {
    const limit = number(m.count);
    if (limit === undefined) return false;
    for (const draft of portsOf(context, m.port, statement)) draft.port.macLimit = limit;
    return undefined;
  }),
  rule('switch-options interface <port> persistent-learning', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.port.persistMac = true;
  }),
  rule('ethernet-switching-options secure-access-port interface <port> persistent-learning', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.port.persistMac = true;
  }),
  rule('switch-options voip interface <port> vlan <vlan>', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.voiceVlan = m.vlan;
  }),
  rule('ethernet-switching-options voip interface <port> vlan <vlan>', (context, m, statement) => {
    for (const draft of portsOf(context, m.port, statement)) draft.voiceVlan = m.vlan;
  }),

  // Statements with no place in a Mist template. Anything not listed here is reported.
  ignore(
    'version ...',
    'system root-authentication ...',
    'system login ...',
    'system services ...',
    'system time-zone ...',
    'system syslog ...',
    'system commit ...',
    'system processes ...',
    'system auto-snapshot',
    'system ports ...',
    'system scripts ...',
    'system license ...',
    'system phone-home ...',
    'system authentication-order ...',
    'system accounting events ...',
    'system ntp ...',
    'system arp ...',
    'system internet-options ...',
    'system no-redirects',
    'system management-instance',
    'chassis ...',
    'event-options ...',
    'virtual-chassis ...',
    'protocols lldp ...',
    'protocols lldp-med ...',
    'protocols rstp ...',
    'protocols mstp ...',
    'protocols vstp ...',
    'protocols dot1x traceoptions ...',
    'protocols dot1x authenticator ...',
    'class-of-service ...',
    'poe ...',
    'switch-options voip interface <port> forwarding-class <class>',
    'ethernet-switching-options voip interface <port> forwarding-class <class>',
    'access profile <profile> authentication-order ...',
    'access profile <profile> accounting ...',
    'access profile <profile> radius options ...',
  ),
]);

/** What a report shows of a statement without a rule: its first keywords, never a value. */
function statementKey(words: string[]): string {
  const [first, second, third] = words;
  if (first === 'vlans') return third === undefined ? 'vlans' : `vlans ${third}`;
  // After these, the second word is a name
  if (['groups', 'apply-groups', 'routing-instances'].includes(first) || second === undefined) return first;
  return `${first} ${second}`;
}

/** The same for a statement under "interfaces <port>". */
function interfaceStatementKey(words: string[]): string {
  // "unit 0 family ethernet-switching storm-control default" is shown as "family ethernet-switching storm-control"
  const afterUnit = words[0] === 'unit' ? words.slice(2) : words;
  if (afterUnit[0] === 'family') return afterUnit.slice(0, 3).join(' ');
  return afterUnit.slice(0, 2).join(' ') || 'unit';
}

/* --------------------------------------------------------------- the passes */

function draftOf(context: Context, name: string, line: number): PortDraft {
  let draft = context.drafts.get(name);
  if (!draft) {
    const read = readJunosInterface(name);
    const port = newPort(read.name, read.kind);
    if (read.kind === 'physical') port.junosName = read.name;
    if (read.kind === 'lag') {
      port.aeIndex = read.number;
      port.lacp = false;
    }
    draft = { port, line, trunk: false, switching: false, routed: false, members: [], readingRange: false, source: new Map() };
    context.drafts.set(name, draft);
  }
  return draft;
}

/** Pass 2: "set interfaces ...". */
function readInterfaces(context: Context, statements: Statement[]): void {
  const own = statements.filter((statement) => statement.words[1] !== 'interface-range' && statement.words.length > 1);
  const inRanges = statements.filter((statement) => statement.words[1] === 'interface-range' && statement.words.length > 3);

  // The ports of each range. A member with a wildcard stands for the ports that the file configures by name.
  const configured = [...new Set(own.map((statement) => readJunosInterface(statement.words[1]).name))];
  for (const statement of inRanges) {
    const [, , range, keyword, first, , last] = statement.words;
    if (keyword !== 'member' && keyword !== 'member-range') continue;
    let ports = keyword === 'member' ? expandMember(first) : expandMemberRange(first, last ?? '');
    if (!ports && keyword === 'member' && /[*?]/.test(first)) {
      ports = configured.filter((name) => wildcardMember(first).test(name));
      context.report.warning('range-wildcard', `Interface range ${range}: the member "${first}" has a wildcard. Only the ports that the file configures by name are converted`, [statement.line]);
    }
    if (!ports) {
      context.report.warning('range-member', `Interface range ${range}: a member could not be read and is left out`, [statement.line]);
      continue;
    }
    const members = context.ranges.get(range) ?? [];
    ports.forEach((port) => addOnce(members, port));
    context.ranges.set(range, members);
  }

  // Ports exist in the order of the file: a range creates its ports where it is declared.
  for (const statement of statements) {
    if (statement.words[1] !== 'interface-range') draftOf(context, readJunosInterface(statement.words[1]).name, statement.line);
    else if (statement.words[3] === 'member' || statement.words[3] === 'member-range') {
      for (const port of context.ranges.get(statement.words[2]) ?? []) draftOf(context, port, statement.line);
    }
  }

  // The statements of a range first, then those of the port, which Junos prefers.
  for (const statement of inRanges) {
    const [, , range, keyword] = statement.words;
    if (keyword === 'member' || keyword === 'member-range') continue;
    for (const port of context.ranges.get(range) ?? []) {
      const draft = draftOf(context, port, statement.line);
      addOnce(draft.port.groups, range);
      draft.readingRange = true;
      readInterfaceStatement(context, draft, statement, statement.words.slice(3));
      draft.readingRange = false;
    }
  }
  for (const statement of own) {
    readInterfaceStatement(context, draftOf(context, readJunosInterface(statement.words[1]).name, statement.line), statement, statement.words.slice(2));
  }
}

function readInterfaceStatement(context: Context, draft: PortDraft, statement: Statement, words: string[]): void {
  const port = draft.port;
  draft.source.set(statement.line, statement.text);
  if (port.kind === 'svi') {
    // "set interfaces irb unit 10 family inet address 10.1.10.1/24": the subnet of the VLAN whose l3-interface is irb.10
    const [unit, unitNumber, family, inet, address, value] = words;
    const subnet = unit === 'unit' && family === 'family' && inet === 'inet' && address === 'address' ? subnetOf(value ?? '') : null;
    if (subnet !== null) {
      const subnets = context.layer3.get(`${port.name}.${unitNumber}`) ?? [];
      addOnce(subnets, subnet);
      context.layer3.set(`${port.name}.${unitNumber}`, subnets);
    }
    return;
  }
  if (port.kind !== 'physical' && port.kind !== 'lag') return;
  if (words.length === 0) return;
  if (interfaceRules.apply(draft, { ...statement, words }) === 'unknown') context.report.portSettingNotConverted(interfaceStatementKey(words), statement.line, port.name);
}

/** Turns what was read on a port into a port, once the whole file is read. */
function finishPort(context: Context, draft: PortDraft): void {
  const port = draft.port;
  // In the order of the file
  port.lines = [...draft.source.entries()].sort(([a], [b]) => a - b).map(([, text]) => text);
  const declared = [...context.vlans.values()].filter((vlan) => vlan.declared).map((vlan) => vlan.id);
  const resolve = (reference: string | undefined): number | undefined => {
    if (reference === undefined) return undefined;
    const id = vlanIdOf(context, reference);
    if (id === undefined) context.report.portNote('warning', 'vlan-not-defined', `VLAN "${reference}" is used and is not defined in the file: left out`, draft.line, port.name);
    return id;
  };
  /** The ids of "vlan members": a VLAN, a range of ids, or "all". */
  const membersOf = (members: string[]): number[] | 'all' => {
    const ids: number[] = [];
    for (const member of members) {
      if (member === 'all') return 'all';
      const ranges = isVlanId(member) ? undefined : parseVlanList(member);
      // A range of ids gives the VLANs that the switch has in that range.
      const found = ranges ? expandVlanRanges(ranges, declared, false) : [resolve(member)];
      if (found === 'all') return 'all';
      found.forEach((id) => id !== undefined && addOnce(ids, id));
    }
    return ids;
  };

  port.mode = draft.trunk ? 'trunk' : 'access';
  if (draft.trunk) {
    port.nativeVlan = resolve(draft.nativeVlan);
    port.allowedVlans = membersOf(draft.members.map((member) => member.vlan));
  } else {
    // An access port has one VLAN. What the port says itself comes before what an interface range says.
    const own = draft.members.filter((member) => !member.fromRange);
    const members = membersOf((own.length > 0 ? own : draft.members).map((member) => member.vlan));
    // Without a VLAN, Junos puts the port in the VLAN named "default".
    port.accessVlan = (members === 'all' ? undefined : members[0]) ?? vlanIdOf(context, 'default') ?? 1;
    port.voiceVlan = resolve(draft.voiceVlan);
  }
  port.stormControl = stormControlOf(context, draft);
  port.auth.guestVlan = resolve(draft.guestVlan);
  port.auth.serverFailVlan = resolve(draft.serverFailVlan);
  port.auth.serverRejectVlan = resolve(draft.serverRejectVlan);
}

function finishServers(context: Context): void {
  const system = context.device.system;
  system.syslogServers = [...context.syslog.values()];
  system.tacacs = { auth: [...context.tacacsAuth.values()], acct: [...context.tacacsAcct.values()] };

  // An access profile says what each RADIUS server is used for. The profile of 802.1X is the one that counts.
  const dot1x = context.dot1xProfile === undefined ? undefined : context.radiusProfiles.get(context.dot1xProfile);
  const profiles = dot1x ? [dot1x] : [...context.radiusProfiles.values()];
  const listed = (kind: 'auth' | 'acct'): string[] => [...new Set(profiles.flatMap((profile) => profile[kind]))];
  const timeoutOf = (host: string): number => context.radius.get(host)?.timeout ?? 5;

  // Without a list, every server is an authentication server, on port 1812 unless it says otherwise.
  const authHosts = listed('auth').length > 0 ? listed('auth') : [...context.radius.keys()];
  system.radius.auth = authHosts.map((host) => ({ host, port: context.radius.get(host)?.port ?? 1812, timeout: timeoutOf(host) }));
  // The accounting servers are those of the profile. Without any profile, they are the servers with "accounting-port".
  const acctHosts = profiles.length > 0 ? listed('acct') : [...context.radius.keys()].filter((host) => context.radius.get(host)?.acctPort !== undefined);
  system.radius.acct = acctHosts.map((host) => ({ host, port: context.radius.get(host)?.acctPort ?? 1813, timeout: timeoutOf(host) }));
  const unused = [...context.radius.keys()].filter((host) => !authHosts.includes(host) && !acctHosts.includes(host));
  if (unused.length > 0) context.report.info('radius-unused', `RADIUS servers that the access profile does not list are left out: ${unused.join(', ')}`);
  system.radius.coaPort = [...context.radius.values()].find((server) => server.coaPort !== undefined)?.coaPort;
}

/* ------------------------------------------------------------- entry point */

export function extractJunos(file: SourceFile, report: Report): Device {
  const statements = readSetLines(file.text);
  const context: Context = {
    device: newDevice(file.name, 'junos'),
    report,
    vlans: new Map(),
    vlanIds: new Map(),
    drafts: new Map(),
    ranges: new Map(),
    layer3: new Map(),
    radius: new Map(),
    radiusProfiles: new Map(),
    syslog: new Map(),
    tacacsAuth: new Map(),
    tacacsAcct: new Map(),
    stormProfiles: new Map(),
    stormShutdown: false,
    dhcpGroups: new Map(),
  };

  // Pass 1: the VLANs and their ids
  for (const { words } of statements) {
    if (words[0] !== 'vlans' || words[2] !== 'vlan-id' || words.length !== 4 || !isVlanId(words[3])) continue;
    const vlan = vlanOf(context, Number(words[3]));
    vlan.declared = true;
    vlan.name ??= words[1];
    context.vlanIds.set(words[1], vlan.id);
  }

  // Pass 2: the interfaces
  readInterfaces(context, statements.filter((statement) => statement.words[0] === 'interfaces'));

  // Pass 3: everything else
  for (const statement of statements) {
    if (statement.words[0] !== 'interfaces') noteNamedPorts(context, statement);
    if (globalRules.apply(context, statement) === 'unknown') report.notConverted(statementKey(statement.words), statement.line);
  }

  // The prompt of a capture names the device when the configuration does not: "admin@ex1>"
  const device = context.device;
  device.hostname ??= /^[\w.-]+@([\w.-]+)[>#]/m.exec(file.text)?.[1];
  finishServers(context);
  // The ports of a DHCP security group are trusted, or not, when the group says so
  for (const group of context.dhcpGroups.values()) {
    if (group.trusted !== undefined) for (const draft of group.ports) draft.port.dhcpTrusted = group.trusted;
  }

  const ports: Port[] = [];
  for (const draft of context.drafts.values()) {
    const port = draft.port;
    if (port.kind === 'svi') continue;
    const reason = NOT_A_SWITCH_PORT[port.kind];
    if (reason !== undefined) {
      report.info('interface-skipped', `Interface ${port.name}: ${reason}, not converted`, [draft.line]);
      continue;
    }
    if (draft.routed && !draft.switching) {
      report.warning('routed-port', `Interface ${port.name}: routed port (it has an address or tagged units of its own), not converted`, [draft.line]);
      continue;
    }
    finishPort(context, draft);
    ports.push(port);
  }
  // An aggregation runs LACP when its aggregated interface says so.
  for (const port of ports) {
    if (port.lag) port.lag.lacp = ports.find((lag) => lag.kind === 'lag' && lag.name === port.lag?.name)?.lacp ?? false;
  }
  device.ports = addMissingLags(ports, (name) => number(name.replace('ae', '')), report);
  // The VLANs that ports refer to by id exist, even when the file does not name them.
  for (const port of device.ports) if (!port.lag) referencedVlans(port).forEach((id) => vlanOf(context, id));

  device.vlans = [...context.vlans.values()];
  report.flush();
  return device;
}
