import { describe, expect, it } from 'vitest';
import { configuredPorts, convert, endpoints, ios, knownDefect, logsOf, portConfig, switchRule, usageFor, usageOfPort, vlanIds } from './support/harness';

const VLANS = { 1: 'default', 10: 'USERS', 20: 'VOICE', 30: 'PRINTERS', 99: 'MGMT' };

describe('Cisco IOS: reading a file', () => {
  it('recognises a running configuration and reports it as converted', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n!', { vlans: VLANS }));

    expect(result.files[0]).toMatchObject({ format: 'Cisco', success_config: true });
    expect(result.errors).toEqual([]);
  });

  it('gives the same template for Windows (CRLF) and Unix (LF) line endings', async () => {
    const text = ios(
      `
      ip name-server 10.0.0.53
      ip dhcp snooping vlan 10,20
      !
      interface GigabitEthernet1/0/1
       description User port
       switchport access vlan 10
       switchport mode access
       switchport voice vlan 20
      !
      interface GigabitEthernet1/0/2
       switchport trunk native vlan 99
       switchport trunk allowed vlan 10,20
       switchport mode trunk
      !
      interface Vlan99
       ip address 10.99.0.11 255.255.255.0
      !
      radius server ISE1
       address ipv4 10.0.0.80 auth-port 1812 acct-port 1813
      !
      logging host 10.0.0.60 transport tcp port 1514
      `,
      { vlans: VLANS },
    );

    const unix = await convert(text);
    const windows = await convert(text.replace(/\n/g, '\r\n'));

    expect(windows.template).toEqual(unix.template);
  });

  knownDefect('A10', 'a file with a VLAN table is not flagged "No VLAN database found"', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n switchport access vlan 10\n!', { vlans: VLANS }));

    expect(vlanIds(result)).toMatchObject({ users: 10 }); // the table was found and read...
    expect(result.files[0].success_vlan).toBe(true); // ...so the file must not be flagged
    expect(logsOf(result, 'warning', 'error')).toEqual([]);
  });
});

