import { describe, expect, it } from 'vitest';
import { configuredPorts, convert, convertWith, cx, dedent, endpoints, logsOf, missingNetworks, portConfig, usageFor, usageOfPort, vlanIds } from './support/harness';

/** The VLANs of most tests, as an AOS-CX switch prints them. */
const VLANS = `
vlan 1
vlan 10
    name USERS
vlan 20
    name VOICE
    voice
vlan 30
    name PRINTERS
vlan 99
    name MGMT
`;

/** A configuration with the VLANs above, then the parts that are given. Each part is written from the margin of its first line. */
const withVlans = (...parts: string[]): string => cx([dedent(VLANS), ...parts.map(dedent)].join('\n'));

describe('Aruba AOS-CX: reading a file', () => {
  it('recognises a running configuration and reports it as converted', async () => {
    const result = await convert(withVlans(''));

    expect(result.files[0]).toMatchObject({ format: 'Aruba', success_config: true, success_vlan: true, error_message: '' });
    expect(result.errors).toEqual([]);
    expect(logsOf(result, 'warning', 'error')).toEqual([]);
  });

  it('recognises a configuration without its header, from its ports', async () => {
    const result = await convert('hostname cx9\nvlan 10\ninterface 1/1/1\n    no shutdown\n    no routing\n    vlan access 10\n');

    expect(result.files[0]).toMatchObject({ format: 'Aruba', success_config: true });
    expect(configuredPorts(result, 'cx9')).toEqual(['ge-0/0/0']);
  });

  it('reads the capture of a terminal: the prompts are not configuration, and name the switch', async () => {
    const result = await convert(
      ['cx-idf-3# show version', 'ArubaOS-CX', 'cx-idf-3# show running-config', 'Current configuration:', '!', '!Version ArubaOS-CX FL.10.13.1000', 'vlan 10', '    name USERS', 'interface 1/1/1', '    no shutdown', '    no routing', '    vlan access 10', 'cx-idf-3#', ''].join('\n'),
    );

    expect(configuredPorts(result, 'cx-idf-3')).toEqual(['ge-0/0/0']);
    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual([]);
  });

  it('gives the same template for Windows (CRLF) and Unix (LF) line endings', async () => {
    const text = withVlans(`
    banner motd !
    Authorized access only.
    !
    interface 1/1/1
        no shutdown
        no routing
        vlan access 10
        aaa authentication port-access dot1x authenticator
            enable
    interface vlan 99
        ip address 10.99.0.11/24
    `);

    const unix = await convert(text);
    const windows = await convert(text.replace(/\n/g, '\r\n'));

    expect(windows.template).toEqual(unix.template);
    expect(unix.template.switch_mgmt.cli_banner).toBe('Authorized access only.');
  });

  it('warns about a file that lost its indentation, where the settings of the ports cannot be read', async () => {
    // The commands typed at the prompts of the configuration mode
    const result = await convert(['cx1(config)# vlan 10', 'cx1(config-vlan-10)# name USERS', 'cx1(config)# interface 1/1/1', 'cx1(config-if)# no shutdown', 'cx1(config-if)# vlan access 10', 'cx1(config-if)# description Desk 12', ''].join('\n'));

    expect(result.files[0]).toMatchObject({ format: 'Aruba', success_config: true });
    expect(result.logs.filter((entry) => entry.level === 'warning')).toEqual([
      { level: 'warning', file: 'file1.txt', message: 'Settings of an interface are written outside an interface and are not read. The converter needs the lines of each block indented, as "show running-config" prints them', lines: [5, 6] },
    ]);
  });

  it('reports a command without a rule once, by its keywords and never by its values', async () => {
    const result = await convert(
      withVlans(`
      ip route 0.0.0.0/0 10.99.0.1
      ip route 10.50.0.0/16 10.99.0.2
      user admin group administrators password ciphertext AQBapS3cr3tT3xt
      `),
    );

    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual(['Not converted: "ip route"']);
    expect(JSON.stringify(result)).not.toMatch(/10\.99\.0\.2|AQBapS3cr3tT3xt/);
  });
});

describe('Aruba AOS-CX: VLANs', () => {
  it('turns the VLAN blocks into networks, named after their names', async () => {
    const result = await convert(withVlans(''));

    expect(vlanIds(result)).toEqual({ default: 1, users: 10, voice: 20, printers: 30, mgmt: 99 });
  });

  it('reads a line that declares several VLANs', async () => {
    const result = await convert(cx('vlan 1,5,7-9'));

    expect(Object.values(vlanIds(result)).sort((a, b) => a - b)).toEqual([1, 5, 7, 8, 9]);
    expect(result.files[0].success_vlan).toBe(true);
  });

  it('reads the subnet of a VLAN from its VLAN interface, the primary address first', async () => {
    const result = await convert(
      withVlans(`
      interface vlan 10
          ip address 10.1.10.1/24
          ip address 10.1.11.1/24 secondary
      interface vlan99
          description Management
          ip address 10.99.0.11/24
      `),
    );

    expect(result.template.networks['users']).toMatchObject({ vlan_id: '10', subnet: '10.1.10.0/24' });
    expect(result.template.networks['mgmt']).toMatchObject({ vlan_id: '99', subnet: '10.99.0.0/24' });
  });

  it('names a VLAN without name after the description of its VLAN interface', async () => {
    const result = await convert(
      cx(`
      vlan 50
      interface vlan 50
          description Cameras
          ip address 10.1.50.1/24
      `),
    );

    expect(vlanIds(result)).toEqual({ cameras: 50 });
  });

  it('creates the network of a VLAN that only a port names', async () => {
    const result = await convert(withVlans('interface 1/1/1\n    no shutdown\n    no routing\n    vlan access 77\n'));

    expect(vlanIds(result)).toMatchObject({ vlan77: 77 });
    expect(missingNetworks(result)).toEqual([]);
  });

  it('snoops DHCP on the VLANs that say so, when DHCP snooping is turned on for the switch', async () => {
    const vlans = 'vlan 10\n    name USERS\n    dhcpv4-snooping\nvlan 20\n    name VOICE\n';
    const on = await convert(cx(`dhcpv4-snooping\n${vlans}`));
    const off = await convert(cx(vlans));

    expect(on.template.dhcp_snooping).toEqual({ enabled: true, networks: ['users'] });
    expect(off.template.dhcp_snooping).toEqual({ enabled: false, networks: [] });
  });
});

