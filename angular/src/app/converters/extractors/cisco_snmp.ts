/**
 * SNMP of a Cisco IOS configuration: the commands that start with "snmp-server",
 * without that word, and the standard access lists that the communities refer to.
 *
 * A Mist template describes SNMP as Junos does. What Cisco says differently is
 * translated here:
 *   - the access list of a community becomes a client list;
 *   - "snmp-server host" becomes a trap group for versions 1 and 2c, and a target with
 *     its parameters for version 3;
 *   - the kinds of traps of "snmp-server enable traps" become the categories of Junos;
 *   - a group of version 3 becomes the access of that group, a user becomes a user and
 *     its group.
 *
 * The community that a host line carries is not read: Junos sends the name of the
 * trap group in its place.
 */
import { addOnce, named, Snmp, SnmpAccess, SnmpCommunity, SnmpSecurityLevel, SnmpTargetParameters, SnmpTrapGroup, SnmpUser } from '../model';
import { Report } from '../report';
import { Statement } from '../readers/statement';
import { rule, RuleTable } from './rules';
import { isIpAddress, isIpv4 } from './values';

/** A standard access list: the prefixes it permits. */
interface AccessList {
  prefixes: string[];
  /** False when the list has an entry that a list of prefixes cannot say: "deny", a mask with holes. */
  exact: boolean;
}

export interface CiscoSnmp {
  snmp: Snmp;
  report: Report;
  accessLists: Map<string, AccessList>;
  /** The access list of each community that has one, and the line that says so. */
  communityLists: Array<{ community: SnmpCommunity; list: string; line: number }>;
  /** "snmp-server enable traps": the kinds of traps that are sent. 'all' for the command without a kind. */
  trapKinds: string[] | 'all';
  /** Number of "snmp-server enable traps" kinds without a category in Junos. */
  unknownKinds: number;
}

export function newCiscoSnmp(snmp: Snmp, report: Report): CiscoSnmp {
  return { snmp, report, accessLists: new Map(), communityLists: [], trapKinds: [], unknownKinds: 0 };
}

const LEVELS: Record<string, SnmpSecurityLevel> = { noauth: 'none', auth: 'authentication', priv: 'privacy' };
/** The view of a Cisco group or community that names none: everything. */
const DEFAULT_VIEW = 'v1default';
/** The object names that Cisco accepts in a view and Junos does not. */
const OID_NAMES: Record<string, string> = { iso: '.1', internet: '.1.3.6.1', 'mib-2': '.1.3.6.1.2.1', system: '.1.3.6.1.2.1.1', interfaces: '.1.3.6.1.2.1.2' };

/** The words that can follow a community, and the numbers that say that a community is encrypted. */
const COMMUNITY_OPTIONS = ['view', 'ro', 'rw', 'ipv6'];
const ENCRYPTION_TYPES = ['6', '7'];

/** The categories of Junos for the kinds of traps of Cisco. */
const SNMP_KINDS: Record<string, string> = { authentication: 'authentication', linkdown: 'link', linkup: 'link', coldstart: 'startup', warmstart: 'startup' };
const KIND_CATEGORIES: Record<string, string> = {
  config: 'configuration',
  'config-copy': 'configuration',
  'config-ctid': 'configuration',
  envmon: 'chassis',
  'fru-ctrl': 'chassis',
  entity: 'chassis',
  'power-ethernet': 'chassis',
  stackwise: 'chassis',
  ospf: 'routing',
  ospfv3: 'routing',
  bgp: 'routing',
  eigrp: 'routing',
  isis: 'routing',
  pim: 'routing',
  vrrp: 'vrrp-events',
  rmon: 'rmon-alarm',
};

/* ------------------------------------------------------------ access lists */

/** "0.0.0.255" as a prefix length, or undefined for a mask with holes. */
function wildcardLength(wildcard: string): number | undefined {
  if (!isIpv4(wildcard)) return undefined;
  const bits = wildcard
    .split('.')
    .map((part) => Number(part).toString(2).padStart(8, '0'))
    .join('');
  return /^0*1*$/.test(bits) ? bits.indexOf('1') === -1 ? 32 : bits.indexOf('1') : undefined;
}