describe('Cisco IOS: VLANs', () => {
  it('turns the names of "show vlan brief" into networks and ignores VLANs 1002 to 1005', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n!', { vlans: VLANS }));

    expect(vlanIds(result)).toEqual({ default: 1, users: 10, voice: 20, printers: 30, mgmt: 99 });
  });

  it('writes network names in lower case with "_" in place of "-"', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n!', { vlans: { 40: 'Guest-WiFi' } }));

    expect(vlanIds(result)).toEqual({ guest_wifi: 40 });
  });

  it('reads the subnet of a VLAN from its SVI', async () => {
    const result = await convert(
      ios(
        `
        interface Vlan10
         ip address 10.1.10.1 255.255.255.0
        !
        interface Vlan20
         ip address 10.1.20.129 255.255.255.128
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(result.template.networks['users']).toEqual({ vlan_id: '10', subnet: '10.1.10.0/24' });
    expect(result.template.networks['voice']).toEqual({ vlan_id: '20', subnet: '10.1.20.128/25' });
    expect(result.template.networks['printers']).toEqual({ vlan_id: '30', subnet: null });
  });

  it('keeps the first subnet of an SVI with a secondary address and warns about it', async () => {
    const result = await convert(
      ios(
        `
        interface Vlan10
         ip address 10.2.10.1 255.255.255.0 secondary
         ip address 10.1.10.1 255.255.255.0
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(result.template.networks['users'].subnet).toBe('10.2.10.0/24');
    expect(logsOf(result, 'warning').join('\n')).toContain('VLAN 10 has multiple subnets');
  });

  it('names a VLAN "vlan<id>" when only a port or an SVI mentions it', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         switchport access vlan 50
         switchport mode access
        !
        interface Vlan60
         ip address 10.1.60.1 255.255.255.0
        !
      `),
    );

    expect(vlanIds(result)).toEqual({ vlan50: 50, vlan60: 60 });
    expect(usageFor(result, 'GigabitEthernet1/0/1').port_network).toBe('vlan50');
  });

  it('prefers the name of the VLAN table to the description of the SVI', async () => {
    const result = await convert(
      ios(
        `
        interface Vlan10
         description Users gateway
         ip address 10.1.10.1 255.255.255.0
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(vlanIds(result)).toMatchObject({ users: 10 });
    expect(Object.keys(result.template.networks)).not.toContain('users_gateway');
  });

  it('uses the description of the SVI as network name when the file has no VLAN table', async () => {
    const result = await convert(
      ios(`
        interface Vlan10
         description Users gateway
         ip address 10.1.10.1 255.255.255.0
        !
      `),
    );

    expect(result.template.networks).toEqual({ users_gateway: { vlan_id: '10', subnet: '10.1.10.0/24' } });
  });

  knownDefect('A1', 'reads the VLANs that follow a port list wrapped over several lines', async () => {
    const result = await convert(
      [
        'sw1#show vlan brief',
        '',
        'VLAN Name                             Status    Ports',
        '---- -------------------------------- --------- -------------------------------',
        '1    default                          active    Gi1/0/20, Gi1/0/21, Gi1/0/22',
        '                                                Gi1/0/23, Gi1/0/24, Te1/1/3',
        '10   USERS                            active    Gi1/0/1, Gi1/0/2',
        '20   VOICE                            active    Gi1/0/1, Gi1/0/2',
        '',
        ios('interface GigabitEthernet1/0/1\n switchport access vlan 10\n!'),
      ].join('\n'),
    );

    expect(vlanIds(result)).toEqual({ default: 1, users: 10, voice: 20 });
  });

  it('reads the VLAN names of the running configuration: "vlan 10" followed by " name users" (A14)', async () => {
    // A capture that only holds "show running-config" has no VLAN table: the names are in these blocks.
    const result = await convert(
      ios(`
        vlan 10
         name USERS
        !
        vlan 20
         name VOICE
        !
        vlan 30,40-41
        !
        interface GigabitEthernet1/0/1
         switchport access vlan 10
         switchport mode access
         switchport voice vlan 20
        !
      `),
    );

    expect(vlanIds(result)).toEqual({ users: 10, voice: 20, vlan30: 30, vlan40: 40, vlan41: 41 });
    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ port_network: 'users', voip_network: 'voice' });
    expect(result.files[0].success_vlan).toBe(true);
  });

  it('reads the other commands of a VLAN block without losing its name (A14)', async () => {
    const result = await convert(
      ios(`
        vlan 10
         name USERS
         private-vlan primary
        vlan 20
         state active
         name VOICE
        vlan 1002
         name legacy
        !
        vlan internal allocation policy ascending
        !
      `),
    );

    expect(vlanIds(result)).toEqual({ users: 10, voice: 20 });
  });

  it('gives one network to a VLAN that is in the VLAN table and in the running configuration (A14)', async () => {
    const result = await convert(
      ios(
        `
        vlan 10
         name USERS
        !
        vlan 20
         name Phones
        !
        `,
        { vlans: { 10: 'USERS', 20: 'VOICE' } },
      ),
    );

    // The table comes first in the capture, so its name is the one that is used.
    expect(vlanIds(result)).toEqual({ users: 10, voice: 20 });
  });

  it('names a VLAN that is declared without name after the description of its SVI (A14)', async () => {
    const result = await convert(
      ios(`
        vlan 10,20
        !
        interface Vlan10
         description Users gateway
         ip address 10.1.10.1 255.255.255.0
        !
      `),
    );

    expect(result.template.networks).toEqual({
      users_gateway: { vlan_id: '10', subnet: '10.1.10.0/24' },
      vlan20: { vlan_id: '20', subnet: null },
    });
  });

  it('keeps a VLAN that is declared without name on the ports that use it (A14)', async () => {
    const result = await convert(
      ios(`
        vlan 30
        !
        interface GigabitEthernet1/0/1
         switchport access vlan 30
         switchport mode access
        !
      `),
    );

    expect(vlanIds(result)).toEqual({ vlan30: 30 });
    expect(usageFor(result, 'GigabitEthernet1/0/1').port_network).toBe('vlan30');
  });

  it('uses the name that another file gives to a VLAN declared without name (A14)', async () => {
    const result = await convert(
      { name: 'sw1.txt', text: ios('vlan 30\n!\ninterface GigabitEthernet1/0/1\n switchport access vlan 30\n!', { hostname: 'sw1' }) },
      { name: 'sw2.txt', text: ios('vlan 30\n name PRINTERS\n!', { hostname: 'sw2' }) },
    );

    expect(vlanIds(result)).toEqual({ printers: 30 });
    expect(usageFor(result, 'GigabitEthernet1/0/1').port_network).toBe('printers');
  });

  it('reads the VLAN names of a configuration script, where the commands are not indented (A14)', async () => {
    const result = await convert(['configure terminal', '!', 'hostname sw1', 'vlan 10', 'name USERS', 'vlan 20', 'name VOICE', 'exit', '!', 'end', ''].join('\n'));

    expect(vlanIds(result)).toEqual({ users: 10, voice: 20 });
  });

  it('keeps a VLAN that is only known from an SVI without description on the ports that use it (A15)', async () => {
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         switchport access vlan 60
         switchport mode access
        !
        interface GigabitEthernet1/0/2
         switchport trunk native vlan 60
         switchport trunk allowed vlan 10,60
         switchport mode trunk
        !
        interface Vlan60
         ip address 10.1.60.1 255.255.255.0
        !
        `,
        { vlans: { 10: 'USERS' } },
      ),
    );

    expect(vlanIds(result)).toEqual({ users: 10, vlan60: 60 });
    expect(usageFor(result, 'GigabitEthernet1/0/1').port_network).toBe('vlan60');
    expect(usageFor(result, 'GigabitEthernet1/0/2')).toMatchObject({ port_network: 'vlan60', networks: ['users', 'vlan60'] });
  });

  it('uses the description of the SVI on the ports when the description comes after the address (A15)', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         switchport access vlan 60
         switchport mode access
        !
        interface Vlan60
         ip address 10.1.60.1 255.255.255.0
         description Cameras
        !
      `),
    );

    expect(vlanIds(result)).toEqual({ cameras: 60 });
    expect(usageFor(result, 'GigabitEthernet1/0/1').port_network).toBe('cameras');
  });

  it.todo('removes the decoration of an SVI description ("*** Users ***") from the network name, which is "_users_" today');
});

