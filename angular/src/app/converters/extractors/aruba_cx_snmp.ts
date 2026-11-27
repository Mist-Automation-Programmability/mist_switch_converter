/**
 * SNMP of an Aruba AOS-CX configuration: the commands that start with "snmp-server" and
 * with "snmpv3", without that word.
 *
 * A Mist template describes SNMP as Junos does. What AOS-CX says differently is
 * translated here:
 *   - "snmp-server host" becomes a trap group for versions 1 and 2c, and a target with
 *     its parameters for version 3;
 *   - the kinds of notifications of a host become the categories of Junos;
 *   - a user of version 3 has no group on AOS-CX and needs one in Junos: the users are
 *     put in one group that reads everything.
 *
 * The community that a host line carries is not read: Junos sends the name of the
 * trap group in its place. The access list of a community is not read either.
 */
import { addOnce, named, Snmp, SnmpCommunity, SnmpSecurityLevel, SnmpUser } from '../model';
import { commandKey, Report } from '../report';
import { Statement } from '../readers/statement';
import { ignore, rule, RuleTable } from './rules';
import { addV3Target, TRAP_PORT_WARNING, trapGroupFor } from './snmp_targets';
import { isIpAddress } from './values';

interface Host {
  address: string;
  type: 'trap' | 'inform';
  version: 'v1' | 'v2c' | 'v3';
  user?: string;
  port?: number;
  /** The kinds of notifications that the station asks for. None means all of them. */
  kinds: string[];
}

export interface ArubaSnmp {
  snmp: Snmp;
  report: Report;
  hosts: Host[];
  /** The users of version 3 that may write. */
  writers: Set<string>;
}

export function newArubaSnmp(snmp: Snmp, report: Report): ArubaSnmp {
  return { snmp, report, hosts: [], writers: new Set() };
}

/** The group and the view that the users of version 3 are given. */
const READ_GROUP = 'snmpv3_ro';
const WRITE_GROUP = 'snmpv3_rw';
const ALL_VIEW = 'all';

/** The categories of Junos for the kinds of notifications of AOS-CX. */
const KIND_CATEGORIES: Record<string, string> = {
  interface: 'link',
  config: 'configuration',
  bgp: 'routing',
  ospf: 'routing',
  ospfv3: 'routing',
  vrrp: 'vrrp-events',
  rmon: 'rmon-alarm',
  card: 'chassis',
  entity: 'chassis',
  fan: 'chassis',
  power: 'chassis',
  'power-ethernet': 'chassis',
  temperature: 'chassis',
  vsf: 'chassis',
};

const AUTHENTICATIONS: Record<string, SnmpUser['authentication']> = { md5: 'md5', sha: 'sha', sha224: 'sha224', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512' };
const PRIVACIES: Record<string, SnmpUser['privacy']> = { des: 'des', aes: 'aes128', aes192: 'aes128', aes256: 'aes128' };

const NO_KEYWORDS: ReadonlySet<string> = new Set();

/* --------------------------------------------------------------- community */

const communityRules = new RuleTable<{ community: SnmpCommunity; target: ArubaSnmp }>(
  [
    rule('access-level <level>', ({ community }, m) => {
      if (m.level !== 'ro' && m.level !== 'rw') return false;
      community.authorization = m.level === 'rw' ? 'read-write' : 'read-only';
      return undefined;
    }),
    // "access-list ip <name>", "access-list <name>"
    rule('access-list ...', ({ target }, _m, statement) => {
      target.report.warning('snmp-access-list', 'SNMP: the access list of a community is not converted. The community has no client list: every station can use it', [statement.line]);
    }),
  ],
  { otherwise: [ignore('no ...')] },
);

/* ------------------------------------------------------------------- hosts */

/** "snmp-server host <address> trap|inform version v1|v2c|v3 [community <text>] [user <name>] [port <n>] [vrf <name>] [notification-type <kinds>]". */
function readHost(target: ArubaSnmp, address: string, words: string[]): void | false {
  const [type, keyword, version] = words;
  if (!isIpAddress(address) || (type !== 'trap' && type !== 'inform') || keyword !== 'version' || (version !== 'v1' && version !== 'v2c' && version !== 'v3')) return false;
  const host: Host = { address, type, version, kinds: [] };
  for (let index = 3; index < words.length; index++) {
    const word = words[index];
    // The community is a secret, and it is not what Junos sends.
    if (word === 'community' || word === 'vrf') index += 1;
    else if (word === 'user') host.user = words[++index];
    else if (word === 'port') {
      const port = words[++index] ?? '';
      if (/^\d+$/.test(port)) host.port = Number(port);
    } else if (word === 'notification-type') {
      host.kinds = words.slice(index + 1);
      break;
    }
  }
  if (version === 'v3' && host.user === undefined) return false;
  target.hosts.push(host);
  return undefined;
}

/* ------------------------------------------------------------------- rules */

/** The commands that start with "snmp-server", without that word. */
export const arubaSnmpServerRules = new RuleTable<ArubaSnmp>([
  rule('system-location <text...>', ({ snmp }, m) => {
    snmp.location = m.text;
  }),
  rule('system-contact <text...>', ({ snmp }, m) => {
    snmp.contact = m.text;
  }),
  rule('system-description <text...>', ({ snmp }, m) => {
    snmp.description = m.text;
  }),
  // A community is a block: its access level and its access list are the lines under it.
  rule('community <community>', (target, m, statement) => {
    let community = target.snmp.communities.find((candidate) => candidate.community === m.community);
    if (!community) {
      community = { community: m.community, authorization: 'read-only', line: statement.line };
      target.snmp.communities.push(community);
    }
    for (const child of statement.children) {
      if (communityRules.apply({ community, target }, child) === 'unknown') target.report.notConverted(`snmp-server community: ${commandKey(child.words, NO_KEYWORDS)}`, child.line);
    }
  }),
  rule('host <address> ...', (target, m) => readHost(target, m.address, m.rest === '' ? [] : m.rest.split(' '))),
  // Where the agent listens, and that it refuses versions 1 and 2c: settings of the switch, not of the template
  ignore('vrf <name>', 'agent-port <port>', 'snmpv3-only'),
]);

/** "snmpv3 user <name> [auth <protocol> auth-pass plaintext|ciphertext <password> [priv <protocol> priv-pass plaintext|ciphertext <password>]]". */
function readUser(target: ArubaSnmp, name: string, options: string[]): void | false {
  const user: SnmpUser = target.snmp.users.find((candidate) => candidate.name === name) ?? { name, authentication: 'none', privacy: 'none' };
  /** A password that the file has in clear text. A ciphertext cannot be copied. */
  const passwordAt = (index: number): string | undefined => (options[index] === 'plaintext' ? options[index + 1] : undefined);
  let weakerPrivacy = false;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (option === 'auth') {
      const authentication = AUTHENTICATIONS[options[++index] ?? ''];
      if (authentication === undefined) return false;
      user.authentication = authentication;
    } else if (option === 'priv') {
      const protocol = options[++index] ?? '';
      if (PRIVACIES[protocol] === undefined) return false;
      user.privacy = PRIVACIES[protocol];
      weakerPrivacy = protocol === 'aes192' || protocol === 'aes256';
    } else if (option === 'auth-pass' || option === 'priv-pass') {
      const password = passwordAt(index + 1);
      if (password !== undefined && option === 'auth-pass') user.authenticationPassword = password;
      if (password !== undefined && option === 'priv-pass') user.privacyPassword = password;
      // The keyword, then the password, are not options
      index += ['plaintext', 'ciphertext'].includes(options[index + 1] ?? '') ? 2 : 1;
    } else if (option === 'access-level') {
      if (options[++index] === 'rw') target.writers.add(name);
    } else if (option === 'context') index += 1;
    else return false;
  }
  if (weakerPrivacy) target.report.warning('snmp-privacy', 'SNMP version 3: the template has AES with 128 bits only, it is used in place of AES with 192 or 256 bits');
  addOnce(target.snmp.users, user, (a, b) => a.name === b.name);
  return undefined;
}