/** One entry of a standard access list: "permit 10.0.0.0 0.0.0.255", "permit host 10.0.0.5", "deny any". */
export function readAccessListEntry(target: CiscoSnmp, name: string, words: string[]): void | false {
  // A named list numbers its entries: "10 permit ..."
  const [action, first, second] = (/^\d+$/.test(words[0] ?? '') ? words.slice(1) : words).map((word) => word.toLowerCase());
  if (action === 'remark') return undefined;
  if (action !== 'permit' && action !== 'deny') return false;
  const list = target.accessLists.get(name) ?? { prefixes: [], exact: true };
  target.accessLists.set(name, list);
  let prefix: string | undefined;
  if (first === 'any') prefix = '0.0.0.0/0';
  else if (first === 'host' && isIpv4(second ?? '')) prefix = `${second}/32`;
  else if (isIpv4(first ?? '')) {
    const length = second === undefined || second === 'log' ? 32 : wildcardLength(second);
    if (length !== undefined) prefix = `${first}/${length}`;
  }
  // The entry that refuses everybody else is what a client list does anyway
  if (action === 'deny' && first === 'any') return undefined;
  if (action === 'deny' || prefix === undefined) list.exact = false;
  else addOnce(list.prefixes, prefix);
  return undefined;
}

/* ------------------------------------------------------------------- rules */

/** The words that follow a keyword of a command: "read" in "... read ALL write NONE". */
function optionAfter(words: string[], keyword: string): string | undefined {
  const index = words.findIndex((word) => word.toLowerCase() === keyword);
  return index >= 0 ? words[index + 1] : undefined;
}

function communityOf(snmp: Snmp, community: string, line: number): SnmpCommunity {
  let entry = snmp.communities.find((candidate) => candidate.community === community);
  if (!entry) {
    entry = { community, authorization: 'read-only', line };
    snmp.communities.push(entry);
  }
  return entry;
}

/** "snmp-server host 10.0.0.5 [vrf X] [traps | informs] [version 1 | 2c | 3 <level>] <community or user> [udp-port N] [kinds]". */
function readHost(target: CiscoSnmp, address: string, words: string[]): void | false {
  if (!isIpAddress(address)) return false;
  const snmp = target.snmp;
  let version = '1';
  let level: SnmpSecurityLevel = 'none';
  let type: 'trap' | 'inform' = 'trap';
  let name: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < words.length && name === undefined; index++) {
    const word = words[index].toLowerCase();
    if (word === 'vrf') index += 1;
    else if (word === 'traps') type = 'trap';
    else if (word === 'informs') type = 'inform';
    else if (word === 'version') {
      version = (words[++index] ?? '').toLowerCase();
      if (version === '3') level = LEVELS[(words[++index] ?? '').toLowerCase()] ?? 'none';
    } else name = words[index];
  }
  const udpPort = optionAfter(words, 'udp-port');
  if (udpPort !== undefined && /^\d+$/.test(udpPort)) port = Number(udpPort);
  if (name === undefined || !['1', '2c', '3'].includes(version)) return false;

  if (version === '3') {
    // The name is the user of version 3: the parameters say how the notifications are sent to the station
    const tag = type === 'inform' ? 'informs' : 'traps';
    const parameters = `${tag}_${name}`;
    named(snmp.notifies, tag, () => ({ name: tag, tag, type }));
    named<SnmpTargetParameters>(snmp.targetParameters, parameters, () => ({ name: parameters, processing: 'v3', model: 'usm', level, securityName: name }));
    const station = named(snmp.targets, `target_${address}`, () => ({ name: `target_${address}`, address, tags: [], parameters }));
    addOnce(station.tags, tag);
    if (port !== undefined) station.port = port;
    return undefined;
  }
  // The name is a community: it is not kept
  const group = version === '1' ? 'traps_v1' : 'traps_v2';
  addOnce(named<SnmpTrapGroup>(snmp.trapGroups, group, () => ({ name: group, version: version === '1' ? 'v1' : 'v2', targets: [], categories: [] })).targets, address);
  if (port !== undefined && port !== 162) target.report.warning('snmp-trap-port', 'SNMP: a trap group has no port, the traps of versions 1 and 2c go to port 162');
  return undefined;
}