describe('Cisco IOS: access ports', () => {
  it('converts the access VLAN and the voice VLAN', async () => {
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         switchport access vlan 10
         switchport mode access
         switchport voice vlan 20
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({
      mode: 'access',
      port_network: 'users',
      voip_network: 'voice',
      all_networks: false,
      networks: [],
    });
  });

  it('puts a port without "switchport access vlan" in the network of VLAN 1', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n switchport mode access\n!', { vlans: VLANS }));

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ mode: 'access', port_network: 'default' });
  });

  knownDefect('A11', 'a port in VLAN 1 has a network even when the file has no VLAN table', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n switchport mode access\n!'));

    expect(usageFor(result, 'GigabitEthernet1/0/1').port_network).toBeDefined();
  });

  it('converts shutdown, PoE, QoS, speed and duplex', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         shutdown
        !
        interface GigabitEthernet1/0/2
         power inline never
        !
        interface GigabitEthernet1/0/3
         auto qos voip cisco-phone
        !
        interface GigabitEthernet1/0/4
         speed 100
         duplex full
        !
        interface GigabitEthernet1/0/5
         speed 1000
        !
      `),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ disabled: true, poe_disabled: false, enable_qos: false });
    expect(usageFor(result, 'GigabitEthernet1/0/2')).toMatchObject({ disabled: false, poe_disabled: true });
    expect(usageFor(result, 'GigabitEthernet1/0/3')).toMatchObject({ enable_qos: true });
    expect(usageFor(result, 'GigabitEthernet1/0/4')).toMatchObject({ speed: '100m', duplex: 'full', disable_autoneg: true });
    expect(usageFor(result, 'GigabitEthernet1/0/5')).toMatchObject({ speed: '1g', duplex: 'auto', disable_autoneg: false });
  });

  it('converts 802.1X, 802.1X with MAC authentication, and MAC authentication alone', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         authentication port-control auto
         dot1x pae authenticator
        !
        interface GigabitEthernet1/0/2
         authentication port-control auto
         mab
         dot1x pae authenticator
        !
        interface GigabitEthernet1/0/3
         authentication port-control auto
         mab
        !
        interface GigabitEthernet1/0/4
        !
      `),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: false, mac_auth_only: false });
    expect(usageFor(result, 'GigabitEthernet1/0/2')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: true, mac_auth_only: false });
    expect(usageFor(result, 'GigabitEthernet1/0/3')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: true, mac_auth_only: true });
    expect(usageFor(result, 'GigabitEthernet1/0/4').port_auth).toBeUndefined();
  });

  it('marks a port with "spanning-tree portfast" as an STP edge port', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n spanning-tree portfast\n!'));

    expect(usageFor(result, 'GigabitEthernet1/0/1').stp_edge).toBe(true);
  });

  it('does not mark a port without "spanning-tree portfast" as an STP edge port (A3)', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         description Uplink
         switchport mode trunk
        !
        interface GigabitEthernet1/0/2
         description User
         switchport access vlan 10
         switchport mode access
        !
      `),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1').stp_edge).toBe(false);
    expect(usageFor(result, 'GigabitEthernet1/0/2').stp_edge).toBe(false);
  });

  it('reads the variants of "spanning-tree portfast" on a port', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         spanning-tree portfast edge
        !
        interface GigabitEthernet1/0/2
         switchport mode trunk
         spanning-tree portfast edge trunk
        !
        interface GigabitEthernet1/0/3
         switchport mode trunk
         spanning-tree portfast trunk
        !
        interface GigabitEthernet1/0/4
         spanning-tree portfast disable
        !
        interface GigabitEthernet1/0/5
         switchport mode trunk
         spanning-tree portfast network
        !
      `),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1').stp_edge).toBe(true);
    expect(usageFor(result, 'GigabitEthernet1/0/2').stp_edge).toBe(true);
    expect(usageFor(result, 'GigabitEthernet1/0/3').stp_edge).toBe(true);
    expect(usageFor(result, 'GigabitEthernet1/0/4').stp_edge).toBe(false);
    expect(usageFor(result, 'GigabitEthernet1/0/5').stp_edge).toBe(false);
  });

  it('marks a port with "spanning-tree bpduguard enable" as an STP edge port', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n spanning-tree bpduguard enable\n!'));

    expect(usageFor(result, 'GigabitEthernet1/0/1').stp_edge).toBe(true);
  });

  it.each(['spanning-tree portfast default', 'spanning-tree portfast edge default'])(
    'applies the global "%s" to access ports only',
    async (globalCommand) => {
      const result = await convert(
        ios(`
          ${globalCommand}
          spanning-tree portfast edge bpduguard default
          !
          interface GigabitEthernet1/0/1
           description User
           switchport access vlan 10
           switchport mode access
          !
          interface GigabitEthernet1/0/2
           description Unmanaged switch
           switchport access vlan 10
           switchport mode access
           spanning-tree portfast disable
          !
          interface GigabitEthernet1/0/3
           description Uplink
           switchport mode trunk
          !
        `),
      );

      expect(usageFor(result, 'GigabitEthernet1/0/1').stp_edge).toBe(true);
      expect(usageFor(result, 'GigabitEthernet1/0/2').stp_edge).toBe(false);
      expect(usageFor(result, 'GigabitEthernet1/0/3').stp_edge).toBe(false);
    },
  );

  it('does not carry the global "spanning-tree portfast default" of one file over to the next file', async () => {
    const result = await convert(
      ios('spanning-tree portfast default\n!\ninterface GigabitEthernet1/0/1\n description User\n!', { hostname: 'sw1' }),
      ios('interface GigabitEthernet1/0/1\n description Camera\n!', { hostname: 'sw2' }),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1', 'sw1').stp_edge).toBe(true);
    expect(usageFor(result, 'GigabitEthernet1/0/1', 'sw2').stp_edge).toBe(false);
  });

  knownDefect('A20', 'keeps the voice VLAN of a port when the file has no VLAN table', async () => {
    // The access VLAN gets a network named "vlan10" in that case. The voice VLAN gets nothing.
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         switchport access vlan 10
         switchport mode access
         switchport voice vlan 20
        !
      `),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ port_network: 'vlan10', voip_network: 'vlan20' });
    expect(vlanIds(result)).toEqual({ vlan10: 10, vlan20: 20 });
  });

  it.todo('converts "switchport port-security maximum <n>" into mac_limit');
  it.todo('converts "storm-control <type> level <n>" into storm_control');
  it.todo('converts "authentication host-mode multi-auth" into allow_multiple_supplicants');
  it.todo('converts "authentication timer reauthenticate <seconds>" into reauth_interval');
  it.todo('converts "authentication event fail action authorize vlan <id>" into server_reject_network');
  it.todo('converts "authentication event server dead action authorize vlan <id>" into server_fail_network');
});

describe('Cisco IOS: trunk ports', () => {
  it('converts the native VLAN and the allowed VLANs, ranges included', async () => {
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         switchport trunk native vlan 99
         switchport trunk allowed vlan 10,20,30
         switchport mode trunk
        !
        interface GigabitEthernet1/0/2
         switchport trunk allowed vlan 10,100-102
         switchport mode trunk
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({
      mode: 'trunk',
      port_network: 'mgmt',
      networks: ['users', 'voice', 'printers'],
      all_networks: false,
    });
    expect(usageFor(result, 'GigabitEthernet1/0/2').networks).toEqual(['users', 'vlan100', 'vlan101', 'vlan102']);
    expect(usageFor(result, 'GigabitEthernet1/0/2').port_network).toBeUndefined();
    expect(vlanIds(result)).toMatchObject({ vlan100: 100, vlan101: 101, vlan102: 102 });
  });

  it('allows all networks on a trunk without an allowed VLAN list', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n switchport mode trunk\n!'));

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ mode: 'trunk', all_networks: true, networks: [] });
  });

  knownDefect('A2', '"switchport trunk allowed vlan add" extends the list of allowed VLANs', async () => {
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         switchport trunk allowed vlan 10,20
         switchport trunk allowed vlan add 30,99
         switchport mode trunk
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1').networks).toEqual(['users', 'voice', 'printers', 'mgmt']);
    expect(vlanIds(result)).toEqual({ default: 1, users: 10, voice: 20, printers: 30, mgmt: 99 });
  });

  knownDefect('A2', '"switchport trunk allowed vlan none" allows no VLAN and creates no network', async () => {
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         switchport trunk allowed vlan none
         switchport mode trunk
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ networks: [], all_networks: false });
    expect(Object.keys(result.template.networks)).not.toContain('vlannone');
  });

  knownDefect('A8', 'a port in "switchport mode dynamic auto" gets a mode that Mist knows', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n switchport mode dynamic auto\n!'));

    expect(['access', 'trunk']).toContain(usageFor(result, 'GigabitEthernet1/0/1').mode);
  });

  knownDefect('A16', 'a trunk that allows every VLAN id ("1-4094") does not create one network per id', async () => {
    // What to do with a short range of VLANs that the switch does not have is a design
    // choice (see the first test of this block). Creating 4094 networks is not.
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         switchport trunk allowed vlan 1-4094
         switchport mode trunk
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(vlanIds(result)).toEqual({ default: 1, users: 10, voice: 20, printers: 30, mgmt: 99 });
  });

  it.todo('reports routed ports ("no switchport") instead of converting them to access ports');
});

describe('Cisco IOS: switch rule and port names', () => {
  it('creates one switch rule per device, matched on the hostname', async () => {
    const result = await convert(ios('interface GigabitEthernet1/0/1\n!', { hostname: 'sw-floor1' }));

    expect(result.template.switch_matching.enabled).toBe(true);
    expect(switchRule(result)).toMatchObject({ name: 'sw-floor1', 'match_name[0:9]': 'sw-floor1' });
  });

  it('assigns the port usage and the description to the port', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
         description Reception desk
         switchport access vlan 10
        !
      `),
    );

    expect(portConfig(result, 'ge-0/0/0')).toEqual({ key: 'ge-0/0/0', usage: 'reception_desk', description: 'Reception desk' });
    expect(Object.keys(result.template.port_usages)).toEqual(['reception_desk']);
  });

  it('translates Cisco port names: member 1 becomes FPC 0 and port 1 becomes port 0', async () => {
    const result = await convert(
      ios(`
        interface FastEthernet0/1
        !
        interface GigabitEthernet0/2
        !
        interface GigabitEthernet1/0/1
        !
        interface GigabitEthernet2/0/48
        !
        interface TenGigabitEthernet1/1/1
        !
        interface TwentyFiveGigE1/1/2
        !
        interface FortyGigabitEthernet1/1/1
        !
      `),
    );

    expect(Object.keys(switchRule(result).port_config)).toEqual(['fe-0/0/0', 'ge-0/0/1', 'ge-0/0/0', 'ge-1/0/47', 'mge-0/1/0', 'et-0/1/1', 'et-0/1/0']);
  });

  it('does not turn VLAN interfaces into ports', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet1/0/1
        !
        interface Vlan1
         no ip address
        !
        interface Vlan10
         ip address 10.1.10.1 255.255.255.0
        !
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
  });

  knownDefect('A7', 'the management port GigabitEthernet0/0 is not turned into port "ge-0/0/-1"', async () => {
    const result = await convert(
      ios(`
        interface GigabitEthernet0/0
         vrf forwarding Mgmt-vrf
         no ip address
        !
        interface GigabitEthernet1/0/1
        !
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
  });

  knownDefect('A7', 'multigigabit and 100G port names are translated', async () => {
    const result = await convert(
      ios(`
        interface TwoGigabitEthernet1/0/1
        !
        interface FiveGigabitEthernet1/0/37
        !
        interface HundredGigE1/1/1
        !
      `),
    );

    expect(configuredPorts(result)).toEqual(['et-0/1/0', 'mge-0/0/0', 'mge-0/0/36']);
  });

  knownDefect('A12', 'loopback interfaces are not turned into switch ports', async () => {
    const result = await convert(
      ios(`
        interface Loopback0
         ip address 10.255.0.1 255.255.255.255
        !
        interface GigabitEthernet1/0/1
        !
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
  });

  knownDefect('A9', 'interfaces that are not separated by "!" are converted one by one', async () => {
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         description Printer
         switchport access vlan 30
         switchport mode access
        interface GigabitEthernet1/0/2
         description Uplink
         switchport mode trunk
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0', 'ge-0/0/1']);
    expect(usageFor(result, 'GigabitEthernet1/0/1')).toMatchObject({ mode: 'access', port_network: 'printers' });
    expect(usageFor(result, 'GigabitEthernet1/0/2')).toMatchObject({ mode: 'trunk', all_networks: true });
  });

  knownDefect('A17', 'the application port AppGigabitEthernet1/0/1 does not take the place of GigabitEthernet1/0/1', async () => {
    // Catalyst 9000 switches list this internal port after the front panel ports.
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         description Printer
         switchport access vlan 30
         switchport mode access
        !
        interface AppGigabitEthernet1/0/1
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
    expect(usageOfPort(result, 'ge-0/0/0')).toMatchObject({ port_network: 'printers' });
  });
});

