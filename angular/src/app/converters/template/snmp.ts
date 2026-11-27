/**
 * SNMP of the template, from the SNMP of the devices.
 *
 * A template has one SNMP configuration for all its switches: what the files define
 * under the same name is taken from the first file that defines it.
 *
 * A community is the password of version 2c. Unless the user asks for the secrets in
 * clear text to be copied, it is replaced by a placeholder with a number, the same number
 * for the same community in every file. The passwords of the users of version 3 are
 * placeholders too: a running configuration only has their keys, which cannot be copied.
 */
import { Device, Snmp } from '../model';
import { Report } from '../report';
import { MistSnmpAccess, MistSnmpConfig, MistSnmpV3Config, SECRET_PLACEHOLDER } from './mist';

/** The name of the option in the page. */
const COPY_OPTION = 'Copy the SNMP secrets that are in clear text';

/** A list with what each device adds to it, each key once. */
function merged<S, T>(devices: Snmp[], listOf: (snmp: Snmp) => S[], keyOf: (entry: S) => string, convert: (entry: S) => T): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const entry of devices.flatMap(listOf)) {
    if (seen.has(keyOf(entry))) continue;
    seen.add(keyOf(entry));
    result.push(convert(entry));
  }
  return result;
}

/** An object without its undefined properties and its empty lists. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, property]) => property !== undefined && !(Array.isArray(property) && property.length === 0))) as T;
}

export function buildSnmp(devices: Device[], report: Report, copyClearTextSecrets: boolean): MistSnmpConfig | undefined {
  const withSnmp = devices.filter((device) => device.system.snmp !== undefined);
  const all = withSnmp.map((device) => device.system.snmp as Snmp);
  if (all.length === 0) return undefined;

  // What says where a switch is belongs to the template only when the files agree on it.
  const shared = (label: string, valueOf: (snmp: Snmp) => string | undefined): string | undefined => {
    const values = [...new Set(all.map(valueOf).filter((value): value is string => value !== undefined))];
    if (values.length > 1) report.info('snmp-differs', `SNMP: the files have different ${label}s, the template has none. Set it on each switch`);
    return values.length === 1 ? values[0] : undefined;
  };

  // The same community gets the same placeholder in every file.
  const names = new Map<string, string>();
  let copied = 0;
  for (const device of withSnmp) {
    const fileReport = report.forFile(device.file);
    for (const community of device.system.snmp?.communities ?? []) {
      if (copyClearTextSecrets && !community.encrypted) {
        if (!names.has(community.community)) copied += 1;
        names.set(community.community, community.community);
        continue;
      }
      if (!names.has(community.community)) names.set(community.community, `${SECRET_PLACEHOLDER}_${names.size - copied + 1}`);
      const how = community.encrypted ? 'The file has it encrypted: type it in the template' : `A community is a password: type it in the template, or turn on "${COPY_OPTION}"`;
      fileReport.info('snmp-community', `SNMP: the community of this line is "${names.get(community.community)}" in the template. ${how}`, [community.line]);
    }
  }
  if (copied > 0) report.warning('secrets-copied', `SNMP: ${copied} communit${copied === 1 ? 'y is' : 'ies are'} copied into the template in clear text, as asked. Mind who gets the template`);

  const users = merged(all, (snmp) => snmp.users, (user) => `${user.remoteEngineId ?? ''} ${user.name}`, (user) => user);
  const passwordOf = (password: string | undefined): string => (copyClearTextSecrets && password !== undefined ? password : SECRET_PLACEHOLDER);
  const missing = users.filter((user) => (user.authentication !== 'none' && passwordOf(user.authenticationPassword) === SECRET_PLACEHOLDER) || (user.privacy !== 'none' && passwordOf(user.privacyPassword) === SECRET_PLACEHOLDER)).length;
  if (missing > 0) {
    const inClear = users.some((user) => user.authenticationPassword !== undefined || user.privacyPassword !== undefined);
    const how = inClear ? `type them there, or turn on "${COPY_OPTION}" for those that a file has in clear text` : 'a configuration only has their keys, type them there';
    report.info('snmp-passwords', `SNMP version 3: the passwords of ${missing} user${missing === 1 ? '' : 's'} are "${SECRET_PLACEHOLDER}" in the template: ${how}`);
  }
  const copiedUsers = users.filter((user) => copyClearTextSecrets && (user.authenticationPassword !== undefined || user.privacyPassword !== undefined)).length;
  if (copiedUsers > 0) report.warning('secrets-copied', `SNMP version 3: the passwords of ${copiedUsers} user${copiedUsers === 1 ? '' : 's'} are copied into the template in clear text, as asked. Mind who gets the template`);
  const engines = [...new Set(users.map((user) => user.remoteEngineId))];
  const usm = engines.map((engine) => ({
    engine_type: engine === undefined ? ('local_engine' as const) : ('remote_engine' as const),
    ...(engine === undefined ? {} : { remote_engine_id: engine }),
    users: users
      .filter((user) => user.remoteEngineId === engine)
      .map((user) => ({
        name: user.name,
        authentication_type: `authentication-${user.authentication}`,
        ...(user.authentication === 'none' ? {} : { authentication_password: passwordOf(user.authenticationPassword) }),
        encryption_type: `privacy-${user.privacy}`,
        ...(user.privacy === 'none' ? {} : { encryption_password: passwordOf(user.privacyPassword) }),
      })),
  }));

  // Mist has one security model for the groups of the users: the one of version 3.
  const toGroup = merged(all, (snmp) => snmp.securityToGroup, (entry) => `${entry.model} ${entry.securityName}`, (entry) => entry);
  const usmGroups = toGroup.filter((entry) => entry.model === 'usm');
  if (usmGroups.length < toGroup.length) report.info('snmp-security-model', 'SNMP: the groups of the security names of versions 1 and 2c are left out, the template has those of version 3');
  const access = merged(all, (snmp) => snmp.access, (entry) => `${entry.group} ${entry.contextPrefix ?? ''} ${entry.model} ${entry.level}`, (entry) => entry);
  const accessGroups = [...new Set(access.map((entry) => entry.group))].map((group) => ({
    group_name: group,
    prefix_list: access
      .filter((entry) => entry.group === group)
      .map(
        (entry): MistSnmpAccess =>
          compact({
            type: entry.contextPrefix === undefined ? 'default_context_prefix' : 'context_prefix',
            context_prefix: entry.contextPrefix,
            security_model: entry.model,
            security_level: entry.level,
            read_view: entry.readView,
            write_view: entry.writeView,
            notify_view: entry.notifyView,
          }),
      ),
  }));
  const vacm = compact({
    security_to_group: usmGroups.length > 0 ? { security_model: 'usm', content: usmGroups.map((entry) => ({ security_name: entry.securityName, group: entry.group })) } : undefined,
    access: accessGroups,
  });

  const v3: MistSnmpV3Config = compact({
    usm,
    vacm: Object.keys(vacm).length > 0 ? vacm : undefined,
    notify: merged(all, (snmp) => snmp.notifies, (entry) => entry.name, (entry) => compact({ name: entry.name, tag: entry.tag, type: entry.type })),
    notify_filter: merged(all, (snmp) => snmp.notifyFilters, (entry) => entry.name, (entry) => ({ profile_name: entry.name, contents: entry.contents })),
    target_address: merged(
      all,
      // A target without an address is not one
      (snmp) => snmp.targets.filter((target) => target.address !== undefined),
      (entry) => entry.name,
      (entry) => compact({ target_address_name: entry.name, address: entry.address ?? '', address_mask: entry.mask, port: String(entry.port ?? 162), tag_list: entry.tags.length > 0 ? entry.tags.join(' ') : undefined, target_parameters: entry.parameters }),
    ),
    target_parameters: merged(all, (snmp) => snmp.targetParameters, (entry) => entry.name, (entry) =>
      compact({ name: entry.name, message_processing_model: entry.processing, security_model: entry.model, security_level: entry.level, security_name: entry.securityName, notify_filter: entry.notifyFilter }),
    ),
  });

  return compact({
    enabled: true,
    contact: shared('contact', (snmp) => snmp.contact),
    description: shared('description', (snmp) => snmp.description),
    location: shared('location', (snmp) => snmp.location),
    engine_id_type: all.some((snmp) => snmp.engineIdFromMac) ? ('use_mac_address' as const) : undefined,
    client_list: merged(all, (snmp) => snmp.clientLists, (entry) => entry.name, (entry) => ({ client_list_name: entry.name, clients: entry.clients })),
    views: merged(all, (snmp) => snmp.views, (entry) => `${entry.name} ${entry.oid}`, (entry) => ({ view_name: entry.name, oid: entry.oid, include: entry.include })),
    v2c_config: merged(all, (snmp) => snmp.communities, (entry) => entry.community, (entry) =>
      compact({ community_name: names.get(entry.community) ?? SECRET_PLACEHOLDER, authorization: entry.authorization, client_list_name: entry.clientList, view: entry.view }),
    ),
    trap_groups: merged(all, (snmp) => snmp.trapGroups, (entry) => entry.name, (entry) => ({ group_name: entry.name, version: entry.version, targets: entry.targets, categories: entry.categories })),
    v3_config: Object.keys(v3).length > 0 ? v3 : undefined,
  });
}
