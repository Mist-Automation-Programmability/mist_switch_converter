import { describe, expect, it } from 'vitest';
import { configuredPorts, convert, endpoints, ios, junos, knownDefect, logsOf, missingNetworks, portConfig, switchRule, usageFor, vlanIds } from './support/harness';

describe('File format detection', () => {
  it('reports a file that is neither Cisco nor Junos and converts nothing from it', async () => {
    const result = await convert({ name: 'notes.txt', text: 'Switch inventory\nsw1 10.0.0.1\nsw2 10.0.0.2\n' });

    expect(result.files[0]).toMatchObject({ name: 'notes.txt', format: 'Unknown', success_config: false });
    expect(result.files[0].error_message).toContain('Unable to determinate the type of file');
    expect(logsOf(result, 'error').join('\n')).toContain('notes.txt');
    expect(result.errors).toEqual([]);
  });

  it('exports an empty template with every section when nothing could be converted', async () => {
    const result = await convert('nothing to convert');

    expect(result.template).toMatchInlineSnapshot(`
      {
        "additional_config_cmds": [],
        "dhcp_snooping": {
          "enabled": false,
          "networks": [],
        },
        "dns_servers": [],
        "dns_suffix": [],
        "name": "template_name",
        "networks": {},
        "ntp_servers": [],
        "port_usages": {},
        "radius_config": {
          "acct_interim_interval": 0,
          "acct_servers": [],
          "auth_servers": [],
          "auth_servers_retries": 3,
          "auth_servers_timeout": 5,
          "coa_enabled": false,
          "coa_port": 3799,
        },
        "remote_syslog": {
          "enabled": false,
          "servers": [],
        },
        "switch_matching": {
          "enabled": false,
          "rules": [],
        },
        "switch_mgmt": {
          "tacacs": {
            "acct_servers": [],
            "enabled": false,
            "tacplus_servers": [],
          },
        },
      }
    `);
  });

  it('keeps converting the other files when one file is not recognised', async () => {
    const result = await convert(
      { name: 'notes.txt', text: 'Switch inventory\n' },
      { name: 'ex1.txt', text: junos('set system host-name ex1\nset interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS\nset vlans USERS vlan-id 10') },
    );

    expect(result.files.map((file) => [file.name, file.format])).toEqual([
      ['notes.txt', 'Unknown'],
      ['ex1.txt', 'Juniper'],
    ]);
    expect(vlanIds(result)).toEqual({ users: 10 });
    expect(configuredPorts(result, 'ex1')).toEqual(['ge-0/0/0']);
  });

  knownDefect('C6', 'an Aruba AOS-CX configuration is not taken for a Cisco configuration', async () => {
    const result = await convert(`!
!Version ArubaOS-CX FL.10.10.1020
!export-password: default
hostname cx-access-01
!
vlan 1
vlan 10
    name USERS
interface 1/1/1
    no shutdown
    no routing
    vlan access 10
interface 1/1/2
    no shutdown
    no routing
    vlan trunk native 1
    vlan trunk allowed 10
`);

    expect(result.files[0].format).not.toBe('Cisco');
  });
});

