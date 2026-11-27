/**
 * The entry point of the converter, as the app calls it.
 * What each command converts to is tested in cisco-ios.test.ts, junos.test.ts and shared.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { convert, messageKind } from '../../convert';

const CISCO = ['sw1#show running-config', 'hostname sw1', '!', 'vlan 10', ' name USERS', '!', 'interface GigabitEthernet1/0/1', ' description Desk 12', ' switchport access vlan 10', ' ip verify source', '!', 'end', ''].join('\n');
const JUNOS = ['set system host-name ex1', 'set interfaces ge-0/0/0 description "Desk 13"', 'set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS', 'set vlans USERS vlan-id 10', ''].join('\n');

describe('convert()', () => {
  it('converts files of both vendors into one template', () => {
    const result = convert([
      { name: 'sw1.txt', text: CISCO },
      { name: 'ex1.txt', text: JUNOS },
    ]);

    expect(result.template.networks).toEqual({ users: { vlan_id: '10', subnet: null } });
    expect(Object.keys(result.template.port_usages)).toEqual(['desk']);
    expect(result.template.switch_matching).toEqual({
      enabled: true,
      rules: [
        { name: 'sw1', port_config: { 'ge-0/0/0': { description: 'Desk 12', usage: 'desk' } }, 'match_name[0:3]': 'sw1' },
        { name: 'ex1', port_config: { 'ge-0/0/0': { description: 'Desk 13', usage: 'desk' } }, 'match_name[0:3]': 'ex1' },
      ],
    });
  });

  it('says what happened to each file', () => {
    const result = convert([
      { name: 'sw1.txt', text: CISCO },
      { name: 'ex1.txt', text: 'set system host-name ex1\nset interfaces ge-0/0/0 description "Desk 13"\n' },
      { name: 'notes.txt', text: 'Switch inventory\n' },
    ]);

    expect(result.files.map(({ outcomes: _outcomes, counts: _counts, ports: _ports, ...file }) => file)).toEqual([
      { name: 'sw1.txt', format: 'Cisco', hostname: 'sw1', converted: true, hasVlans: true },
      { name: 'ex1.txt', format: 'Juniper', hostname: 'ex1', converted: true, hasVlans: false, message: 'Unable to retrieve the VLAN list' },
      { name: 'notes.txt', format: 'Unknown', converted: false, hasVlans: false, message: 'Unable to determine the type of file. Please check the format of the file notes.txt' },
    ]);
  });

  it('lists every converted port with its port usage and the lines of the file that configure it', () => {
    const result = convert([{ name: 'sw1.txt', text: CISCO }]);

    expect(result.ports).toEqual([
      {
        file: 'sw1.txt',
        hostname: 'sw1',
        name: 'GigabitEthernet1/0/1',
        junosName: 'ge-0/0/0',
        usage: 'desk_12',
        portConfig: 'ge-0/0/0',
        description: 'Desk 12',
        lines: ['interface GigabitEthernet1/0/1', ' description Desk 12', ' switchport access vlan 10', ' ip verify source'],
        lineNumbers: [7, 8, 9, 10],
      },
    ]);
  });

  it('says what happened to each line of a file, and counts the lines of each kind', () => {
    const result = convert([
      { name: 'sw1.txt', text: CISCO },
      { name: 'notes.txt', text: 'Switch inventory\n' },
    ]);

    // prettier-ignore
    expect(result.files[0].outcomes).toEqual([
      'ignored', //       sw1#show running-config
      'converted', //     hostname sw1
      'none', //          !
      'converted', //     vlan 10
      'converted', //      name USERS
      'none', //          !
      'converted', //     interface GigabitEthernet1/0/1
      'converted', //      description Desk 12
      'converted', //      switchport access vlan 10
      'not-converted', //  ip verify source
      'none', //          !
      'ignored', //       end
      'none', //          (end of the file)
    ]);
    expect(result.files[0].counts).toEqual({ converted: 6, ignored: 2, 'not-converted': 1, none: 4 });
    expect(result.files[0].ports).toBe(1);
    // A file that is not read has nothing converted
    expect(result.files[1]).toMatchObject({ outcomes: ['none', 'none'], ports: 0 });
  });

  it('marks the lines of a port that is left out as not converted, even when rules read them', () => {
    const text = ['hostname sw1', 'interface GigabitEthernet1/0/1', ' no switchport', ' ip address 10.0.0.1 255.255.255.0', '!', 'interface GigabitEthernet0/0', ' vrf forwarding Mgmt-vrf', '!', ''].join('\n');
    const outcomes = convert([{ name: 'sw1.txt', text }]).files[0].outcomes;

    expect(outcomes.slice(1, 4)).toEqual(['not-converted', 'not-converted', 'not-converted']); // routed port
    expect(outcomes.slice(5, 7)).toEqual(['ignored', 'ignored']); // management port
  });

  it('says where each part of the template comes from, and why it has its name', () => {
    const result = convert([
      { name: 'sw1.txt', text: CISCO },
      { name: 'ex1.txt', text: JUNOS },
    ]);

    expect(result.origins.find((origin) => origin.path === 'networks.users')).toEqual({
      path: 'networks.users',
      sources: [
        { file: 'sw1.txt', lines: [4, 5] },
        { file: 'ex1.txt', lines: [4] },
      ],
      naming: 'Named after the name of VLAN 10 in sw1.txt: "USERS".',
    });
    expect(result.origins.find((origin) => origin.path === 'port_usages.desk')).toEqual({
      path: 'port_usages.desk',
      sources: [
        { file: 'sw1.txt', lines: [7, 8, 9, 10], ports: ['GigabitEthernet1/0/1'] },
        { file: 'ex1.txt', lines: [2, 3], ports: ['ge-0/0/0'] },
      ],
      naming: 'Named after the words that most descriptions of its ports share: "desk".',
    });
    expect(result.origins.find((origin) => origin.path === 'switch_matching.rules.ex1')).toEqual({
      path: 'switch_matching.rules.ex1',
      sources: [{ file: 'ex1.txt', lines: [2, 3], ports: ['ge-0/0/0'] }],
      naming: 'Named after the hostname of ex1.txt. The rule applies to the switches whose name starts with "ex1".',
    });
  });

  it('finds the lines of the settings of the switch, and links each message to its part of the template', () => {
    const text = ['hostname sw1', 'ntp server 10.0.0.123', 'ip name-server 10.0.0.53', 'radius server ISE', ' address ipv4 10.0.0.80 auth-port 1812 acct-port 1813', ' key 7 REDACTED', '!', 'vlan 20', '!', ''].join('\n');
    const result = convert([{ name: 'sw1.txt', text }]);

    const lines = (path: string): number[] | undefined => result.origins.find((origin) => origin.path === path)?.sources[0].lines;
    expect(lines('ntp_servers')).toEqual([2]);
    expect(lines('dns_servers')).toEqual([3]);
    // The key is not copied: it is replaced by a placeholder
    expect(lines('radius_config')).toEqual([4, 5]);
    expect(result.diagnostics.find((entry) => entry.code === 'vlan-without-name')).toMatchObject({ subject: 'networks.vlan20' });
  });

  it('tells what it did not convert, with the file and the lines', () => {
    const result = convert([{ name: 'sw1.txt', text: CISCO }]);

    expect(result.diagnostics).toEqual([
      { severity: 'warning', code: 'port-setting-not-converted', message: 'Not converted: "ip verify" on GigabitEthernet1/0/1', file: 'sw1.txt', lines: [10] },
      { severity: 'info', code: 'vlans', message: 'VLANs of the file: 10', file: 'sw1.txt' },
    ]);
  });

  it('gives an empty template, with every section, when there is nothing to convert', () => {
    const result = convert([]);

    expect(result).toMatchObject({ files: [], ports: [], diagnostics: [] });
    expect(Object.keys(result.template)).toEqual(['name', 'ntp_servers', 'dns_servers', 'dns_suffix', 'networks', 'port_usages', 'radius_config', 'switch_mgmt', 'additional_config_cmds', 'dhcp_snooping', 'remote_syslog', 'switch_matching']);
    expect(result.template.switch_matching).toEqual({ enabled: false, rules: [] });
  });

  it('gives the same result when it is called twice: it keeps nothing between two calls', () => {
    const files = [
      { name: 'sw1.txt', text: CISCO },
      { name: 'ex1.txt', text: JUNOS },
    ];

    expect(convert(files)).toEqual(convert(files));
  });

  it('sorts the messages by what the user has to do about them', () => {
    const result = convert([
      { name: 'sw1.txt', text: CISCO },
      { name: 'notes.txt', text: 'Switch inventory\n' },
    ]);

    expect(result.diagnostics.map((entry) => `${messageKind(entry)} ${entry.code}`)).toEqual(['not-converted port-setting-not-converted', 'decision vlans', 'not-read unknown-format']);
  });
});