export const ciscoSnmpRules = new RuleTable<CiscoSnmp>(
  [
    rule('location <text...>', ({ snmp }, m) => {
      snmp.location = m.text;
    }),
    rule('contact <text...>', ({ snmp }, m) => {
      snmp.contact = m.text;
    }),

    // Version 2c: "snmp-server community <community> [view <view>] [RO | RW] [<access list>]"
    rule('community <community> ...', (target, m, statement) => {
      let options = m.rest === '' ? [] : m.rest.split(' ');
      // "snmp-server community 7 <text>": the community is encrypted, it cannot be copied
      const encrypted = ENCRYPTION_TYPES.includes(m.community) && options.length > 0 && options[0].length >= 10 && !COMMUNITY_OPTIONS.includes(options[0].toLowerCase());
      const community = communityOf(target.snmp, encrypted ? options[0] : m.community, statement.line);
      if (encrypted) {
        community.encrypted = true;
        options = options.slice(1);
      }
      for (let index = 0; index < options.length; index++) {
        const option = options[index].toLowerCase();
        if (option === 'view') community.view = options[++index];
        else if (option === 'ro') community.authorization = 'read-only';
        else if (option === 'rw') community.authorization = 'read-write';
        // The access list of IPv6 comes after the word, a client list has one list
        else if (option === 'ipv6') index += 1;
        else target.communityLists.push({ community, list: options[index], line: statement.line });
      }
    }),
    rule('view <name> <oid> <action>', ({ snmp }, m) => {
      const action = m.action.toLowerCase();
      if (action !== 'included' && action !== 'excluded') return false;
      snmp.views.push({ name: m.name, oid: OID_NAMES[m.oid.toLowerCase()] ?? m.oid, include: action === 'included' });
      return undefined;
    }),

    // Traps
    rule('host <address> ...', (target, m) => readHost(target, m.address, m.rest === '' ? [] : m.rest.split(' '))),
    rule('enable traps ...', (target, m) => {
      const [kind, ...details] = m.rest.toLowerCase().split(' ');
      if (kind === '') target.trapKinds = 'all';
      if (target.trapKinds === 'all') return;
      // "snmp-server enable traps snmp authentication linkdown linkup": the kinds are the words after "snmp"
      const categories = kind === 'snmp' ? (details.length > 0 ? details : Object.keys(SNMP_KINDS)).map((detail) => SNMP_KINDS[detail]) : [KIND_CATEGORIES[kind]];
      const known = categories.filter((category): category is string => category !== undefined);
      known.forEach((category) => addOnce(target.trapKinds as string[], category));
      if (known.length === 0) target.unknownKinds += 1;
    }),

    // Version 3: "snmp-server group <group> v3 <level> [read <view>] [write <view>] [notify <view>]"
    rule('group <group> v3 <level> ...', ({ snmp }, m) => {
      const level = LEVELS[m.level.toLowerCase()];
      if (level === undefined) return false;
      const options = m.rest.split(' ');
      const context = optionAfter(options, 'context');
      const access: SnmpAccess = { group: m.group, model: 'usm', level, ...(context === undefined ? {} : { contextPrefix: context }) };
      // Without "read", a group reads the default view of the switch
      access.readView = optionAfter(options, 'read') ?? DEFAULT_VIEW;
      access.writeView = optionAfter(options, 'write');
      access.notifyView = optionAfter(options, 'notify');
      addOnce(snmp.access, access, (a, b) => a.group === b.group && a.level === b.level && a.contextPrefix === b.contextPrefix);
      return undefined;
    }),
    // "snmp-server user <user> <group> v3 [encrypted] [auth md5 | sha <password> [priv des | 3des | aes 128 <password>]]"
    rule('user <user> <group> v3 ...', (target, m) => {
      const options = m.rest === '' ? [] : m.rest.split(' ');
      const lower = options.map((option) => option.toLowerCase());
      const user: SnmpUser = { name: m.user, authentication: 'none', privacy: 'none' };
      // After "encrypted", what follows the algorithms are keys, which cannot be copied
      const clear = !lower.includes('encrypted');
      const auth = lower.indexOf('auth');
      if (auth >= 0) {
        const algorithm = lower[auth + 1];
        // "auth sha-2 256": the size follows
        const size = algorithm === 'sha-2' ? lower[auth + 2] : '';
        const password = options[auth + (algorithm === 'sha-2' ? 3 : 2)];
        if (clear && password !== undefined) user.authenticationPassword = password;
        if (algorithm === 'md5') user.authentication = 'md5';
        else if (algorithm === 'sha') user.authentication = 'sha';
        else if (algorithm === 'sha-2' && ['224', '256', '384', '512'].includes(size)) user.authentication = `sha${size}` as SnmpUser['authentication'];
        else return false;
      }
      const priv = lower.indexOf('priv');
      if (priv >= 0) {
        const algorithm = lower[priv + 1];
        const password = options[priv + (algorithm === 'aes' ? 3 : 2)];
        if (clear && password !== undefined) user.privacyPassword = password;
        if (algorithm === 'des') user.privacy = 'des';
        else if (algorithm === '3des') user.privacy = '3des';
        else if (algorithm === 'aes') {
          user.privacy = 'aes128';
          if (lower[priv + 2] !== '128') target.report.warning('snmp-privacy', 'SNMP version 3: the template has AES with 128 bits only, it is used in place of AES with 192 or 256 bits');
        } else return false;
      }
      addOnce(target.snmp.users, user, (a, b) => a.name === b.name);
      addOnce(target.snmp.securityToGroup, { model: 'usm', securityName: m.user, group: m.group }, (a, b) => a.securityName === b.securityName);
      return undefined;
    }),
  ],
  { ignoreCase: true },
);