/**
 * Some files are not the output of "show running-config" but the commands that were
 * typed or pasted in configuration mode: "interface range", the same interface
 * configured twice, blocks closed by "exit", abbreviated commands.
 */
describe('Cisco IOS: configuration scripts', () => {
  knownDefect('A18', '"interface range" configures every port of the range', async () => {
    const result = await convert(
      ios(
        `
        interface range GigabitEthernet1/0/5 - 8
         switchport access vlan 10
         switchport mode access
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/4', 'ge-0/0/5', 'ge-0/0/6', 'ge-0/0/7']);
  });

  knownDefect('A19', 'an interface configured in two blocks keeps the settings of both blocks', async () => {
    const result = await convert(
      ios(
        `
        interface GigabitEthernet1/0/1
         description Printer
         switchport access vlan 30
         switchport mode access
        !
        interface GigabitEthernet1/0/2
         switchport mode trunk
        !
        interface GigabitEthernet1/0/1
         power inline never
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(result.ports.filter((port) => port.source === 'GigabitEthernet1/0/1')).toHaveLength(1);
    expect(usageOfPort(result, 'ge-0/0/0')).toMatchObject({ port_network: 'printers', poe_disabled: true });
  });

  it.todo('reads abbreviated commands ("int gi1/0/1", "shut"): today such an interface is skipped without a warning');
  it.todo('recognises a script that has no "!" line as a Cisco configuration');
});

describe('Cisco IOS: link aggregation', () => {
  it('configures the members of a port-channel as one aggregated entry with the usage of the port-channel', async () => {
    const result = await convert(
      ios(
        `
        interface Port-channel1
         description Uplink to core
         switchport trunk allowed vlan 10,20
         switchport mode trunk
        !
        interface GigabitEthernet1/0/1
         switchport access vlan 10
        !
        interface TenGigabitEthernet1/1/1
         switchport trunk allowed vlan 10,20
         switchport mode trunk
         channel-group 1 mode active
        !
        interface TenGigabitEthernet1/1/2
         switchport trunk allowed vlan 10,20
         switchport mode trunk
         channel-group 1 mode active
        !
        `,
        { vlans: VLANS },
      ),
    );

    expect(Object.keys(switchRule(result).port_config)).toEqual(['mge-0/1/0,mge-0/1/1', 'ge-0/0/0']);
    expect(portConfig(result, 'mge-0/1/0')).toEqual({
      key: 'mge-0/1/0,mge-0/1/1',
      aggregated: true,
      ae_idx: 0,
      description: 'Uplink to core',
      usage: 'uplink_to_core',
    });
    expect(usageFor(result, 'Port-channel1')).toMatchObject({ mode: 'trunk', networks: ['users', 'voice'] });
  });

  it('numbers the aggregated interface from the port-channel number minus one', async () => {
    const result = await convert(
      ios(`
        interface Port-channel12
         switchport mode trunk
        !
        interface TenGigabitEthernet1/1/1
         switchport mode trunk
         channel-group 12 mode active
        !
      `),
    );

    expect(portConfig(result, 'mge-0/1/0')).toMatchObject({ aggregated: true, ae_idx: 11 });
  });
});

describe('Cisco IOS: system settings', () => {
  it('converts DNS servers, DNS suffix and NTP servers', async () => {
    const result = await convert(
      ios(`
        ip name-server 10.0.0.53
        ip name-server 10.0.1.53
        ip domain name corp.example.com
        ntp server 10.0.0.123
        ntp server 10.0.1.123 prefer
      `),
    );

    expect(result.template.dns_servers).toEqual(['10.0.0.53', '10.0.1.53']);
    expect(result.template.dns_suffix).toEqual(['corp.example.com']);
    expect(result.template.ntp_servers).toEqual(['10.0.0.123', '10.0.1.123']);
  });

  knownDefect('A5', 'reads every address of "ip name-server" when several are on one line', async () => {
    const result = await convert(ios('ip name-server 10.0.0.53 10.0.1.53'));

    expect(result.template.dns_servers).toEqual(['10.0.0.53', '10.0.1.53']);
  });

  knownDefect('A6', 'reads the address of a DNS or NTP server reached through a VRF', async () => {
    const result = await convert(
      ios(`
        ip name-server vrf Mgmt-vrf 10.0.0.53
        ntp server vrf Mgmt-vrf 10.0.0.123
      `),
    );

    expect(result.template.dns_servers).toEqual(['10.0.0.53']);
    expect(result.template.ntp_servers).toEqual(['10.0.0.123']);
  });

  it('converts syslog servers with their transport and port', async () => {
    const result = await convert(
      ios(`
        logging host 10.0.0.60
        logging host 10.0.0.61 transport tcp port 1514
      `),
    );

    expect(result.template.remote_syslog).toMatchObject({ enabled: true });
    expect(result.template.remote_syslog.servers).toMatchObject([
      { host: '10.0.0.60', protocol: 'udp' },
      { host: '10.0.0.61', protocol: 'tcp' },
    ]);
    expect(endpoints(result.template.remote_syslog.servers)).toEqual(['10.0.0.60:514', '10.0.0.61:1514']);
  });

  it('converts a RADIUS server and never copies its key', async () => {
    const result = await convert(
      ios(`
        radius server ISE1
         address ipv4 10.0.0.80 auth-port 1812 acct-port 1813
         key 7 REDACTED
        !
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toContain('10.0.0.80:1812');
    expect(result.template.radius_config.auth_servers[0]).toMatchObject({ host: '10.0.0.80', secret: 'to_be_replaced' });
  });

  knownDefect('A13', 'keeps a RADIUS server that uses the default ports', async () => {
    const result = await convert(
      ios(`
        radius server ISE1
         address ipv4 10.0.0.80
         key 7 REDACTED
        !
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toEqual(['10.0.0.80:1812']);
  });

  it('converts a TACACS+ server for authentication and accounting', async () => {
    const result = await convert(
      ios(`
        tacacs server TAC1
         address ipv4 10.0.0.70
         key 7 REDACTED
        !
        tacacs server TAC2
         address ipv4 10.0.0.71 port 4949
        !
      `),
    );

    const tacacs = result.template.switch_mgmt.tacacs;
    expect(tacacs.enabled).toBe(true);
    expect(endpoints(tacacs.tacplus_servers)).toEqual(['10.0.0.70:49', '10.0.0.71:4949']);
    expect(endpoints(tacacs.acct_servers)).toEqual(['10.0.0.70:49', '10.0.0.71:4949']);
    expect(tacacs.tacplus_servers[0]).toMatchObject({ secret: 'to_be_replaced' });
  });

  it('enables DHCP snooping on the listed VLANs that are known', async () => {
    const result = await convert(ios('ip dhcp snooping vlan 10,20,30-31', { vlans: VLANS }));

    expect(result.template.dhcp_snooping).toEqual({ enabled: true, networks: ['users', 'voice', 'printers'] });
  });

  knownDefect('A4', 'converts the "banner motd" text', async () => {
    const result = await convert(
      ios(`
        banner motd ^C
        Authorized access only
        ^C
      `),
    );

    expect(result.template.switch_mgmt.cli_banner).toBe('Authorized access only');
  });

  it('leaves out what the converter does not handle: SNMP, local users, lines', async () => {
    const result = await convert(
      ios(`
        username admin privilege 15 secret 9 REDACTED
        snmp-server community REDACTED RO
        snmp-server location Building A
        !
        line vty 0 4
         transport input ssh
      `),
    );

    expect(result.template.additional_config_cmds).toEqual([]);
    expect(JSON.stringify(result.template)).not.toContain('REDACTED');
  });

  it.todo('reads "ip domain-name" (older syntax of "ip domain name")');
  it.todo('reads "logging <address>" (older syntax of "logging host <address>")');
  it.todo('reads "radius-server host" and "tacacs-server host" (older syntax)');
});