/** The commands that start with "snmpv3", without that word. */
export const arubaSnmpv3Rules = new RuleTable<ArubaSnmp>([
  rule('user <name> ...', (target, m) => readUser(target, m.name, m.rest === '' ? [] : m.rest.split(' '))),
  // The engine id belongs to one switch. A context ties a community to a VRF.
  ignore('engine-id <id>', 'context ...'),
]);

/** Runs a command on one of the two tables. `statement` is the command with its first word. */
export function readArubaSnmp(target: ArubaSnmp, table: RuleTable<ArubaSnmp>, statement: Statement): void | false {
  return table.apply(target, { ...statement, words: statement.words.slice(1) }) === 'unknown' ? false : undefined;
}

/* --------------------------------------------------------------- finishing */

function levelOf(user: SnmpUser | undefined): SnmpSecurityLevel {
  if (user === undefined || user.authentication === 'none') return 'none';
  return user.privacy === 'none' ? 'authentication' : 'privacy';
}

/** Once the whole file is read: the groups of the users, the stations and their categories. */
export function finishArubaSnmp(target: ArubaSnmp): void {
  const { snmp, report } = target;

  // Junos gives its rights to a group, and a user to a group.
  for (const user of snmp.users) {
    const writer = target.writers.has(user.name);
    const group = writer ? WRITE_GROUP : READ_GROUP;
    addOnce(snmp.securityToGroup, { model: 'usm', securityName: user.name, group }, (a, b) => a.securityName === b.securityName);
    addOnce(snmp.access, { group, model: 'usm', level: levelOf(user), readView: ALL_VIEW, ...(writer ? { writeView: ALL_VIEW } : {}) }, (a, b) => a.group === b.group && a.level === b.level);
    named(snmp.views, ALL_VIEW, () => ({ name: ALL_VIEW, oid: '.1', include: true }));
  }

  let unknownKinds = 0;
  /** The groups whose stations do not all say which kinds of notifications they want: they get all of them. */
  const unrestricted = new Set<string>();
  for (const host of target.hosts) {
    if (host.version === 'v3') {
      const user = host.user as string;
      addV3Target(snmp, { address: host.address, type: host.type, user, level: levelOf(snmp.users.find((candidate) => candidate.name === user)), port: host.port });
      continue;
    }
    const group = trapGroupFor(snmp, host.version === 'v1' ? 'v1' : 'v2', host.address);
    if (host.port !== undefined && host.port !== 162) report.warning('snmp-trap-port', TRAP_PORT_WARNING);
    const categories = host.kinds.map((kind) => KIND_CATEGORIES[kind]).filter((category): category is string => category !== undefined);
    unknownKinds += host.kinds.length - categories.length;
    if (categories.length === 0) unrestricted.add(group.name);
    else categories.forEach((category) => addOnce(group.categories, category));
  }
  for (const group of snmp.trapGroups) if (unrestricted.has(group.name)) group.categories = [];
  if (unknownKinds > 0) {
    report.info('snmp-trap-kinds', `SNMP: ${unknownKinds} kind${unknownKinds === 1 ? '' : 's'} of notifications of "snmp-server host" have no category in Junos and are left out`);
  }
}
