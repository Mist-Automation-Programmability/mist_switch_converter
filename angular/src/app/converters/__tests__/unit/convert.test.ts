/**
 * The entry point of the converter, as the app calls it.
 * What each command converts to is tested in cisco-ios.test.ts, junos.test.ts and shared.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { convert } from '../../convert';

const CISCO = ['sw1#show running-config', 'hostname sw1', '!', 'vlan 10', ' name USERS', '!', 'interface GigabitEthernet1/0/1', ' description Desk 12', ' switchport access vlan 10', ' storm-control broadcast level 1.00', '!', 'end', ''].join('\n');
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

    expect(result.files).toEqual([
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
        description: 'Desk 12',
        lines: ['interface GigabitEthernet1/0/1', ' description Desk 12', ' switchport access vlan 10', ' storm-control broadcast level 1.00'],
      },
    ]);
  });

  it('tells what it did not convert, with the file and the lines', () => {
    const result = convert([{ name: 'sw1.txt', text: CISCO }]);

    expect(result.diagnostics).toEqual([
      { severity: 'warning', code: 'port-setting-not-converted', message: 'Not converted: "storm-control broadcast" on GigabitEthernet1/0/1 (line 10)', file: 'sw1.txt', lines: [10] },
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
});