describe('Port usages (profiles)', () => {
  it('gives ports with the same settings one shared port usage', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         description User port
         switchport access vlan 10
        !
        interface GigabitEthernet1/0/2
         description User port
         switchport access vlan 10
        !
        interface GigabitEthernet1/0/3
         description Printer
         switchport access vlan 30
        !
      `),
    );

    expect(Object.keys(result.template.port_usages)).toEqual(['user_port', 'printer']);
    expect(portConfig(result, 'ge-0/0/0')).toMatchObject({ usage: 'user_port' });
    expect(portConfig(result, 'ge-0/0/1')).toMatchObject({ usage: 'user_port' });
    expect(portConfig(result, 'ge-0/0/2')).toMatchObject({ usage: 'printer' });
  });

  it('names a shared port usage after the words its descriptions have in common', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 description "Desk 12"
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 description "Desk 13"
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/2 description "Desk 14 - Phone"
        set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
      `),
    );

    expect(Object.keys(result.template.port_usages)).toEqual(['desk']);
    expect(logsOf(result, 'warning').join('\n')).toContain('Desk 12,Desk 13,Desk 14 - Phone');
  });

  it('names a port usage "profile" when its ports have no description', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n switchport access vlan 10\n!'));

    expect(Object.keys(result.template.port_usages)).toEqual(['profile']);
  });

  it('adds a suffix when two different port usages would get the same name', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         description Printer
         switchport access vlan 30
        !
        interface GigabitEthernet1/0/2
         description Printer
         switchport access vlan 31
        !
      `),
    );

    const names = Object.keys(result.template.port_usages);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('printer');
    expect(names[1]).toMatch(/^printer-[0-9a-f]{4}$/);
    expect(usageFor(result, 'GigabitEthernet1/0/1').port_network).toBe('vlan30');
    expect(usageFor(result, 'GigabitEthernet1/0/2').port_network).toBe('vlan31');
  });

  it('limits the name of a port usage to 31 characters', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         description Meeting room on the second floor of the north building
        !
      `),
    );

    expect(Object.keys(result.template.port_usages)).toEqual(['meeting_room_on_the_second_floo']);
  });

  knownDefect('C5', 'the name of a port usage only has letters, digits, "_" and "-"', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         description USER+PHONE
         switchport access vlan 10
        !
        interface GigabitEthernet1/0/2
         description AP/Floor.1 (lobby)
         switchport mode trunk
        !
      `),
    );

    for (const name of Object.keys(result.template.port_usages)) expect(name).toMatch(/^[a-z0-9_-]+$/);
  });

  knownDefect('C8', 'the member ports of a link aggregation do not leave an unused port usage in the template', async () => {
    const result = await convert(
      junos(`
        set system host-name ex1
        set interfaces xe-0/2/0 description "Uplink core 1"
        set interfaces xe-0/2/0 ether-options 802.3ad ae0
        set interfaces xe-0/2/1 description "Uplink core 2"
        set interfaces xe-0/2/1 ether-options 802.3ad ae0
        set interfaces ae0 description "Uplink core"
        set interfaces ae0 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ae0 unit 0 family ethernet-switching vlan members all
        set vlans USERS vlan-id 10
      `),
    );

    const used = Object.values(switchRule(result).port_config).map((port) => port.usage);
    expect(Object.keys(result.template.port_usages)).toEqual(used);
  });
});

describe('RADIUS', () => {
  it('puts RADIUS accounting servers in acct_servers and authentication servers in auth_servers (Cisco, C1)', async () => {
    const result = await convert(
      ios(`
        radius server ISE1
         address ipv4 10.0.0.80 auth-port 1812 acct-port 1813
        !
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toEqual(['10.0.0.80:1812']);
    expect(endpoints(result.template.radius_config.acct_servers)).toEqual(['10.0.0.80:1813']);
  });

  it('puts RADIUS accounting servers in acct_servers and authentication servers in auth_servers (Junos, C1)', async () => {
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.80 port 1812
        set access radius-server 10.0.0.80 accounting-port 1813
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toEqual(['10.0.0.80:1812']);
    expect(endpoints(result.template.radius_config.acct_servers)).toEqual(['10.0.0.80:1813']);
  });

  it('enables RADIUS change of authorization (CoA) in the template when the source enables it (C2)', async () => {
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.80 port 1812
        set access radius-server 10.0.0.80 dynamic-request-port 3799
      `),
    );

    expect(result.template.radius_config).toMatchObject({ coa_enabled: true, coa_port: 3799 });
  });

  it('keeps the CoA port of the source', async () => {
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.80 port 1812
        set access radius-server 10.0.0.80 dynamic-request-port 1700
      `),
    );

    expect(result.template.radius_config).toMatchObject({ coa_enabled: true, coa_port: 1700 });
  });

  it('leaves CoA disabled when the source does not configure it', async () => {
    const result = await convert(junos('set access radius-server 10.0.0.80 port 1812'));

    expect(result.template.radius_config).toMatchObject({ coa_enabled: false, coa_port: 3799 });
  });

  it.todo('Cisco: reads "aaa server radius dynamic-author" as RADIUS CoA');
});