/** Once the whole file is read: the client lists of the communities, the categories of the trap groups. */
export function finishCiscoSnmp(target: CiscoSnmp): void {
  const { snmp, report } = target;
  for (const { community, list, line } of target.communityLists) {
    const accessList = target.accessLists.get(list);
    if (!accessList) {
      report.warning('snmp-access-list', 'SNMP: the access list of a community is not a standard access list of the file. The community has no client list: every station can use it', [line]);
      continue;
    }
    if (!accessList.exact) report.warning('snmp-access-list', 'SNMP: the access list of a community has entries that a client list cannot say ("deny", a mask with holes). Check the client list', [line]);
    const name = `acl_${list}`;
    named(snmp.clientLists, name, () => ({ name, clients: [...accessList.prefixes] }));
    community.clientList = name;
  }

  if (target.trapKinds !== 'all') for (const group of snmp.trapGroups) group.categories = [...target.trapKinds];
  if (target.unknownKinds > 0 && snmp.trapGroups.length > 0) {
    report.info('snmp-trap-kinds', `SNMP: ${target.unknownKinds} kind${target.unknownKinds === 1 ? '' : 's'} of traps of "snmp-server enable traps" have no category in Junos and are left out`);
  }

  // The view that a group reads when it names none
  if (snmp.access.some((access) => access.readView === DEFAULT_VIEW) && !snmp.views.some((view) => view.name === DEFAULT_VIEW)) {
    snmp.views.push({ name: DEFAULT_VIEW, oid: '.1', include: true });
  }
  if (snmp.access.length > 0 && snmp.users.length === 0) {
    report.info('snmp-users', 'SNMP version 3: the file has groups and no user. A running configuration does not show the users ("show snmp user" does): add them to the template');
  }
}

/** True for the number of a standard access list. */
export function isStandardAccessList(id: string): boolean {
  const number = /^\d+$/.test(id) ? Number(id) : -1;
  return (number >= 1 && number <= 99) || (number >= 1300 && number <= 1999);
}

/** The entries of "ip access-list standard <name>". */
export function readAccessListBlock(target: CiscoSnmp, name: string, statement: Statement): void {
  for (const child of statement.children) readAccessListEntry(target, name, child.words);
}
