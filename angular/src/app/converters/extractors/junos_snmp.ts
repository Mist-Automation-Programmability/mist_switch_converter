/**
 * SNMP of a Junos configuration: the statements under "snmp", without that word.
 *
 * A Mist template describes SNMP as Junos does, so most statements are copied field by
 * field. Two things are not: the passwords of the users of version 3, of which the
 * file only has the keys, and what belongs to one switch (its name, a local engine id).
 */
import { addOnce, named, Snmp, SnmpAccess, SnmpCommunity, SnmpNotify, SnmpNotifyFilter, SnmpSecurityLevel, SnmpSecurityModel, SnmpTargetAddress, SnmpTargetParameters, SnmpTrapGroup, SnmpUser } from '../model';
import { rule, RuleTable } from './rules';

const AUTHENTICATION: Record<string, SnmpUser['authentication']> = {
  'authentication-none': 'none',
  'authentication-md5': 'md5',
  'authentication-sha': 'sha',
  'authentication-sha224': 'sha224',
  'authentication-sha256': 'sha256',
  'authentication-sha384': 'sha384',
  'authentication-sha512': 'sha512',
};
const PRIVACY: Record<string, SnmpUser['privacy']> = { 'privacy-none': 'none', 'privacy-des': 'des', 'privacy-3des': '3des', 'privacy-aes128': 'aes128' };
const MODELS = ['usm', 'v1', 'v2c'];
const LEVELS = ['none', 'authentication', 'privacy'];

function userOf(snmp: Snmp, name: string, remoteEngineId?: string): SnmpUser {
  let user = snmp.users.find((candidate) => candidate.name === name && candidate.remoteEngineId === remoteEngineId);
  if (!user) {
    user = { name, authentication: 'none', privacy: 'none', ...(remoteEngineId === undefined ? {} : { remoteEngineId }) };
    snmp.users.push(user);
  }
  return user;
}

/**
 * "authentication-sha authentication-key ..." or "privacy-aes128 privacy-key ...". A key cannot be
 * copied. A script that creates the user has "authentication-password ..." in clear text.
 */
function readUserOption(user: SnmpUser, option: string, rest: string): void | false {
  const [keyword, value] = rest.split(' ');
  if (option in AUTHENTICATION) {
    user.authentication = AUTHENTICATION[option];
    if (keyword === 'authentication-password' && value !== undefined) user.authenticationPassword = value;
  } else if (option in PRIVACY) {
    user.privacy = PRIVACY[option];
    if (keyword === 'privacy-password' && value !== undefined) user.privacyPassword = value;
  } else return false;
  return undefined;
}

/** "security-model usm security-level privacy read-view all": the entry of a group for a model and a level, and one of its views. */
function readAccess(snmp: Snmp, group: string, contextPrefix: string | undefined, words: string[]): void | false {
  const [modelWord, model, levelWord, level, viewWord, view] = words;
  if (modelWord !== 'security-model' || levelWord !== 'security-level' || ![...MODELS, 'any'].includes(model) || !LEVELS.includes(level)) return false;
  let access = snmp.access.find((entry) => entry.group === group && entry.contextPrefix === contextPrefix && entry.model === model && entry.level === level);
  if (!access) {
    access = { group, model: model as SnmpAccess['model'], level: level as SnmpSecurityLevel, ...(contextPrefix === undefined ? {} : { contextPrefix }) };
    snmp.access.push(access);
  }
  if (viewWord === undefined) return undefined;
  if (view === undefined) return false;
  if (viewWord === 'read-view') access.readView = view;
  else if (viewWord === 'write-view') access.writeView = view;
  else if (viewWord === 'notify-view') access.notifyView = view;
  else return false;
  return undefined;
}

function readParameter(parameters: SnmpTargetParameters, option: string, value: string): void | false {
  if (option === 'message-processing-model' && ['v1', 'v2c', 'v3'].includes(value)) parameters.processing = value as SnmpTargetParameters['processing'];
  else if (option === 'security-model' && MODELS.includes(value)) parameters.model = value as SnmpSecurityModel;
  else if (option === 'security-level' && LEVELS.includes(value)) parameters.level = value as SnmpSecurityLevel;
  else if (option === 'security-name') parameters.securityName = value;
  else return false;
  return undefined;
}

const trapGroupOf = (snmp: Snmp, name: string): SnmpTrapGroup => named(snmp.trapGroups, name, () => ({ name, version: 'all', targets: [], categories: [] }));
const targetOf = (snmp: Snmp, name: string): SnmpTargetAddress => named(snmp.targets, name, () => ({ name, tags: [] }));
const parametersOf = (snmp: Snmp, name: string): SnmpTargetParameters => named(snmp.targetParameters, name, () => ({ name }));
const notifyOf = (snmp: Snmp, name: string): SnmpNotify => named(snmp.notifies, name, () => ({ name, type: 'trap' }));
const filterOf = (snmp: Snmp, name: string): SnmpNotifyFilter => named(snmp.notifyFilters, name, () => ({ name, contents: [] }));