describe('Aruba AOS-CX: port names', () => {
  it('translates member/slot/port into the Juniper position, both numbered from 0', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
      interface 2/1/24
          no shutdown
          no routing
          vlan access 10
      interface 1/3/5
          no shutdown
          no routing
          vlan access 10
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0', 'ge-0/2/4', 'ge-1/0/23']);
  });

  it('leaves out the management port, the loopbacks and the sub-interfaces, and says so', async () => {
    const result = await convert(
      withVlans(`
      interface mgmt
          no shutdown
          ip static 10.99.0.11/24
      interface loopback 0
          ip address 10.255.0.1/32
      interface 1/1/2.100
          encapsulation dot1q 100
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
    expect(logsOf(result, 'info').filter((message) => message.includes('not converted'))).toEqual([
      'Interface mgmt: management port, not converted',
      'Interface loopback0: loopback interface, not converted',
      'Interface 1/1/2.100: not a switch port, not converted',
    ]);
  });

  it('leaves out the ports that link the members of a stack (VSF)', async () => {
    const result = await convert(
      withVlans(`
      vsf member 1
          type jl661a
          link 1 1/1/51
          link 2 1/1/52
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
      interface 1/1/51
          no shutdown
      interface 1/1/52
          no shutdown
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
    expect(logsOf(result, 'info')).toContain('Interface 1/1/51: link between the members of the stack (VSF), not converted');
    expect(logsOf(result, 'warning')).toEqual([]);
  });

  it('reads a line that names several ports', async () => {
    const result = await convert(withVlans('interface 1/1/1-1/1/3,1/1/10\n    no shutdown\n    no routing\n    vlan access 30\n'));

    expect(configuredPorts(result)).toEqual(['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2', 'ge-0/0/9']);
    expect(usageOfPort(result, 'ge-0/0/9')).toMatchObject({ mode: 'access', port_network: 'printers' });
  });

  it('does not convert one lane of a split port, whose position has no equivalent', async () => {
    const result = await convert(withVlans('interface 1/1/49:1\n    no shutdown\n    no routing\n    vlan access 10\n'));

    expect(result.template.switch_matching.rules).toEqual([expect.objectContaining({ port_config: {} })]);
    expect(logsOf(result, 'warning')).toEqual(['Interface 1/1/49:1: the position of the port cannot be translated, not converted']);
  });
});

describe('Aruba AOS-CX: access ports and trunks', () => {
  it('converts an access port, with its description', async () => {
    const result = await convert(withVlans('interface 1/1/1\n    description Printer floor 1\n    no shutdown\n    no routing\n    vlan access 30\n'));

    expect(usageFor(result, '1/1/1')).toMatchObject({ mode: 'access', port_network: 'printers', disabled: false, all_networks: false, networks: [] });
    expect(portConfig(result, 'ge-0/0/0')).toMatchObject({ description: 'Printer floor 1' });
  });

  it('converts the native VLAN and the allowed VLANs of a trunk, ranges included', async () => {
    const result = await convert(withVlans('interface 1/1/1\n    no shutdown\n    no routing\n    vlan trunk native 99\n    vlan trunk allowed 10,20-30,99\n'));

    expect(usageFor(result, '1/1/1')).toMatchObject({ mode: 'trunk', port_network: 'mgmt', all_networks: false, networks: ['users', 'voice', 'printers', 'mgmt'] });
  });

  it('takes a range of VLANs as written in a file that declares no VLAN', async () => {
    const result = await convert(cx('interface 1/1/1\n    no shutdown\n    no routing\n    vlan trunk native 1\n    vlan trunk allowed 10,20-22\n'));

    expect(usageFor(result, '1/1/1').networks).toEqual(['vlan10', 'vlan20', 'vlan21', 'vlan22']);
    expect(missingNetworks(result)).toEqual([]);
  });

  it('allows all networks on a trunk that says "all", or that has no list', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan trunk native 1
          vlan trunk allowed all
      interface 1/1/2
          no shutdown
          no routing
          vlan trunk native 99
      `),
    );

    expect(usageFor(result, '1/1/1')).toMatchObject({ mode: 'trunk', all_networks: true, port_network: 'default', networks: [] });
    expect(usageFor(result, '1/1/2')).toMatchObject({ mode: 'trunk', all_networks: true, port_network: 'mgmt', networks: [] });
  });

  it('adds up the lists of a trunk that has several "vlan trunk allowed" lines', async () => {
    const result = await convert(withVlans('interface 1/1/1\n    no shutdown\n    no routing\n    vlan trunk native 1\n    vlan trunk allowed 10\n    vlan trunk allowed 30\n'));

    expect(usageFor(result, '1/1/1').networks).toEqual(['users', 'printers']);
  });

  it('a native VLAN that is sent with its tag is one more VLAN of the trunk', async () => {
    const result = await convert(withVlans('interface 1/1/1\n    no shutdown\n    no routing\n    vlan trunk native 99 tag\n    vlan trunk allowed 10,30\n'));

    const usage = usageFor(result, '1/1/1');
    expect(usage).toMatchObject({ mode: 'trunk', networks: ['mgmt', 'users', 'printers'] });
    expect(usage.port_network).toBeUndefined();
  });

  it('converts a trunk with a native VLAN and one voice VLAN as an access port with a voice VLAN', async () => {
    const result = await convert(withVlans('interface 1/1/1\n    no shutdown\n    no routing\n    vlan trunk native 10\n    vlan trunk allowed 10,20\n'));

    const usage = usageFor(result, '1/1/1');
    expect(usage).toMatchObject({ mode: 'access', port_network: 'users', voip_network: 'voice', all_networks: false, networks: [] });
    expect(logsOf(result, 'info').filter((message) => message.includes('voice'))).toEqual([
      'A trunk with a native VLAN and one VLAN marked "voice" is a port for a phone and a computer: converted as an access port with a voice VLAN on 1/1/1',
    ]);
  });

  it('keeps a trunk as a trunk when its tagged VLAN is not a voice VLAN, or when it has more than one', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan trunk native 10
          vlan trunk allowed 10,30
      interface 1/1/2
          no shutdown
          no routing
          vlan trunk native 10
          vlan trunk allowed 10,20,30
      `),
    );

    expect(usageFor(result, '1/1/1')).toMatchObject({ mode: 'trunk', port_network: 'users', networks: ['users', 'printers'] });
    expect(usageFor(result, '1/1/2')).toMatchObject({ mode: 'trunk', port_network: 'users', networks: ['users', 'voice', 'printers'] });
    expect(usageFor(result, '1/1/2').voip_network).toBeUndefined();
  });

  it('on a switch whose ports are routed unless they say "no routing", does not convert a routed port', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
      interface 1/1/2
          no shutdown
      interface 1/1/3
          no shutdown
          description Link to the core
          ip address 10.0.0.1/31
      interface 1/1/4
          no shutdown
          routing
          vlan access 10
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
    expect(logsOf(result, 'warning')).toEqual(['Routed port, not converted on 3 ports, the first is 1/1/2']);
  });

  it('a port with a VLAN is a switch port, even without "no routing"', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
      interface 1/1/2
          no shutdown
          vlan access 30
      `),
    );

    expect(usageFor(result, '1/1/2')).toMatchObject({ mode: 'access', port_network: 'printers' });
  });

  it('on a switch without routed ports, a port that says nothing is an access port of VLAN 1', async () => {
    // The configuration of a switch that only switches has no "no routing" line.
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          vlan access 10
      interface 1/1/2
          no shutdown
      `),
    );

    expect(usageFor(result, '1/1/2')).toMatchObject({ mode: 'access', port_network: 'default', disabled: false });
    expect(logsOf(result, 'warning')).toEqual([]);
  });

  it('a port is disabled by "shutdown", or by saying nothing on a switch where the others say "no shutdown"', async () => {
    const shutByDefault = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
      interface 1/1/2
          no routing
          vlan access 10
      `),
    );
    const openByDefault = await convert(
      withVlans(`
      interface 1/1/1
          no routing
          vlan access 10
      interface 1/1/2
          shutdown
          no routing
          vlan access 10
      `),
    );

    expect(usageFor(shutByDefault, '1/1/1').disabled).toBe(false);
    expect(usageFor(shutByDefault, '1/1/2').disabled).toBe(true);
    expect(usageFor(openByDefault, '1/1/1').disabled).toBe(false);
    expect(usageFor(openByDefault, '1/1/2').disabled).toBe(true);
  });

  it('converts the speed, the duplex, the MTU, PoE and QoS', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
          speed 100-full
          mtu 9198
          no power-over-ethernet
          qos trust dscp
      interface 1/1/2
          no shutdown
          no routing
          vlan access 10
          speed auto 1g
      interface 1/1/3
          no shutdown
          no routing
          vlan access 10
          speed 10g
      interface 1/1/4
          no shutdown
          no routing
          vlan access 10
          speed auto 100m 1g
      `),
    );

    expect(usageFor(result, '1/1/1')).toMatchObject({ speed: '100m', duplex: 'full', disable_autoneg: true, mtu: 9198, poe_disabled: true, enable_qos: true });
    expect(usageFor(result, '1/1/2')).toMatchObject({ speed: '1g', duplex: 'auto', disable_autoneg: false, poe_disabled: false, enable_qos: false });
    expect(usageFor(result, '1/1/3')).toMatchObject({ speed: '10g', duplex: 'auto', disable_autoneg: false });
    // Several speeds to advertise have no equivalent: the port stays on auto, and the report says so.
    expect(usageFor(result, '1/1/4')).toMatchObject({ speed: 'auto', duplex: 'auto' });
    expect(logsOf(result, 'warning')).toEqual(['Not converted: "speed auto, with a list of speeds" on 1/1/4']);
  });

  it('marks an admin-edge port and a port with BPDU guard as STP edge ports', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
          spanning-tree port-type admin-edge
      interface 1/1/2
          no shutdown
          no routing
          vlan access 10
          spanning-tree bpdu-guard
          spanning-tree root-guard
      interface 1/1/3
          no shutdown
          no routing
          vlan access 10
          spanning-tree port-type admin-network
      interface 1/1/4
          no shutdown
          no routing
          vlan access 10
      `),
    );

    expect(['1/1/1', '1/1/2', '1/1/3', '1/1/4'].map((port) => usageFor(result, port).stp_edge)).toEqual([true, true, false, false]);
    expect(logsOf(result, 'warning')).toEqual([]);
  });

  it('reports the setting of a port that has no rule, with the number of ports', async () => {
    const result = await convert(
      withVlans(`
      interface 1/1/1
          no shutdown
          no routing
          vlan access 10
          apply access-list ip BLOCK-GUESTS in
      interface 1/1/2
          no shutdown
          no routing
          vlan access 10
          apply access-list ip BLOCK-GUESTS in
          aaa authentication port-access auth-role EMPLOYEE
      `),
    );

    expect(logsOf(result, 'warning')).toEqual(['Not converted: "apply access-list" on 2 ports, the first is 1/1/1', 'Not converted: "aaa authentication port-access auth-role" on 1/1/2']);
    expect(JSON.stringify(result.logs)).not.toMatch(/BLOCK-GUESTS|EMPLOYEE/);
  });
});

describe('Aruba AOS-CX: link aggregations', () => {
  const members = dedent(`
    interface 1/1/49
        no shutdown
        lag 1
    interface 2/1/49
        no shutdown
        lag 1
  `);

  it('converts a link aggregation with LACP, from the aggregated interface', async () => {
    const result = await convert(
      withVlans(
        `
        interface lag 1
            description UPLINK-CORE
            no shutdown
            no routing
            vlan trunk native 1
            vlan trunk allowed 10,20,99
            lacp mode active
        `,
        members,
      ),
    );

    expect(portConfig(result, 'ge-0/0/48')).toMatchObject({ key: 'ge-0/0/48,ge-1/0/48', aggregated: true, ae_idx: 0, description: 'UPLINK-CORE' });
    expect(portConfig(result, 'ge-0/0/48')).not.toHaveProperty('ae_disable_lacp');
    expect(usageOfPort(result, 'ge-1/0/48')).toMatchObject({ mode: 'trunk', port_network: 'default', networks: ['users', 'voice', 'mgmt'] });
  });

  it('a link aggregation without "lacp mode" is static', async () => {
    const result = await convert(withVlans('interface lag 2\n    no shutdown\n    no routing\n    vlan trunk native 1', members.replace(/lag 1/g, 'lag 2')));

    expect(portConfig(result, 'ge-0/0/48')).toMatchObject({ aggregated: true, ae_idx: 1, ae_disable_lacp: true });
  });

  it('reads the aggregation that two switches share (multi-chassis)', async () => {
    const result = await convert(withVlans('interface lag 1 multi-chassis\n    no shutdown\n    no routing\n    vlan trunk native 1\n    lacp mode active', members));

    expect(portConfig(result, 'ge-0/0/48')).toMatchObject({ aggregated: true, ae_idx: 0 });
  });

  it('gives an aggregation without aggregated interface the settings of its first member', async () => {
    const result = await convert(withVlans(members));

    expect(portConfig(result, 'ge-0/0/48')).toMatchObject({ key: 'ge-0/0/48,ge-1/0/48', aggregated: true, ae_idx: 0 });
    expect(logsOf(result, 'info')).toContain('lag1 is not configured in the file: the aggregation has the settings of its first member, 1/1/49');
  });

  it('does not convert a routed aggregation, nor its members', async () => {
    const result = await convert(
      withVlans('interface lag 1\n    no shutdown\n    ip address 10.0.0.1/31\n    lacp mode active', members, 'interface 1/1/1\n    no shutdown\n    no routing\n    vlan access 10'),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
    expect(logsOf(result, 'warning')).toEqual(['Routed port, not converted on lag1']);
  });
});

describe('Aruba AOS-CX: 802.1X and MAC authentication', () => {
  /** An access port of VLAN 10 with these settings, written as the lines of its block. */
  const port = (name: string, ...settings: string[]): string =>
    [`interface ${name}`, 'no shutdown', 'no routing', 'vlan access 10', ...settings.flatMap((setting) => setting.split('\n'))].map((line, index) => (index === 0 ? line : `    ${line}`)).join('\n');
  const PORT_ACCESS = 'aaa authentication port-access';
  const DOT1X = `${PORT_ACCESS} dot1x authenticator\n    enable`;
  const MAC_AUTH = `${PORT_ACCESS} mac-auth\n    enable`;

  it('converts 802.1X, 802.1X with MAC authentication, and MAC authentication alone', async () => {
    const result = await convert(withVlans(port('1/1/1', DOT1X), port('1/1/2', DOT1X, MAC_AUTH), port('1/1/3', MAC_AUTH), port('1/1/4')));

    expect(usageFor(result, '1/1/1')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: false, mac_auth_only: false });
    expect(usageFor(result, '1/1/2')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: true, mac_auth_only: false });
    expect(usageFor(result, '1/1/3')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: true, mac_auth_only: true });
    expect(usageFor(result, '1/1/4').port_auth).toBeUndefined();
  });

  it('a block without "enable" turns nothing on', async () => {
    const result = await convert(withVlans(port('1/1/1', `${PORT_ACCESS} dot1x authenticator\n    reauth\n    max-retries 1`)));

    expect(usageFor(result, '1/1/1').port_auth).toBeUndefined();
    expect(logsOf(result, 'warning')).toEqual([]);
  });

  it('adds none of the optional settings to a port usage that does not need them', async () => {
    const result = await convert(withVlans(port('1/1/1', DOT1X)));

    const usage = usageFor(result, '1/1/1');
    for (const setting of ['allow_multiple_supplicants', 'reauth_interval', 'server_fail_network', 'server_reject_network', 'bypass_auth_when_server_down_for_unknown_client']) expect(usage).not.toHaveProperty(setting);
    expect(usage.bypass_auth_when_server_down).toBe(false);
  });

  it('lets several clients authenticate when the limit of the port is above one, except in device mode', async () => {
    const result = await convert(
      withVlans(port('1/1/1', `${PORT_ACCESS} client-limit 5`, DOT1X), port('1/1/2', `${PORT_ACCESS} client-limit 5`, `${PORT_ACCESS} auth-mode device-mode`, DOT1X), port('1/1/3', `${PORT_ACCESS} auth-mode multi-domain`, DOT1X)),
    );

    expect(usageFor(result, '1/1/1').allow_multiple_supplicants).toBe(true);
    expect(usageFor(result, '1/1/2')).not.toHaveProperty('allow_multiple_supplicants');
    expect(usageFor(result, '1/1/3').allow_multiple_supplicants).toBe(true);
  });

  it('converts "reauth" with its period into reauth_interval', async () => {
    const result = await convert(
      withVlans(
        port('1/1/1', `${PORT_ACCESS} dot1x authenticator\n    reauth\n    reauth-period 14400\n    enable`),
        // Without "reauth", the period is not used.
        port('1/1/2', `${PORT_ACCESS} dot1x authenticator\n    reauth-period 14400\n    enable`),
      ),
    );

    expect(usageFor(result, '1/1/1').reauth_interval).toBe(14400);
    expect(usageFor(result, '1/1/2')).not.toHaveProperty('reauth_interval');
  });

  it('converts "cached-reauth" into bypass_auth_when_server_down', async () => {
    const result = await convert(withVlans(port('1/1/1', `${PORT_ACCESS} mac-auth\n    cached-reauth\n    cached-reauth-period 86400\n    enable`)));

    expect(usageFor(result, '1/1/1').bypass_auth_when_server_down).toBe(true);
  });

  it('converts the VLAN of the critical role and of the reject role into server_fail_network and server_reject_network', async () => {
    const result = await convert(
      withVlans(
        `
        vlan 666
            name QUARANTINE
        port-access role CRITICAL
            reauth-period 600
            vlan access 30
        port-access role REJECT
            vlan access name QUARANTINE
        `,
        port('1/1/1', `${PORT_ACCESS} critical-role CRITICAL`, `${PORT_ACCESS} reject-role REJECT`, DOT1X),
      ),
    );

    expect(usageFor(result, '1/1/1')).toMatchObject({ server_fail_network: 'printers', server_reject_network: 'quarantine' });
    expect(logsOf(result, 'warning')).toEqual([]);
    expect(logsOf(result, 'info')).toContain('The file has 2 port-access roles. Roles are not converted: they are read for the VLAN of "critical-role" and "reject-role"');
  });

  it('a critical role without VLAN lets the clients in on the VLAN of the port', async () => {
    const result = await convert(withVlans('port-access role OPEN\n    reauth-period 600', port('1/1/1', `${PORT_ACCESS} critical-role OPEN`, DOT1X)));

    const usage = usageFor(result, '1/1/1');
    expect(usage.bypass_auth_when_server_down_for_unknown_client).toBe(true);
    expect(usage).not.toHaveProperty('server_fail_network');
    expect(logsOf(result, 'warning')).toEqual([]);
  });

  it('warns about a critical role or a reject role that the file does not have, without naming it', async () => {
    const result = await convert(withVlans(port('1/1/1', `${PORT_ACCESS} critical-role FROM-NAC`, `${PORT_ACCESS} reject-role FROM-NAC`, DOT1X)));

    expect(usageFor(result, '1/1/1').bypass_auth_when_server_down_for_unknown_client).toBe(true);
    expect(logsOf(result, 'warning')).toEqual([
      'The role of "critical-role" is not in the file: while no RADIUS server answers, the clients are let in on the VLAN of the port on 1/1/1',
      'The role of "reject-role" gives no VLAN that the file names: the clients that the RADIUS server rejects stay out on 1/1/1',
    ]);
    expect(JSON.stringify(result.logs)).not.toContain('FROM-NAC');
  });

  it('converts port security into mac_limit and persist_mac', async () => {
    const result = await convert(
      withVlans(
        port('1/1/1', 'port-access port-security\n    enable\n    client-limit 3\n    sticky-learn enable'),
        port('1/1/2', 'port-access port-security\n    enable'),
        // Without "enable", the limit limits nothing, as on the switch.
        port('1/1/3', 'port-access port-security\n    client-limit 3'),
      ),
    );

    expect(usageFor(result, '1/1/1')).toMatchObject({ mac_limit: 3, persist_mac: true });
    expect(usageFor(result, '1/1/2')).toMatchObject({ mac_limit: 1, persist_mac: false });
    expect(usageFor(result, '1/1/3')).toMatchObject({ mac_limit: 0, persist_mac: false });
  });

  it('reports the line of a nested block that has no rule', async () => {
    const result = await convert(withVlans(port('1/1/1', `${PORT_ACCESS} dot1x authenticator\n    macsec\n    enable`)));

    expect(usageFor(result, '1/1/1').port_auth).toBe('dot1x');
    expect(logsOf(result, 'warning')).toEqual(['Not converted: "dot1x authenticator: macsec" on 1/1/1']);
  });
});

describe('Aruba AOS-CX: storm control and DHCP snooping trust', () => {
  const port = (name: string, settings: string[]): string => [`interface ${name}`, '    no shutdown', '    no routing', '    vlan access 10', ...settings.map((setting) => `    ${setting}`)].join('\n');

  it('converts "rate-limit <traffic> <rate> percent" into storm_control', async () => {
    const result = await convert(withVlans(port('1/1/1', ['rate-limit broadcast 5 percent', 'rate-limit unknown-unicast 5 percent'])));

    expect(usageFor(result, '1/1/1').storm_control).toEqual({ no_broadcast: false, no_multicast: true, no_registered_multicast: true, no_unknown_unicast: false, percentage: 5 });
  });

  it('the limit of multicast also limits the broadcast, as on the switch', async () => {
    const result = await convert(withVlans(port('1/1/1', ['rate-limit multicast 10 percent'])));

    expect(usageFor(result, '1/1/1').storm_control).toEqual({ no_broadcast: false, no_multicast: false, no_registered_multicast: false, no_unknown_unicast: true, percentage: 10 });
  });

  it('keeps the highest level when the kinds of traffic have different levels, with a warning', async () => {
    const result = await convert(withVlans(port('1/1/1', ['rate-limit broadcast 2 percent', 'rate-limit unknown-unicast 8 percent'])));

    expect(usageFor(result, '1/1/1').storm_control).toMatchObject({ percentage: 8 });
    expect(logsOf(result, 'warning')).toEqual(['Storm control has one level per kind of traffic and Mist has one for the port: the highest one is kept on 1/1/1']);
  });

  it('leaves out a rate in kbps or packets per second, with a warning, and does not read the limit of ICMP', async () => {
    const result = await convert(withVlans(port('1/1/1', ['rate-limit broadcast 5000 kbps', 'rate-limit multicast 100 pps', 'rate-limit icmp ip 1000 kbps'])));

    expect(usageFor(result, '1/1/1')).not.toHaveProperty('storm_control');
    expect(logsOf(result, 'warning')).toEqual(['Storm control with a level in bits or packets per second has no equivalent, Mist takes a percentage: left out on 1/1/1', 'Not converted: "rate-limit" on 1/1/1']);
  });

  it('converts "dhcpv4-snooping trust" into allow_dhcpd, and a trunk without it is not trusted when the switch snoops', async () => {
    const result = await convert(
      cx(`
      dhcpv4-snooping
      vlan 1
      vlan 10
          name USERS
          dhcpv4-snooping
      interface 1/1/1
          no shutdown
          no routing
          vlan trunk native 1
          vlan trunk allowed 10
          dhcpv4-snooping trust
      interface 1/1/2
          no shutdown
          no routing
          vlan trunk native 1
          vlan trunk allowed 10
      interface 1/1/3
          no shutdown
          no routing
          vlan access 10
      `),
    );

    expect(usageFor(result, '1/1/1').allow_dhcpd).toBe(true);
    expect(usageFor(result, '1/1/2').allow_dhcpd).toBe(false);
    expect(usageFor(result, '1/1/3')).not.toHaveProperty('allow_dhcpd');
    expect(logsOf(result, 'warning')).toEqual(['DHCP snooping: the trunk has no "dhcpv4-snooping trust", DHCP servers are refused on it on 1/1/2']);
  });

  it('without DHCP snooping, a trunk says nothing about DHCP', async () => {
    const result = await convert(withVlans('interface 1/1/1\n    no shutdown\n    no routing\n    vlan trunk native 1\n    vlan trunk allowed 10\n'));

    expect(usageFor(result, '1/1/1')).not.toHaveProperty('allow_dhcpd');
  });

  it('a link aggregation is trusted when one of its members is', async () => {
    const result = await convert(
      cx(`
      dhcpv4-snooping
      vlan 1
      vlan 10
          dhcpv4-snooping
      interface lag 1
          no shutdown
          no routing
          vlan trunk native 1
          vlan trunk allowed 10
          lacp mode active
      interface 1/1/49
          no shutdown
          lag 1
          dhcpv4-snooping trust
      `),
    );

    expect(usageOfPort(result, 'ge-0/0/48').allow_dhcpd).toBe(true);
    expect(logsOf(result, 'warning')).toEqual([]);
  });
});

describe('Aruba AOS-CX: system settings', () => {
  it('reads the NTP servers, the DNS servers and the domain', async () => {
    const result = await convert(
      withVlans(`
      ntp server 10.0.0.123 iburst
      ntp server pool.example.net minpoll 4 maxpoll 4 iburst
      ntp enable
      ntp vrf mgmt
      ip dns domain-name corp.example.com vrf mgmt
      ip dns server-address 10.0.0.53 vrf mgmt
      ip dns server-address 10.0.1.53
      `),
    );

    expect(result.template.ntp_servers).toEqual(['10.0.0.123', 'pool.example.net']);
    expect(result.template.dns_servers).toEqual(['10.0.0.53', '10.0.1.53']);
    expect(result.template.dns_suffix).toEqual(['corp.example.com']);
    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual([]);
  });

  it('reads the syslog servers with their protocol and port', async () => {
    const result = await convert(
      withVlans(`
      logging 10.0.0.60
      logging 10.0.1.60 tcp 1514 severity warning vrf mgmt
      logging 10.0.2.60 tcp
      logging 10.0.3.60 tls vrf mgmt
      logging facility local5
      `),
    );

    expect(result.template.remote_syslog.servers.map((server) => `${server.protocol}://${server.host}:${server.port}`)).toEqual(['udp://10.0.0.60:514', 'tcp://10.0.1.60:1514', 'tcp://10.0.2.60:1470', 'tls://10.0.3.60:6514']);
  });

  it('reads the RADIUS servers with their ports and timeouts, and never their keys', async () => {
    const result = await convert(
      withVlans(`
      radius-server timeout 8
      radius-server host 10.0.0.80 key ciphertext AQBapK3yOfS3rv3r1 vrf mgmt
      radius-server host 10.0.1.80 key plaintext port timeout 3 port 1645 acct-port 1646 vrf mgmt
      radius-server host nac.example.net
      aaa group server radius NAC
          server 10.0.0.80 vrf mgmt
          server 10.0.1.80 vrf mgmt
      `),
    );

    const radius = result.template.radius_config;
    expect(endpoints(radius.auth_servers)).toEqual(['10.0.0.80:1812', '10.0.1.80:1645', 'nac.example.net:1812']);
    expect(endpoints(radius.acct_servers)).toEqual(['10.0.0.80:1813', '10.0.1.80:1646', 'nac.example.net:1813']);
    expect(radius.auth_servers.map((server) => server.timeout)).toEqual([8, 3, 8]);
    expect(radius.auth_servers.map((server) => server.secret)).toEqual(['to_be_replaced', 'to_be_replaced', 'to_be_replaced']);
    expect(JSON.stringify(result)).not.toContain('AQBapK3yOfS3rv3r1');
    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual([]);
  });

  it('reads the change of authorization of RADIUS, on port 3799 unless the file names another one', async () => {
    const standard = await convert(withVlans('radius dyn-authorization enable\nradius dyn-authorization client 10.0.0.80 secret-key ciphertext AQBapC0aK3y vrf mgmt\n'));
    const other = await convert(withVlans('radius dyn-authorization port 1700\nradius dyn-authorization enable\n'));
    const none = await convert(withVlans('radius dyn-authorization client 10.0.0.80 secret-key ciphertext AQBapC0aK3y\n'));

    expect(standard.template.radius_config).toMatchObject({ coa_enabled: true, coa_port: 3799 });
    expect(other.template.radius_config).toMatchObject({ coa_enabled: true, coa_port: 1700 });
    expect(none.template.radius_config.coa_enabled).toBe(false);
    expect(JSON.stringify(standard)).not.toContain('AQBapC0aK3y');
  });

  it('reads the TACACS+ servers', async () => {
    const result = await convert(withVlans('tacacs-server host 10.0.0.49 key ciphertext AQBapT4cK3y vrf mgmt\ntacacs-server host 10.0.1.49 port 4949\n'));

    expect(result.template.switch_mgmt.tacacs.enabled).toBe(true);
    expect(endpoints(result.template.switch_mgmt.tacacs.tacplus_servers)).toEqual(['10.0.0.49:49', '10.0.1.49:4949']);
    expect(endpoints(result.template.switch_mgmt.tacacs.acct_servers)).toEqual(['10.0.0.49:49', '10.0.1.49:4949']);
    expect(JSON.stringify(result)).not.toContain('AQBapT4cK3y');
  });

  it('reads the banner, whose text ends at its delimiter', async () => {
    const result = await convert(cx('banner motd #\nAuthorized access only!\nSecond line.\n#\nvlan 10\n    name USERS\n'));

    expect(result.template.switch_mgmt.cli_banner).toBe('Authorized access only!\nSecond line.');
    expect(vlanIds(result)).toEqual({ users: 10 });
  });
});