describe('Several files in one template', () => {
  const CISCO_A = ios(
    `
    ip name-server 10.0.0.53
    ntp server 10.0.0.123
    !
    interface GigabitEthernet1/0/1
     description User port
     switchport access vlan 10
     switchport mode access
    !
    `,
    { hostname: 'sw-a', vlans: { 10: 'USERS' } },
  );
  const CISCO_B = ios(
    `
    ip name-server 10.0.0.53
    ip name-server 10.0.1.53
    ntp server 10.0.0.123
    !
    interface GigabitEthernet1/0/1
     description User port
     switchport access vlan 10
     switchport mode access
    !
    interface GigabitEthernet1/0/2
     description Printer
     switchport access vlan 30
     switchport mode access
    !
    `,
    { hostname: 'sw-b', vlans: { 10: 'USERS', 30: 'PRINTERS' } },
  );

  it('creates one switch rule per file and shares networks, port usages and servers', async () => {
    const result = await convert({ name: 'sw-a.txt', text: CISCO_A }, { name: 'sw-b.txt', text: CISCO_B });

    expect(result.template.switch_matching.rules.map((rule) => rule.name)).toEqual(['sw-a', 'sw-b']);
    expect(vlanIds(result)).toEqual({ users: 10, printers: 30 });
    expect(Object.keys(result.template.port_usages)).toEqual(['user_port', 'printer']);
    expect(portConfig(result, 'ge-0/0/0', 'sw-a')).toMatchObject({ usage: 'user_port' });
    expect(portConfig(result, 'ge-0/0/0', 'sw-b')).toMatchObject({ usage: 'user_port' });
    expect(portConfig(result, 'ge-0/0/1', 'sw-b')).toMatchObject({ usage: 'printer' });
    expect(result.template.dns_servers).toEqual(['10.0.0.53', '10.0.1.53']);
    expect(result.template.ntp_servers).toEqual(['10.0.0.123']);
  });

  it('gives the same template whatever the order of the files, apart from the order of the entries', async () => {
    const first = await convert({ name: 'sw-a.txt', text: CISCO_A }, { name: 'sw-b.txt', text: CISCO_B });
    const second = await convert({ name: 'sw-b.txt', text: CISCO_B }, { name: 'sw-a.txt', text: CISCO_A });

    expect(second.template.networks).toEqual(first.template.networks);
    expect(second.template.port_usages).toEqual(first.template.port_usages);
    expect([...second.template.dns_servers].sort()).toEqual([...first.template.dns_servers].sort());
    expect(second.template.switch_matching.rules).toEqual(expect.arrayContaining(first.template.switch_matching.rules));
  });

  it('merges a Cisco file and a Junos file that use the same VLANs', async () => {
    const result = await convert(
      { name: 'sw-a.txt', text: CISCO_A },
      {
        name: 'ex1.txt',
        text: junos(`
          set system host-name ex1
          set interfaces ge-0/0/0 description "User port"
          set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
          set vlans USERS vlan-id 10
          set vlans VOICE vlan-id 20
        `),
      },
    );

    expect(result.files.map((file) => file.format)).toEqual(['Cisco', 'Juniper']);
    expect(vlanIds(result)).toEqual({ users: 10, voice: 20 });
    expect(result.template.switch_matching.rules.map((rule) => rule.name)).toEqual(['sw-a', 'ex1']);
    expect(missingNetworks(result)).toEqual([]);
  });

  it('keeps two Cisco VLANs apart when they have the same name but different ids', async () => {
    const result = await convert(
      { name: 'sw-a.txt', text: CISCO_A },
      {
        name: 'sw-c.txt',
        text: ios('interface GigabitEthernet1/0/1\n switchport access vlan 20\n switchport mode access\n!', { hostname: 'sw-c', vlans: { 20: 'USERS' } }),
      },
    );

    expect(vlanIds(result)).toEqual({ users: 10, 'users-vl20': 20 });
    expect(usageFor(result, 'GigabitEthernet1/0/1', 'sw-a').port_network).toBe('users');
    expect(usageFor(result, 'GigabitEthernet1/0/1', 'sw-c').port_network).toBe('users-vl20');
  });

  knownDefect('C3', 'a VLAN with two names in two files does not leave a port usage pointing to a missing network', async () => {
    const result = await convert(
      junos(`
        set system host-name ex-a
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
      `),
      junos(`
        set system host-name ex-b
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members STAFF
        set vlans STAFF vlan-id 10
      `),
    );

    expect(missingNetworks(result)).toEqual([]);
  });

  knownDefect('C4', 'two VLANs with the same name but different ids in two files are both kept', async () => {
    const result = await convert(
      junos(`
        set system host-name ex-a
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members SERVERS
        set vlans SERVERS vlan-id 50
      `),
      junos(`
        set system host-name ex-b
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members SERVERS
        set vlans SERVERS vlan-id 60
      `),
    );

    expect(Object.values(vlanIds(result)).sort()).toEqual([50, 60]);
  });

  knownDefect('C7', 'a file without hostname does not create a switch rule with an empty name', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n switchport access vlan 10\n!', { hostname: null }));

    expect(switchRule(result).name).not.toBe('');
  });

  knownDefect('C9', 'log lines about the VLANs of a Cisco file name that file', async () => {
    const result = await convert({ name: 'sw-a.txt', text: CISCO_A });

    const vlanLogs = result.logs.filter((entry) => entry.message.startsWith('New VLANs'));
    expect(vlanLogs).toHaveLength(1);
    expect(vlanLogs[0].file).toBe('sw-a.txt');
  });
});
