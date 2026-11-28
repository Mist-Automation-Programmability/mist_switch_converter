/**
 * Invariants: rules that every exported template must respect, whatever the input.
 * A check returns one line per violation; an empty list means the rule holds.
 *
 * They are checked on every fixture (`invariants.test.ts`) and counted on the local
 * configurations of `test_configs` (`local-configs.test.ts`).
 */
import { Conversion, endpoints, missingNetworks, PortUsage } from './harness';

export type Check = (result: Conversion) => string[];

// Two rules below are assumptions to confirm against the Mist API:
//  - names of networks and port usages accept letters, digits, "_" and "-", and are
//    32 characters long at most,
//  - a port usage in access mode needs a network (port_network).
const MIST_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const JUNOS_PORT = /^(ge|mge|xe|et|fe)-\d+\/\d+\/\d+$/;
const SPEEDS = ['auto', '10m', '100m', '1g', '2.5g', '5g', '10g', '25g', '40g', '100g'];
const DUPLEXES = ['auto', 'half', 'full'];

const usages = (result: Conversion): Array<[string, PortUsage]> => Object.entries(result.template.port_usages);

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

// Rules that are also named in KNOWN_VIOLATIONS of invariants.test.ts.
export const NETWORKS_EXIST = 'every network that a port usage or DHCP snooping refers to exists';
export const PORT_NAMES_ARE_VALID = 'ports of switch rules have Junos port names';
export const VLAN_IDS_ARE_VALID = 'VLAN ids are whole numbers between 1 and 4094';
export const NAMES_ARE_VALID = 'names of networks and port usages only use letters, digits, "_" and "-" (32 characters at most)';
export const MODE_IS_KNOWN = 'port usages are in access or trunk mode';
export const ACCESS_HAS_NETWORK = 'port usages in access mode have a network';
export const SERVERS_ARE_COMPLETE = 'servers have a host and a port, and are listed once';
// On fixtures this rule looks for the placeholder REDACTED. Local configurations have real
// secrets, so local-configs.test.ts replaces it by a search for the secrets of the sources.
export const SECRETS_ARE_NOT_COPIED = 'secrets of the source files are never copied';

export const INVARIANTS: Record<string, Check> = {
  [NETWORKS_EXIST]: (result) => missingNetworks(result),

  'every port of a switch rule uses an existing port usage': (result) =>
    result.template.switch_matching.rules.flatMap((rule) =>
      Object.entries(rule.port_config)
        .filter(([, port]) => !(port.usage in result.template.port_usages))
        .map(([key, port]) => `${rule.name} ${key}: ${port.usage}`),
    ),

  [PORT_NAMES_ARE_VALID]: (result) =>
    result.template.switch_matching.rules.flatMap((rule) =>
      Object.keys(rule.port_config)
        .flatMap((key) => key.split(','))
        .filter((port) => !JUNOS_PORT.test(port))
        .map((port) => `${rule.name} ${port}`),
    ),

  'a port is configured once per switch rule': (result) =>
    result.template.switch_matching.rules.flatMap((rule) =>
      duplicates(Object.keys(rule.port_config).flatMap((key) => key.split(','))).map((port) => `${rule.name} ${port}`),
    ),

  'switch rules have a name, and no two rules have the same name': (result) => {
    const names = result.template.switch_matching.rules.map((rule) => rule.name);
    return [...names.filter((name) => !name).map(() => '(empty name)'), ...duplicates(names)];
  },

  [VLAN_IDS_ARE_VALID]: (result) =>
    Object.entries(result.template.networks)
      .filter(([, network]) => !/^\d+$/.test(String(network.vlan_id)) || Number(network.vlan_id) < 1 || Number(network.vlan_id) > 4094)
      .map(([name, network]) => `${name}: ${network.vlan_id}`),

  'a VLAN id belongs to one network only': (result) => duplicates(Object.values(result.template.networks).map((network) => String(network.vlan_id))),

  [NAMES_ARE_VALID]: (result) =>
    [...Object.keys(result.template.networks), ...Object.keys(result.template.port_usages)].filter((name) => !MIST_NAME.test(name)),

  [MODE_IS_KNOWN]: (result) =>
    usages(result)
      .filter(([, usage]) => usage.mode !== 'access' && usage.mode !== 'trunk')
      .map(([name, usage]) => `${name}: ${usage.mode}`),

  [ACCESS_HAS_NETWORK]: (result) =>
    usages(result)
      .filter(([, usage]) => usage.mode === 'access' && !usage.port_network)
      .map(([name]) => name),

  'speed and duplex have values that Mist knows': (result) =>
    usages(result)
      .filter(([, usage]) => !SPEEDS.includes(String(usage.speed)) || !DUPLEXES.includes(String(usage.duplex)))
      .map(([name, usage]) => `${name}: speed ${usage.speed}, duplex ${usage.duplex}`),

  [SERVERS_ARE_COMPLETE]: (result) => {
    const lists: Record<string, Array<{ host: string; port: string }>> = {
      'radius auth': result.template.radius_config.auth_servers,
      'radius acct': result.template.radius_config.acct_servers,
      tacacs: result.template.switch_mgmt.tacacs.tacplus_servers,
      'tacacs acct': result.template.switch_mgmt.tacacs.acct_servers,
      syslog: result.template.remote_syslog.servers,
    };
    return Object.entries(lists).flatMap(([list, servers]) => {
      const all = endpoints(servers);
      const incomplete = all.filter((endpoint) => !/^[^:]+:\d+$/.test(endpoint));
      return [...incomplete, ...duplicates(all)].map((endpoint) => `${list} ${endpoint}`);
    });
  },

  'a RADIUS server is not listed with two different ports for authentication': (result) =>
    duplicates(result.template.radius_config.auth_servers.map((server) => server.host)),

  [SECRETS_ARE_NOT_COPIED]: (result) =>
    // Every secret in the fixtures is the word REDACTED, so finding it in the output means a secret was copied.
    [JSON.stringify(result.template), JSON.stringify(result.logs)].filter((text) => text.includes('REDACTED')).map(() => 'REDACTED found in the output'),

  'the converter raises no exception': (result) => result.errors.map((error) => String(error)),
};