describe('Aruba AOS-CX: SNMP', () => {
  it('gives a template without SNMP to a file without SNMP', async () => {
    const result = await convert(withVlans('ip dns domain-name example.net'));

    expect(result.template.snmp_config).toBeUndefined();
  });

  it('reads where the switch is, who to call and what it is', async () => {
    const result = await convert(
      withVlans(`
      snmp-server vrf mgmt
      snmp-server system-location Building A, floor 2
      snmp-server system-contact noc@example.com
      snmp-server system-description Access switch
      `),
    );

    expect(result.template.snmp_config).toEqual({ enabled: true, location: 'Building A, floor 2', contact: 'noc@example.com', description: 'Access switch' });
    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual([]);
  });

  it('reads the communities of version 2c with their rights, and hides the communities', async () => {
    const result = await convert(
      withVlans(`
      snmp-server community N3tMon
      snmp-server community wr1te
          access-level rw
      snmp-server community r3adOnly
          access-level ro
      `),
    );

    expect(result.template.snmp_config).toEqual({
      enabled: true,
      v2c_config: [
        { community_name: 'to_be_replaced_1', authorization: 'read-only' },
        { community_name: 'to_be_replaced_2', authorization: 'read-write' },
        { community_name: 'to_be_replaced_3', authorization: 'read-only' },
      ],
    });
    expect(logsOf(result, 'info').filter((message) => message.includes('community'))).toHaveLength(3);
    expect(JSON.stringify(result)).not.toMatch(/n3tmon|wr1te|r3adonly/i);
  });

  it('copies the communities when the option asks for it: an AOS-CX configuration has them in clear text', async () => {
    const result = await convertWith({ copyClearTextSecrets: true }, withVlans('snmp-server community N3tMon\nsnmp-server community wr1te\n    access-level rw\n'));

    expect(result.template.snmp_config?.v2c_config).toEqual([
      { community_name: 'N3tMon', authorization: 'read-only' },
      { community_name: 'wr1te', authorization: 'read-write' },
    ]);
    expect(logsOf(result, 'warning')).toEqual(['SNMP: 2 communities are copied into the template in clear text, as asked. Mind who gets the template']);
    expect(JSON.stringify(result.logs)).not.toMatch(/n3tmon|wr1te/i);
  });

  it('does not convert the access list of a community, and says that every station can use it', async () => {
    const result = await convert(withVlans('snmp-server community N3tMon\n    access-list ip NMS-ONLY\n'));

    expect(result.template.snmp_config?.v2c_config).toEqual([{ community_name: 'to_be_replaced_1', authorization: 'read-only' }]);
    expect(logsOf(result, 'warning')).toEqual(['SNMP: the access list of a community is not converted. The community has no client list: every station can use it']);
    expect(JSON.stringify(result)).not.toMatch(/NMS-ONLY|n3tmon/i);
  });

  it('turns the stations of versions 1 and 2c into trap groups, with the categories of what they ask for', async () => {
    const result = await convert(
      withVlans(`
      snmp-server host 10.0.0.70 trap version v2c community N3tMon vrf mgmt notification-type interface config mstp
      snmp-server host 10.0.0.71 inform version v2c community N3tMon port 162 notification-type fan power
      snmp-server host 10.0.0.72 trap version v1
      `),
    );

    expect(result.template.snmp_config?.trap_groups).toEqual([
      { group_name: 'traps_v2', version: 'v2', targets: ['10.0.0.70', '10.0.0.71'], categories: ['link', 'configuration', 'chassis'] },
      { group_name: 'traps_v1', version: 'v1', targets: ['10.0.0.72'], categories: [] },
    ]);
    expect(logsOf(result, 'info')).toContain('SNMP: 1 kind of notifications of "snmp-server host" have no category in Junos and are left out');
    expect(JSON.stringify(result)).not.toMatch(/n3tmon/i);
  });

  it('a trap group gets every category when one of its stations asks for everything', async () => {
    const result = await convert(withVlans('snmp-server host 10.0.0.70 trap version v2c notification-type interface\nsnmp-server host 10.0.0.71 trap version v2c community N3tMon port 1162\n'));

    expect(result.template.snmp_config?.trap_groups).toEqual([{ group_name: 'traps_v2', version: 'v2', targets: ['10.0.0.70', '10.0.0.71'], categories: [] }]);
    expect(logsOf(result, 'warning')).toEqual(['SNMP: a trap group has no port, the traps of versions 1 and 2c go to port 162']);
  });

  it('reads the users of version 3, gives them a group that reads everything, and never copies their keys', async () => {
    const result = await convertWith(
      { copyClearTextSecrets: true },
      withVlans(`
      snmpv3 user monitoring auth sha auth-pass ciphertext AQBapAuthK3y priv aes priv-pass ciphertext AQBapPrivK3y
      snmpv3 user monitoring context mgmt
      snmpv3 user auditor auth md5 auth-pass ciphertext AQBapAud1tK3y
      snmpv3 context mgmt vrf mgmt
      snmpv3 engine-id 8000b85c04
      snmp-server host 10.0.0.71 trap version v3 user monitoring port 1162 vrf mgmt
      `),
    );

    expect(result.template.snmp_config).toEqual({
      enabled: true,
      views: [{ view_name: 'all', oid: '.1', include: true }],
      v3_config: {
        usm: [
          {
            engine_type: 'local_engine',
            users: [
              { name: 'monitoring', authentication_type: 'authentication-sha', authentication_password: 'to_be_replaced', encryption_type: 'privacy-aes128', encryption_password: 'to_be_replaced' },
              { name: 'auditor', authentication_type: 'authentication-md5', authentication_password: 'to_be_replaced', encryption_type: 'privacy-none' },
            ],
          },
        ],
        vacm: {
          security_to_group: {
            security_model: 'usm',
            content: [
              { security_name: 'monitoring', group: 'snmpv3_ro' },
              { security_name: 'auditor', group: 'snmpv3_ro' },
            ],
          },
          access: [
            {
              group_name: 'snmpv3_ro',
              prefix_list: [
                { type: 'default_context_prefix', security_model: 'usm', security_level: 'privacy', read_view: 'all' },
                { type: 'default_context_prefix', security_model: 'usm', security_level: 'authentication', read_view: 'all' },
              ],
            },
          ],
        },
        notify: [{ name: 'traps', tag: 'traps', type: 'trap' }],
        target_address: [{ target_address_name: 'target_10.0.0.71', address: '10.0.0.71', port: '1162', tag_list: 'traps', target_parameters: 'traps_monitoring' }],
        target_parameters: [{ name: 'traps_monitoring', message_processing_model: 'v3', security_model: 'usm', security_level: 'privacy', security_name: 'monitoring' }],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/AQBap/);
    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual([]);
  });

  it('copies the passwords of version 3 that a script has in clear text, only when the option asks for it', async () => {
    const script = withVlans('snmpv3 user monitoring auth sha256 auth-pass plaintext Auth-Pa55 priv aes256 priv-pass plaintext Priv-Pa55\n');
    const hidden = await convert(script);
    const copied = await convertWith({ copyClearTextSecrets: true }, script);

    expect(hidden.template.snmp_config?.v3_config?.usm?.[0].users).toEqual([
      { name: 'monitoring', authentication_type: 'authentication-sha256', authentication_password: 'to_be_replaced', encryption_type: 'privacy-aes128', encryption_password: 'to_be_replaced' },
    ]);
    expect(JSON.stringify(hidden)).not.toMatch(/Pa55/);
    expect(copied.template.snmp_config?.v3_config?.usm?.[0].users).toEqual([
      { name: 'monitoring', authentication_type: 'authentication-sha256', authentication_password: 'Auth-Pa55', encryption_type: 'privacy-aes128', encryption_password: 'Priv-Pa55' },
    ]);
    expect(JSON.stringify(copied.logs)).not.toMatch(/Pa55/);
    expect(logsOf(hidden, 'warning')).toEqual(['SNMP version 3: the template has AES with 128 bits only, it is used in place of AES with 192 or 256 bits']);
  });

  it('reports an SNMP command without a rule by its keywords', async () => {
    const result = await convert(withVlans('snmp-server trap-source 10.99.0.11\nsnmp-server community N3tMon\n    view RESTRICTED\n'));

    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual(['Not converted: "snmp-server trap-source"', 'Not converted: "snmp-server community: view"']);
    expect(JSON.stringify(result)).not.toMatch(/RESTRICTED|n3tmon/i);
  });
});