export const junosSnmpRules = new RuleTable<Snmp>([
  rule('location <text...>', (snmp, m) => {
    snmp.location = m.text;
  }),
  rule('contact <text...>', (snmp, m) => {
    snmp.contact = m.text;
  }),
  rule('description <text...>', (snmp, m) => {
    snmp.description = m.text;
  }),
  rule('engine-id use-mac-address', (snmp) => {
    snmp.engineIdFromMac = true;
  }),

  // Version 2c
  rule('client-list <name> <prefix>', (snmp, m) => addOnce(named(snmp.clientLists, m.name, () => ({ name: m.name, clients: [] })).clients, m.prefix)),
  rule('community <community>', (snmp, m, statement) => {
    communityOf(snmp, m.community, statement.line);
  }),
  rule('community <community> authorization <authorization>', (snmp, m, statement) => {
    if (m.authorization !== 'read-only' && m.authorization !== 'read-write') return false;
    communityOf(snmp, m.community, statement.line).authorization = m.authorization;
    return undefined;
  }),
  rule('community <community> client-list-name <list>', (snmp, m, statement) => {
    communityOf(snmp, m.community, statement.line).clientList = m.list;
  }),
  // The stations written under the community itself: they become a client list
  rule('community <community> clients <prefix> ...', (snmp, m, statement) => {
    // "clients 10.0.0.0/8 restrict" takes a prefix out of the list: a client list cannot say that
    if (m.rest !== '') return false;
    const community = communityOf(snmp, m.community, statement.line);
    const name = (community.clientList ??= `community_${snmp.communities.indexOf(community) + 1}_clients`);
    addOnce(named(snmp.clientLists, name, () => ({ name, clients: [] })).clients, m.prefix);
    return undefined;
  }),
  rule('community <community> view <view>', (snmp, m, statement) => {
    communityOf(snmp, m.community, statement.line).view = m.view;
  }),
  rule('view <name> oid <oid>', (snmp, m) => {
    snmp.views.push({ name: m.name, oid: m.oid, include: true });
  }),
  rule('view <name> oid <oid> <action>', (snmp, m) => {
    if (m.action !== 'include' && m.action !== 'exclude') return false;
    snmp.views.push({ name: m.name, oid: m.oid, include: m.action === 'include' });
    return undefined;
  }),
  rule('trap-group <name>', (snmp, m) => {
    trapGroupOf(snmp, m.name);
  }),
  rule('trap-group <name> version <version>', (snmp, m) => {
    if (m.version !== 'v1' && m.version !== 'v2' && m.version !== 'all') return false;
    trapGroupOf(snmp, m.name).version = m.version;
    return undefined;
  }),
  rule('trap-group <name> targets <address>', (snmp, m) => addOnce(trapGroupOf(snmp, m.name).targets, m.address)),
  rule('trap-group <name> categories <category> ...', (snmp, m) => addOnce(trapGroupOf(snmp, m.name).categories, m.category)),

  // Version 3: users, groups and what the groups may see
  rule('v3 usm local-engine user <user>', (snmp, m) => {
    userOf(snmp, m.user);
  }),
  rule('v3 usm local-engine user <user> <option> ...', (snmp, m) => readUserOption(userOf(snmp, m.user), m.option, m.rest)),
  rule('v3 usm remote-engine <engine> user <user> <option> ...', (snmp, m) => readUserOption(userOf(snmp, m.user, m.engine), m.option, m.rest)),
  rule('v3 vacm security-to-group security-model <model> security-name <name> group <group>', (snmp, m) => {
    if (!MODELS.includes(m.model)) return false;
    addOnce(snmp.securityToGroup, { model: m.model as SnmpSecurityModel, securityName: m.name, group: m.group }, (a, b) => a.model === b.model && a.securityName === b.securityName);
    return undefined;
  }),
  rule('v3 vacm access group <group> default-context-prefix ...', (snmp, m, statement) => readAccess(snmp, m.group, undefined, statement.words.slice(6))),
  rule('v3 vacm access group <group> context-prefix <prefix> ...', (snmp, m, statement) => readAccess(snmp, m.group, m.prefix, statement.words.slice(7))),

  // Version 3: where the notifications go
  rule('v3 target-address <name> address <address>', (snmp, m) => {
    targetOf(snmp, m.name).address = m.address;
  }),
  rule('v3 target-address <name> address-mask <mask>', (snmp, m) => {
    targetOf(snmp, m.name).mask = m.mask;
  }),
  rule('v3 target-address <name> port <port>', (snmp, m) => {
    if (!/^\d+$/.test(m.port)) return false;
    targetOf(snmp, m.name).port = Number(m.port);
    return undefined;
  }),
  rule('v3 target-address <name> tag-list <tags...>', (snmp, m) => {
    for (const tag of m.tags.split(/\s+/)) addOnce(targetOf(snmp, m.name).tags, tag);
  }),
  rule('v3 target-address <name> target-parameters <parameters>', (snmp, m) => {
    targetOf(snmp, m.name).parameters = m.parameters;
  }),
  rule('v3 target-parameters <name> parameters <option> <value>', (snmp, m) => readParameter(parametersOf(snmp, m.name), m.option, m.value)),
  rule('v3 target-parameters <name> notify-filter <filter>', (snmp, m) => {
    parametersOf(snmp, m.name).notifyFilter = m.filter;
  }),
  rule('v3 notify <name> type <type>', (snmp, m) => {
    if (m.type !== 'trap' && m.type !== 'inform') return false;
    notifyOf(snmp, m.name).type = m.type;
    return undefined;
  }),
  rule('v3 notify <name> tag <tag>', (snmp, m) => {
    notifyOf(snmp, m.name).tag = m.tag;
  }),
  rule('v3 notify-filter <name> oid <oid>', (snmp, m) => {
    filterOf(snmp, m.name).contents.push({ oid: m.oid, include: true });
  }),
  rule('v3 notify-filter <name> oid <oid> <action>', (snmp, m) => {
    if (m.action !== 'include' && m.action !== 'exclude') return false;
    filterOf(snmp, m.name).contents.push({ oid: m.oid, include: m.action === 'include' });
    return undefined;
  }),
]);

function communityOf(snmp: Snmp, community: string, line: number): SnmpCommunity {
  let entry = snmp.communities.find((candidate) => candidate.community === community);
  if (!entry) {
    // Without "authorization", a community can only read
    entry = { community, authorization: 'read-only', line };
    snmp.communities.push(entry);
  }
  return entry;
}

