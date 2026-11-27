import { describe, expect, it } from 'vitest';
import { configuredPorts, convert, endpoints, junos, logsOf, missingNetworks, portConfig, switchRule, usageFor, vlanIds } from './support/harness';

describe('Junos: reading a file', () => {
  it('recognises "display set" output and reports it as converted', async () => {
    const result = await convert(
      junos(`
        admin@ex1> show configuration | display set
        set version 21.4R3-S5.4
        set system host-name ex1
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10

        {master:0}
        admin@ex1>
      `),
    );

    expect(result.files[0]).toMatchObject({ format: 'Juniper', success_vlan: true, success_config: true });
    expect(result.errors).toEqual([]);
    expect(logsOf(result, 'warning', 'error')).toEqual([]);
  });

  it('rejects a configuration that is not in "display set" format', async () => {
    const result = await convert(
      junos(`
        system {
            host-name ex1;
        }
        vlans {
            USERS {
                vlan-id 10;
            }
        }
      `),
    );

    expect(result.files[0]).toMatchObject({ format: 'Unknown', success_config: false });
    expect(result.files[0].error_message).toContain('Junos configuration with braces');
    expect(result.files[0].error_message).toContain('show configuration | display set');
    expect(result.template.networks).toEqual({});
  });

  it('flags a file without any VLAN', async () => {
    const result = await convert(
      junos(`
        set system host-name ex1
        set interfaces ge-0/0/0 description "Uplink"
      `),
    );

    expect(result.files[0]).toMatchObject({ success_vlan: false, success_config: true, error_message: 'Unable to retrieve the VLAN list' });
  });

  it('gives the same template for Windows (CRLF) and Unix (LF) line endings (B11)', async () => {
    const text = junos(`
      set system host-name ex1
      set system name-server 10.0.0.53
      set interfaces ge-0/0/0 description "User port"
      set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
      set interfaces irb unit 10 family inet address 10.1.10.1/24
      set vlans USERS vlan-id 10
      set vlans USERS l3-interface irb.10
    `);

    const unix = await convert(text);
    const windows = await convert(text.replace(/\n/g, '\r\n'));

    expect(unix.template.networks['users'].subnet).toBe('10.1.10.0/24');
    expect(windows.template).toEqual(unix.template);
  });
});

describe('Junos: VLANs', () => {
  it('turns VLANs into networks, names in lower case with "_" in place of "-"', async () => {
    const result = await convert(
      junos(`
        set vlans USERS vlan-id 10
        set vlans Guest-WiFi vlan-id 40
        set vlans default vlan-id 1
      `),
    );

    expect(vlanIds(result)).toEqual({ default: 1, users: 10, guest_wifi: 40 });
  });

  it('reads the subnet of a VLAN from its IRB interface', async () => {
    const result = await convert(
      junos(`
        set interfaces irb unit 10 family inet address 10.1.10.1/24
        set interfaces irb unit 20 family inet address 10.1.20.129/25
        set vlans USERS vlan-id 10
        set vlans USERS l3-interface irb.10
        set vlans VOICE vlan-id 20
        set vlans VOICE l3-interface irb.20
        set vlans PRINTERS vlan-id 30
      `),
    );

    expect(result.template.networks).toEqual({
      users: { vlan_id: '10', subnet: '10.1.10.0/24' },
      voice: { vlan_id: '20', subnet: '10.1.20.128/25' },
      printers: { vlan_id: '30', subnet: null },
    });
  });

  it('reads the subnet of a VLAN from a "vlan" interface (switches without ELS)', async () => {
    const result = await convert(
      junos(`
        set interfaces vlan unit 199 family inet address 10.3.99.13/24
        set vlans MGMT vlan-id 199
        set vlans MGMT l3-interface vlan.199
      `),
    );

    expect(result.template.networks).toEqual({ mgmt: { vlan_id: '199', subnet: '10.3.99.0/24' } });
  });

  it('enables DHCP snooping on the VLANs with "forwarding-options dhcp-security"', async () => {
    const result = await convert(
      junos(`
        set vlans USERS vlan-id 10
        set vlans USERS forwarding-options dhcp-security
        set vlans VOICE vlan-id 20
        set vlans GUEST-WIFI vlan-id 40
        set vlans GUEST-WIFI forwarding-options dhcp-security
      `),
    );

    expect(result.template.dhcp_snooping).toEqual({ enabled: true, networks: ['users', 'guest_wifi'] });
  });

  it('enables DHCP snooping on a VLAN whose "dhcp-security" has options (B15)', async () => {
    // "display set" does not print the bare "dhcp-security" line when the statement has options.
    const result = await convert(
      junos(`
        set vlans USERS vlan-id 10
        set vlans USERS forwarding-options dhcp-security arp-inspection
        set vlans VOICE vlan-id 20
        set vlans VOICE forwarding-options dhcp-security group TRUSTED overrides trusted
        set vlans VOICE forwarding-options dhcp-security group TRUSTED interface ge-0/0/47.0
        set vlans PRINTERS vlan-id 30
      `),
    );

    expect(result.template.dhcp_snooping).toEqual({ enabled: true, networks: ['users', 'voice'] });
  });

  it.todo('converts "arp-inspection" and "ip-source-guard" into enable_arp_spoof_check and enable_ip_source_guard');
});

describe('Junos: access ports', () => {
  it('converts the VLAN of an access port given by name or by id', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode access
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members 30
        set vlans USERS vlan-id 10
        set vlans PRINTERS vlan-id 30
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ mode: 'access', port_network: 'users', networks: [], all_networks: false });
    expect(usageFor(result, 'ge-0/0/1')).toMatchObject({ mode: 'access', port_network: 'printers', networks: [] });
  });

  it('converts MTU, speed, duplex and auto-negotiation', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 mtu 9216
        set interfaces ge-0/0/1 speed 100m
        set interfaces ge-0/0/1 link-mode full-duplex
        set interfaces ge-0/0/2 ether-options no-auto-negotiation
        set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
      `),
    );

    expect(Number(usageFor(result, 'ge-0/0/0').mtu)).toBe(9216);
    expect(usageFor(result, 'ge-0/0/1')).toMatchObject({ speed: '100m', duplex: 'full' });
    expect(usageFor(result, 'ge-0/0/2')).toMatchObject({ disable_autoneg: true });
    expect(usageFor(result, 'ge-0/0/3')).toMatchObject({ speed: 'auto', duplex: 'auto', disable_autoneg: false });
    expect(usageFor(result, 'ge-0/0/3').mtu).toBeUndefined();
  });

  it('converts PoE, QoS, STP edge and MAC limit, which are configured outside the interface', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/4 unit 0 family ethernet-switching vlan members USERS
        set poe interface all
        set poe interface ge-0/0/0 disable
        set class-of-service interfaces ge-0/0/1 scheduler-map voice
        set protocols rstp interface ge-0/0/2 edge
        set switch-options interface ge-0/0/3.0 interface-mac-limit 5
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ poe_disabled: true, enable_qos: false, stp_edge: false, mac_limit: 0 });
    expect(usageFor(result, 'ge-0/0/1')).toMatchObject({ poe_disabled: false, enable_qos: true });
    expect(usageFor(result, 'ge-0/0/2')).toMatchObject({ stp_edge: true });
    expect(usageFor(result, 'ge-0/0/3')).toMatchObject({ mac_limit: 5 });
    expect(usageFor(result, 'ge-0/0/4')).toMatchObject({ poe_disabled: false, enable_qos: false, stp_edge: false, mac_limit: 0 });
    expect(configuredPorts(result)).toEqual(['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3', 'ge-0/0/4']);
  });

  it('converts the voice VLAN given by id', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set switch-options voip interface ge-0/0/0.0 vlan 20
        set vlans USERS vlan-id 10
        set vlans VOICE vlan-id 20
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ port_network: 'users', voip_network: 'voice' });
  });

  it('converts a port with "disable" as disabled (B3)', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 disable
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 description "disable after the move"
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').disabled).toBe(true);
    expect(usageFor(result, 'ge-0/0/1').disabled).toBe(false);
  });

  it('converts the ports of an interface range with "disable" as disabled (B3)', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range UNUSED member ge-0/0/10
        set interfaces interface-range UNUSED member ge-0/0/11
        set interfaces interface-range UNUSED disable
        set interfaces interface-range UNUSED unit 0 family ethernet-switching vlan members PARKING
        set interfaces ge-0/0/10 description "Unused 10"
        set interfaces ge-0/0/11 description "Unused 11"
        set vlans PARKING vlan-id 999
      `),
    );

    expect(usageFor(result, 'ge-0/0/10').disabled).toBe(true);
    expect(usageFor(result, 'ge-0/0/11').disabled).toBe(true);
  });

  it('a port without VLAN has a network (Junos puts it in the default VLAN) (B14)', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').port_network).toBeDefined();
  });

  it('the voice VLAN given by name refers to an existing network (B7)', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set switch-options voip interface ge-0/0/0.0 vlan VOICE
        set vlans USERS vlan-id 10
        set vlans VOICE vlan-id 20
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').voip_network).toBe('voice');
    expect(missingNetworks(result)).toEqual([]);
  });

  it('"switch-options voip interface access-ports" does not create a port named "access-ports" (B8)', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set switch-options voip interface access-ports vlan VOICE
        set vlans USERS vlan-id 10
        set vlans VOICE vlan-id 20
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
  });

  it('"protocols rstp interface all" does not create a port named "all" (B13)', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set protocols rstp interface all edge
        set vlans USERS vlan-id 10
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
  });

  it('converts "storm-control <profile>" and its storm control profile into storm_control', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/0 unit 0 family ethernet-switching storm-control EDGE
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching storm-control default
        set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members USERS
        set forwarding-options storm-control-profiles EDGE all bandwidth-percentage 20
        set forwarding-options storm-control-profiles EDGE all no-broadcast
        set forwarding-options storm-control-profiles EDGE all no-registered-multicast
        set forwarding-options storm-control-profiles EDGE action-shutdown
        set forwarding-options storm-control-profiles default all
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').storm_control).toEqual({ no_broadcast: true, no_multicast: false, no_registered_multicast: true, no_unknown_unicast: false, percentage: 20, disable_port: true });
    // Without a level, Junos limits the traffic to 80 % of the bandwidth.
    expect(usageFor(result, 'ge-0/0/1').storm_control).toEqual({ no_broadcast: false, no_multicast: false, no_registered_multicast: false, no_unknown_unicast: false, percentage: 80 });
    expect(usageFor(result, 'ge-0/0/2')).not.toHaveProperty('storm_control');
    expect(logsOf(result, 'warning').join('\n')).not.toMatch(/storm control/i);
  });

  it('gives the storm control of an interface range to its ports', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range DESKS member-range ge-0/0/0 to ge-0/0/1
        set interfaces interface-range DESKS unit 0 family ethernet-switching vlan members USERS
        set interfaces interface-range DESKS unit 0 family ethernet-switching storm-control EDGE
        set forwarding-options storm-control-profiles EDGE all bandwidth-percentage 5
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/1').storm_control?.percentage).toBe(5);
  });

  it('leaves out a storm control profile that is not defined or has a level in kilobits per second, with a warning', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/0 unit 0 family ethernet-switching storm-control MISSING
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching storm-control KBPS
        set forwarding-options storm-control-profiles KBPS all bandwidth-level 5000
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).not.toHaveProperty('storm_control');
    expect(usageFor(result, 'ge-0/0/1')).not.toHaveProperty('storm_control');
    const warnings = logsOf(result, 'warning').join('\n');
    expect(warnings).toContain('is not defined in the file: left out on ge-0/0/0');
    expect(warnings).toContain('Mist takes a percentage: left out on ge-0/0/1');
  });

  it('reads the storm control of a switch without ELS: for all ports, and for one port', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set ethernet-switching-options storm-control action-shutdown
        set ethernet-switching-options storm-control interface all
        set ethernet-switching-options storm-control interface ge-0/0/1.0 level 30
        set ethernet-switching-options storm-control interface ge-0/0/1.0 no-unknown-unicast
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').storm_control).toEqual({ no_broadcast: false, no_multicast: false, no_registered_multicast: false, no_unknown_unicast: false, percentage: 80, disable_port: true });
    // What a port says for itself replaces what "all" says.
    expect(usageFor(result, 'ge-0/0/1').storm_control).toEqual({ no_broadcast: false, no_multicast: false, no_registered_multicast: false, no_unknown_unicast: true, percentage: 30, disable_port: true });
  });

  it('converts the trusted and untrusted groups of "dhcp-security" into allow_dhcpd', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/2 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/3 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/4 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
        set vlans USERS forwarding-options dhcp-security group SERVERS overrides trusted
        set vlans USERS forwarding-options dhcp-security group SERVERS interface ge-0/0/1.0
        set vlans USERS forwarding-options dhcp-security group GUESTS interface ge-0/0/3.0
        set vlans USERS forwarding-options dhcp-security group GUESTS overrides untrusted
        set vlans USERS forwarding-options dhcp-security group OPTIONS interface ge-0/0/4.0
        set vlans USERS forwarding-options dhcp-security group OPTIONS overrides no-option82
      `),
    );

    // Junos and Mist agree on the ports that say nothing: a trunk is trusted, an access port is not.
    expect(usageFor(result, 'ge-0/0/0')).not.toHaveProperty('allow_dhcpd');
    expect(usageFor(result, 'ge-0/0/1').allow_dhcpd).toBe(true);
    expect(usageFor(result, 'ge-0/0/2')).not.toHaveProperty('allow_dhcpd');
    expect(usageFor(result, 'ge-0/0/3').allow_dhcpd).toBe(false);
    expect(usageFor(result, 'ge-0/0/4')).not.toHaveProperty('allow_dhcpd');
    expect(result.template.dhcp_snooping).toEqual({ enabled: true, networks: ['users'] });
  });

  it('converts "dhcp-trusted" and "no-dhcp-trusted" of a switch without ELS into allow_dhcpd', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching port-mode trunk
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set ethernet-switching-options secure-access-port interface ge-0/0/0.0 dhcp-trusted
        set ethernet-switching-options secure-access-port interface ge-0/0/1.0 no-dhcp-trusted
        set ethernet-switching-options secure-access-port vlan USERS examine-dhcp
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').allow_dhcpd).toBe(true);
    expect(usageFor(result, 'ge-0/0/1').allow_dhcpd).toBe(false);
  });

  it('reports a routed port ("family inet" on a physical port) and does not convert it', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 description "Link to the router"
        set interfaces ge-0/0/0 unit 0 family inet address 10.0.0.1/30
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/1']);
    expect(logsOf(result, 'warning')).toContain('Interface ge-0/0/0: routed port (it has an address or tagged units of its own), not converted');
    expect(Object.values(result.template.networks).map((network) => network.subnet)).not.toContain('10.0.0.0/30');
  });

  it('reads a list of VLANs between brackets, as typed in configuration mode', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members [ USERS VOICE ]
        set vlans USERS vlan-id 10
        set vlans VOICE vlan-id 20
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ mode: 'trunk', networks: ['users', 'voice'] });
  });
});

describe('Junos: trunk ports', () => {
  it('converts the member VLANs and the native VLAN', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 native-vlan-id 99
        set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members GUEST-WIFI
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members 20
        set vlans USERS vlan-id 10
        set vlans VOICE vlan-id 20
        set vlans GUEST-WIFI vlan-id 40
        set vlans MGMT vlan-id 99
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({
      mode: 'trunk',
      port_network: 'mgmt',
      networks: ['users', 'guest_wifi', 'voice'],
      all_networks: false,
    });
  });

  it('converts a range of VLAN ids into the networks that exist in that range', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members 10-30
        set vlans USERS vlan-id 10
        set vlans VOICE vlan-id 20
        set vlans GUEST-WIFI vlan-id 40
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').networks).toEqual(['users', 'voice']);
  });

  it('allows all networks on a trunk with "vlan members all"', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members all
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ mode: 'trunk', all_networks: true, networks: [] });
  });

  it('a trunk written with "port-mode trunk" (switches without ELS) stays a trunk (B12)', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching port-mode trunk
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members VOICE
        set vlans USERS vlan-id 10
        set vlans VOICE vlan-id 20
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ mode: 'trunk', networks: ['users', 'voice'] });
  });
});

describe('Junos: 802.1X', () => {
  const PORT = `
    set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
    set vlans USERS vlan-id 10
    set vlans GUEST-WIFI vlan-id 40
  `;

  it('converts 802.1X, MAC authentication and the fallback when the server is down', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/2 unit 0 family ethernet-switching vlan members USERS
        set protocols dot1x authenticator interface ge-0/0/0.0 supplicant multiple
        set protocols dot1x authenticator interface ge-0/0/0.0 mac-radius authentication-protocol pap
        set protocols dot1x authenticator interface ge-0/0/0.0 server-fail use-cache
        set protocols dot1x authenticator interface ge-0/0/1.0 mac-radius restrict
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: true, mac_auth_only: false, bypass_auth_when_server_down: true });
    expect(usageFor(result, 'ge-0/0/1')).toMatchObject({ port_auth: 'dot1x', mac_auth_only: true, bypass_auth_when_server_down: false });
    expect(usageFor(result, 'ge-0/0/2').port_auth).toBeUndefined();
  });

  it('converts the guest VLAN given by id', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set protocols dot1x authenticator interface ge-0/0/0.0 guest-vlan 40
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ port_auth: 'dot1x', guest_network: 'guest_wifi' });
  });

  it('"mac-radius" without option enables MAC authentication (B6)', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set protocols dot1x authenticator interface ge-0/0/0.0 supplicant multiple
        set protocols dot1x authenticator interface ge-0/0/0.0 mac-radius
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ port_auth: 'dot1x', enable_mac_auth: true });
  });

  it('the guest VLAN given by name refers to an existing network (B7)', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set protocols dot1x authenticator interface ge-0/0/0.0 guest-vlan GUEST-WIFI
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').guest_network).toBe('guest_wifi');
    expect(missingNetworks(result)).toEqual([]);
  });

  it('converts "server-reject-vlan" into server_reject_network', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set protocols dot1x authenticator interface ge-0/0/0.0 server-reject-vlan GUEST-WIFI
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ port_auth: 'dot1x', server_reject_network: 'guest_wifi' });
  });

  it('converts "server-fail vlan-name" into server_fail_network', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set protocols dot1x authenticator interface ge-0/0/0.0 server-fail vlan-name GUEST-WIFI
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ port_auth: 'dot1x', server_fail_network: 'guest_wifi' });
  });

  it('converts "server-fail permit": every client is let in while the RADIUS servers are down', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set protocols dot1x authenticator interface ge-0/0/0.0 server-fail permit
      `),
    );

    const usage = usageFor(result, 'ge-0/0/0');
    expect(usage.bypass_auth_when_server_down_for_unknown_client).toBe(true);
    expect(usage.bypass_auth_when_server_down).toBe(false);
  });

  it('converts "supplicant multiple" into allow_multiple_supplicants, and not "supplicant single"', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set protocols dot1x authenticator interface ge-0/0/0.0 supplicant multiple
        set protocols dot1x authenticator interface ge-0/0/1.0 supplicant single
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').allow_multiple_supplicants).toBe(true);
    expect(usageFor(result, 'ge-0/0/1')).not.toHaveProperty('allow_multiple_supplicants');
  });

  it('converts "reauthentication <seconds>" into reauth_interval', async () => {
    const result = await convert(
      junos(`
        ${PORT}
        set protocols dot1x authenticator interface ge-0/0/0.0 reauthentication 7200
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').reauth_interval).toBe(7200);
  });
});

describe('Junos: switch rule and port names', () => {
  it('creates one switch rule per device, matched on the hostname, with the port descriptions', async () => {
    const result = await convert(
      junos(`
        set system host-name ex-floor1
        set interfaces ge-0/0/0 description "Reception desk"
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces xe-0/2/0 description "Uplink"
        set interfaces xe-0/2/0 unit 0 family ethernet-switching interface-mode trunk
        set interfaces xe-0/2/0 unit 0 family ethernet-switching vlan members all
        set vlans USERS vlan-id 10
      `),
    );

    expect(switchRule(result)).toMatchObject({ name: 'ex-floor1', 'match_name[0:9]': 'ex-floor1' });
    expect(portConfig(result, 'ge-0/0/0')).toEqual({ key: 'ge-0/0/0', usage: 'reception_desk', description: 'Reception desk' });
    expect(portConfig(result, 'xe-0/2/0')).toEqual({ key: 'xe-0/2/0', usage: 'uplink', description: 'Uplink' });
  });

  it('does not turn IRB, management and loopback interfaces into ports', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces irb unit 10 family inet address 10.1.10.1/24
        set interfaces lo0 unit 0 family inet address 10.255.0.1/32
        set interfaces me0 unit 0 family inet address 192.168.1.1/24
        set interfaces vme unit 0 family inet address 192.168.1.2/24
        set interfaces em0 unit 0 family inet address 192.168.1.3/24
        set vlans USERS vlan-id 10
      `),
    );

    expect(configuredPorts(result)).toEqual(['ge-0/0/0']);
  });
});

describe('Junos: link aggregation', () => {
  it('configures the members of an aggregated interface as one entry with the usage of that interface', async () => {
    const result = await convert(
      junos(`
        set interfaces xe-0/2/0 ether-options 802.3ad ae0
        set interfaces xe-0/2/1 ether-options 802.3ad ae0
        set interfaces xe-0/2/2 ether-options 802.3ad ae1
        set interfaces ae0 description "Uplink core"
        set interfaces ae0 aggregated-ether-options lacp active
        set interfaces ae0 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ae0 unit 0 family ethernet-switching vlan members all
        set interfaces ae1 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ae1 unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
      `),
    );

    expect(Object.keys(switchRule(result).port_config)).toEqual(['xe-0/2/0,xe-0/2/1', 'xe-0/2/2']);
    expect(portConfig(result, 'xe-0/2/0')).toEqual({ key: 'xe-0/2/0,xe-0/2/1', aggregated: true, ae_idx: 0, description: 'Uplink core', usage: 'uplink_core' });
    expect(portConfig(result, 'xe-0/2/2')).toMatchObject({ aggregated: true, ae_idx: 1 });
    expect(usageFor(result, 'ae0')).toMatchObject({ mode: 'trunk', all_networks: true });
    expect(usageFor(result, 'ae1')).toMatchObject({ mode: 'trunk', networks: ['users'] });
  });

  it('keeps the number of an aggregated interface above ae9 (B9)', async () => {
    const result = await convert(
      junos(`
        set interfaces xe-0/2/0 ether-options 802.3ad ae10
        set interfaces ae10 unit 0 family ethernet-switching interface-mode trunk
        set interfaces ae10 unit 0 family ethernet-switching vlan members all
        set vlans USERS vlan-id 10
      `),
    );

    expect(portConfig(result, 'xe-0/2/0')).toMatchObject({ aggregated: true, ae_idx: 10 });
  });
});

describe('Junos: interface ranges', () => {
  it('names the port usage after the interface range and applies what is configured on the range by name', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range ACCESS-PORTS member-range ge-0/0/0 to ge-0/0/3
        set interfaces interface-range ACCESS-PORTS mtu 9216
        set interfaces ge-0/0/1 description "Desk 12"
        set interfaces ge-0/0/2 description "Desk 13"
        set protocols rstp interface ACCESS-PORTS edge
        set protocols dot1x authenticator interface ACCESS-PORTS supplicant multiple
        set vlans USERS vlan-id 10
      `),
    );

    expect(result.ports.map((port) => [port.source, port.usage])).toEqual([
      ['ge-0/0/0', 'access_ports'],
      ['ge-0/0/1', 'access_ports'],
      ['ge-0/0/2', 'access_ports'],
      ['ge-0/0/3', 'access_ports'],
    ]);
    expect(usageFor(result, 'ge-0/0/1')).toMatchObject({ stp_edge: true, port_auth: 'dot1x' });
    expect(Number(usageFor(result, 'ge-0/0/1').mtu)).toBe(9216);
  });

  it('accepts "member" with a single port and with a list in brackets', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range PRINTERS member ge-0/0/10
        set interfaces interface-range PRINTERS member "ge-0/0/[20-21]"
        set interfaces interface-range PRINTERS mtu 9216
        set interfaces ge-0/0/10 description "Printer 1"
        set interfaces ge-0/0/21 description "Printer 2"
        set interfaces ge-0/0/22 description "Not in the range"
        set vlans PRINTERS vlan-id 30
      `),
    );

    expect(result.ports.map((port) => [port.source, port.usage])).toEqual([
      ['ge-0/0/10', 'printers'],
      ['ge-0/0/20', 'printers'],
      ['ge-0/0/21', 'printers'],
      ['ge-0/0/22', 'not_in_the_range'],
    ]);
  });

  it('creates the ports of an interface range that have no configuration of their own (B1)', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range ACCESS-PORTS member-range ge-0/0/0 to ge-0/0/3
        set interfaces interface-range ACCESS-PORTS unit 0 family ethernet-switching vlan members USERS
        set vlans USERS vlan-id 10
      `),
    );

    expect(result.template.switch_matching.rules).toHaveLength(1);
    expect(configuredPorts(result)).toEqual(['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3']);
  });

  it('a port of an interface range keeps the VLAN of the range when it also has its own configuration (B2)', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range ACCESS-PORTS member-range ge-0/0/0 to ge-0/0/3
        set interfaces interface-range ACCESS-PORTS unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 description "Desk 12"
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/1')).toMatchObject({ mode: 'access', port_network: 'users' });
  });

  it('what is configured on one port of an interface range does not leak to the other ports (B2)', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range ACCESS-PORTS member-range ge-0/0/0 to ge-0/0/3
        set interfaces interface-range ACCESS-PORTS mtu 9216
        set interfaces ge-0/0/1 description "Old printer"
        set interfaces ge-0/0/1 speed 100m
        set interfaces ge-0/0/2 description "Desk 13"
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/1').speed).toBe('100m');
    expect(usageFor(result, 'ge-0/0/2').speed).toBe('auto');
  });

  it('an interface range with a wildcard member does not stop the conversion of the other ranges (B10)', async () => {
    const result = await convert(
      junos(`
        set interfaces interface-range ALL-PORTS member ge-0/0/*
        set interfaces interface-range ALL-PORTS mtu 9216
        set interfaces interface-range UPLINKS member xe-0/2/0
        set interfaces interface-range UPLINKS mtu 9216
        set interfaces xe-0/2/0 description "Uplink"
        set vlans USERS vlan-id 10
      `),
    );

    expect(result.errors).toEqual([]);
    expect(Number(usageFor(result, 'xe-0/2/0').mtu)).toBe(9216);
  });
});

describe('Junos: system settings', () => {
  it('converts DNS servers, DNS suffix, NTP servers and the login message', async () => {
    const result = await convert(
      junos(`
        set system domain-search corp.example.com
        set system name-server 10.0.0.53
        set system name-server 10.0.1.53
        set system ntp server 10.0.0.123
        set system ntp server 10.0.1.123 prefer
        set system login message "Authorized access only\\nAll activity is logged"
      `),
    );

    expect(result.template.dns_servers).toEqual(['10.0.0.53', '10.0.1.53']);
    expect(result.template.dns_suffix).toEqual(['corp.example.com']);
    expect(result.template.ntp_servers).toEqual(['10.0.0.123', '10.0.1.123']);
    expect(result.template.switch_mgmt.cli_banner).toBe('Authorized access only\nAll activity is logged');
  });

  it('converts syslog servers with their port', async () => {
    const result = await convert(
      junos(`
        set system syslog host 10.0.0.60 any any
        set system syslog host 10.0.0.61 any any
        set system syslog host 10.0.0.61 port 1514
      `),
    );

    expect(result.template.remote_syslog.enabled).toBe(true);
    expect(endpoints(result.template.remote_syslog.servers)).toEqual(['10.0.0.60:514', '10.0.0.61:1514']);
  });

  it('converts RADIUS servers with their port and timeout, and never copies the secret', async () => {
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.80 port 1812
        set access radius-server 10.0.0.80 secret "REDACTED"
        set access radius-server 10.0.0.80 timeout 10
        set access radius-server 10.0.0.80 source-address 10.99.0.12
      `),
    );

    expect(result.template.radius_config.auth_servers).toEqual([{ host: '10.0.0.80', port: '1812', secret: 'to_be_replaced', timeout: 10 }]);
  });

  it('converts TACACS+ servers with their port, for authentication and accounting', async () => {
    const result = await convert(
      junos(`
        set system tacplus-server 10.0.0.70 port 4949
        set system tacplus-server 10.0.0.70 secret "REDACTED"
        set system accounting destination tacplus server 10.0.0.70 port 4949
        set system accounting destination tacplus server 10.0.0.70 secret "REDACTED"
      `),
    );

    const tacacs = result.template.switch_mgmt.tacacs;
    expect(tacacs.enabled).toBe(true);
    expect(endpoints(tacacs.tacplus_servers)).toEqual(['10.0.0.70:4949']);
    expect(endpoints(tacacs.acct_servers)).toEqual(['10.0.0.70:4949']);
    expect(JSON.stringify(result.template)).not.toContain('REDACTED');
  });

  it('keeps a RADIUS server that uses the default port (B4)', async () => {
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.80 secret "REDACTED"
        set access radius-server 10.0.0.81 port 1645
        set access radius-server 10.0.0.81 secret "REDACTED"
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toEqual(['10.0.0.80:1812', '10.0.0.81:1645']);
  });

  it('a RADIUS server does not inherit the port of the server before it (B4)', async () => {
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.81 port 1645
        set access radius-server 10.0.0.81 secret "REDACTED"
        set access radius-server 10.0.0.82 secret "REDACTED"
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toEqual(['10.0.0.81:1645', '10.0.0.82:1812']);
  });

  it('a RADIUS server listed as "accounting-server" in the access profile is an accounting server (B16)', async () => {
    // The access profile says what a server is used for; "accounting-port" is only needed for a port other than 1813.
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.80 port 1812
        set access radius-server 10.0.0.80 secret "REDACTED"
        set access profile CAMPUS-AUTH authentication-order radius
        set access profile CAMPUS-AUTH radius authentication-server 10.0.0.80
        set access profile CAMPUS-AUTH radius accounting-server 10.0.0.80
        set protocols dot1x authenticator authentication-profile-name CAMPUS-AUTH
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toEqual(['10.0.0.80:1812']);
    expect(endpoints(result.template.radius_config.acct_servers)).toEqual(['10.0.0.80:1813']);
  });

  it('leaves out, and names, a RADIUS server that the access profile does not list', async () => {
    const result = await convert(
      junos(`
        set access radius-server 10.0.0.80 secret "REDACTED"
        set access radius-server 10.0.0.81 secret "REDACTED"
        set access profile CAMPUS-AUTH radius authentication-server 10.0.0.80
        set protocols dot1x authenticator authentication-profile-name CAMPUS-AUTH
      `),
    );

    expect(endpoints(result.template.radius_config.auth_servers)).toEqual(['10.0.0.80:1812']);
    expect(logsOf(result, 'info')).toContain('RADIUS servers that the access profile does not list are left out: 10.0.0.81');
  });

  it('a TACACS+ server without "port" uses port 49 (B5)', async () => {
    const result = await convert(junos('set system tacplus-server 10.0.0.70 secret "REDACTED"'));

    expect(endpoints(result.template.switch_mgmt.tacacs.tacplus_servers)).toEqual(['10.0.0.70:49']);
  });

  it('a syslog server does not inherit the port of the server before it (B5)', async () => {
    const result = await convert(
      junos(`
        set system syslog host 10.0.0.61 any any
        set system syslog host 10.0.0.61 port 1514
        set system syslog host 10.0.0.62 any any
      `),
    );

    expect(endpoints(result.template.remote_syslog.servers)).toEqual(['10.0.0.61:1514', '10.0.0.62:514']);
  });

  it('reads "system domain-name" as a DNS suffix', async () => {
    const result = await convert(junos('set system domain-name example.net'));

    expect(result.template.dns_suffix).toEqual(['example.net']);
  });

  it('converts "persistent-learning" into persist_mac', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members USERS
        set switch-options interface ge-0/0/0.0 persistent-learning
        set vlans USERS vlan-id 10
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').persist_mac).toBe(true);
    expect(usageFor(result, 'ge-0/0/1').persist_mac).toBe(false);
  });
});

describe('Junos: switches without ELS (EX2200, EX3300, EX4200...)', () => {
  const LEGACY_VLANS = `
    set vlans USERS vlan-id 10
    set vlans VOICE vlan-id 20
    set vlans MGMT vlan-id 99
  `;

  it('reads speed and duplex under "ether-options"', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 ether-options speed 100m
        set interfaces ge-0/0/0 ether-options link-mode full-duplex
        set interfaces ge-0/0/0 ether-options no-auto-negotiation
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        ${LEGACY_VLANS}
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ speed: '100m', duplex: 'full', disable_autoneg: true });
  });

  it('reads "port-mode" and "native-vlan-id" under "family ethernet-switching"', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching port-mode trunk
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members VOICE
        set interfaces ge-0/0/0 unit 0 family ethernet-switching native-vlan-id 99
        ${LEGACY_VLANS}
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ mode: 'trunk', networks: ['users', 'voice'], port_network: 'mgmt' });
  });

  it('reads the voice VLAN from "ethernet-switching-options voip"', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set ethernet-switching-options voip interface ge-0/0/0.0 vlan VOICE
        ${LEGACY_VLANS}
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ port_network: 'users', voip_network: 'voice' });
  });

  it('reads DHCP snooping from "ethernet-switching-options secure-access-port vlan <name> examine-dhcp"', async () => {
    const result = await convert(
      junos(`
        set ethernet-switching-options secure-access-port vlan USERS examine-dhcp
        ${LEGACY_VLANS}
      `),
    );

    expect(result.template.dhcp_snooping).toEqual({ enabled: true, networks: ['users'] });
  });

  it('reads the MAC limit and persistent learning from "ethernet-switching-options secure-access-port interface"', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members USERS
        set ethernet-switching-options secure-access-port interface ge-0/0/0.0 mac-limit 4
        set ethernet-switching-options secure-access-port interface ge-0/0/0.0 persistent-learning
        ${LEGACY_VLANS}
      `),
    );

    expect(usageFor(result, 'ge-0/0/0')).toMatchObject({ mac_limit: 4, persist_mac: true });
  });

  it('reads the ports listed under "vlans <name> interface"', async () => {
    const result = await convert(
      junos(`
        set interfaces ge-0/0/0 unit 0 family ethernet-switching
        set interfaces ge-0/0/1 unit 0 family ethernet-switching
        set vlans USERS interface ge-0/0/0.0
        ${LEGACY_VLANS}
      `),
    );

    expect(usageFor(result, 'ge-0/0/0').port_network).toBe('users');
    // A port that no VLAN lists is in the default VLAN.
    expect(usageFor(result, 'ge-0/0/1').port_network).toBe('default');
    expect(missingNetworks(result)).toEqual([]);
  });
});

describe('Junos: SNMP', () => {
  it('gives a template without SNMP to a file without SNMP', async () => {
    const result = await convert(junos('set vlans USERS vlan-id 10'));

    expect(result.template.snmp_config).toBeUndefined();
  });

  it('reads where the switch is and who to call', async () => {
    const result = await convert(
      junos(`
        set snmp location "Building A, floor 2"
        set snmp contact "noc@example.com"
        set snmp description "Access switch"
        set snmp engine-id use-mac-address
      `),
    );

    expect(result.template.snmp_config).toEqual({ enabled: true, location: 'Building A, floor 2', contact: 'noc@example.com', description: 'Access switch', engine_id_type: 'use_mac_address' });
  });

  it('reads the communities of version 2c with their rights, client lists and views, and hides the communities', async () => {
    const result = await convert(
      junos(`
        set snmp client-list MONITORING 10.0.0.0/24
        set snmp client-list MONITORING 10.0.1.0/24
        set snmp view SYSTEM oid .1.3.6.1.2.1.1 include
        set snmp view SYSTEM oid .1.3.6.1.2.1.1.9 exclude
        set snmp view EVERYTHING oid .1
        set snmp community n3tmon authorization read-only
        set snmp community n3tmon client-list-name MONITORING
        set snmp community wr1te authorization read-write
        set snmp community wr1te view SYSTEM
        set snmp community bare
      `),
    );

    expect(result.template.snmp_config).toEqual({
      enabled: true,
      client_list: [{ client_list_name: 'MONITORING', clients: ['10.0.0.0/24', '10.0.1.0/24'] }],
      views: [
        { view_name: 'SYSTEM', oid: '.1.3.6.1.2.1.1', include: true },
        { view_name: 'SYSTEM', oid: '.1.3.6.1.2.1.1.9', include: false },
        { view_name: 'EVERYTHING', oid: '.1', include: true },
      ],
      v2c_config: [
        { community_name: 'to_be_replaced_1', authorization: 'read-only', client_list_name: 'MONITORING' },
        { community_name: 'to_be_replaced_2', authorization: 'read-write', view: 'SYSTEM' },
        // Without "authorization", a community can only read.
        { community_name: 'to_be_replaced_3', authorization: 'read-only' },
      ],
    });
    // The message gives the line of the community, not the community.
    expect(result.logs.filter((entry) => entry.message.includes('community'))).toEqual([
      { level: 'info', file: 'file1.txt', lines: [6], message: 'SNMP: the community of this line is "to_be_replaced_1" in the template. A community is a password: type it in the template, or turn on "Copy the SNMP secrets that are in clear text"' },
      { level: 'info', file: 'file1.txt', lines: [8], message: 'SNMP: the community of this line is "to_be_replaced_2" in the template. A community is a password: type it in the template, or turn on "Copy the SNMP secrets that are in clear text"' },
      { level: 'info', file: 'file1.txt', lines: [10], message: 'SNMP: the community of this line is "to_be_replaced_3" in the template. A community is a password: type it in the template, or turn on "Copy the SNMP secrets that are in clear text"' },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/n3tmon|wr1te|bare/);
  });

  it('turns the clients written under a community into a client list', async () => {
    const result = await convert(
      junos(`
        set snmp community n3tmon clients 10.0.0.70/32
        set snmp community n3tmon clients 10.0.0.71/32
      `),
    );

    expect(result.template.snmp_config).toMatchObject({
      client_list: [{ client_list_name: 'community_1_clients', clients: ['10.0.0.70/32', '10.0.0.71/32'] }],
      v2c_config: [{ community_name: 'to_be_replaced_1', authorization: 'read-only', client_list_name: 'community_1_clients' }],
    });
  });

  it('reports a client that a community refuses: a client list cannot say that', async () => {
    const result = await convert(
      junos(`
        set snmp community n3tmon clients 10.0.0.0/24
        set snmp community n3tmon clients 10.0.0.9/32 restrict
      `),
    );

    expect(result.template.snmp_config?.client_list).toEqual([{ client_list_name: 'community_1_clients', clients: ['10.0.0.0/24'] }]);
    expect(logsOf(result, 'info')).toContain('Not converted: "snmp community"');
    expect(JSON.stringify(result.logs)).not.toContain('n3tmon');
  });

  it('reads the trap groups', async () => {
    const result = await convert(
      junos(`
        set snmp trap-group NMS version v2
        set snmp trap-group NMS categories link
        set snmp trap-group NMS categories authentication
        set snmp trap-group NMS targets 10.0.0.70
        set snmp trap-group NMS targets 10.0.0.71
        set snmp trap-group LEGACY targets 10.0.0.72
      `),
    );

    expect(result.template.snmp_config?.trap_groups).toEqual([
      { group_name: 'NMS', version: 'v2', targets: ['10.0.0.70', '10.0.0.71'], categories: ['link', 'authentication'] },
      { group_name: 'LEGACY', version: 'all', targets: ['10.0.0.72'], categories: [] },
    ]);
  });

  it('reads the users of version 3: their algorithms are kept, their keys are not', async () => {
    const result = await convert(
      junos(`
        set snmp v3 usm local-engine user monitor authentication-sha authentication-key "REDACTED"
        set snmp v3 usm local-engine user monitor privacy-aes128 privacy-key "REDACTED"
        set snmp v3 usm local-engine user reader authentication-sha256 authentication-key "REDACTED"
        set snmp v3 usm local-engine user anyone authentication-none
        set snmp v3 usm remote-engine 80000a4c010a000046 user informer authentication-md5 authentication-key "REDACTED"
        set snmp v3 usm remote-engine 80000a4c010a000046 user informer privacy-des privacy-key "REDACTED"
      `),
    );

    expect(result.template.snmp_config?.v3_config?.usm).toEqual([
      {
        engine_type: 'local_engine',
        users: [
          { name: 'monitor', authentication_type: 'authentication-sha', authentication_password: 'to_be_replaced', encryption_type: 'privacy-aes128', encryption_password: 'to_be_replaced' },
          { name: 'reader', authentication_type: 'authentication-sha256', authentication_password: 'to_be_replaced', encryption_type: 'privacy-none' },
          { name: 'anyone', authentication_type: 'authentication-none', encryption_type: 'privacy-none' },
        ],
      },
      {
        engine_type: 'remote_engine',
        remote_engine_id: '80000a4c010a000046',
        users: [{ name: 'informer', authentication_type: 'authentication-md5', authentication_password: 'to_be_replaced', encryption_type: 'privacy-des', encryption_password: 'to_be_replaced' }],
      },
    ]);
    expect(logsOf(result, 'info')).toContain('SNMP version 3: the passwords of 3 users are "to_be_replaced" in the template: a configuration only has their keys, type them there');
    expect(JSON.stringify(result.template)).not.toContain('REDACTED');
  });

  it('reads the groups of version 3 and what they may see', async () => {
    const result = await convert(
      junos(`
        set snmp v3 vacm security-to-group security-model usm security-name monitor group READERS
        set snmp v3 vacm security-to-group security-model usm security-name operator group WRITERS
        set snmp v3 vacm access group READERS default-context-prefix security-model usm security-level privacy read-view SYSTEM
        set snmp v3 vacm access group READERS default-context-prefix security-model usm security-level privacy notify-view SYSTEM
        set snmp v3 vacm access group WRITERS context-prefix lab security-model any security-level authentication read-view EVERYTHING
        set snmp v3 vacm access group WRITERS context-prefix lab security-model any security-level authentication write-view EVERYTHING
      `),
    );

    expect(result.template.snmp_config?.v3_config?.vacm).toEqual({
      security_to_group: {
        security_model: 'usm',
        content: [
          { security_name: 'monitor', group: 'READERS' },
          { security_name: 'operator', group: 'WRITERS' },
        ],
      },
      access: [
        { group_name: 'READERS', prefix_list: [{ type: 'default_context_prefix', security_model: 'usm', security_level: 'privacy', read_view: 'SYSTEM', notify_view: 'SYSTEM' }] },
        { group_name: 'WRITERS', prefix_list: [{ type: 'context_prefix', context_prefix: 'lab', security_model: 'any', security_level: 'authentication', read_view: 'EVERYTHING', write_view: 'EVERYTHING' }] },
      ],
    });
  });

  it('keeps the groups of version 3 only: the template has one security model for them', async () => {
    const result = await convert(
      junos(`
        set snmp v3 vacm security-to-group security-model v2c security-name old group READERS
        set snmp v3 vacm security-to-group security-model usm security-name monitor group READERS
      `),
    );

    expect(result.template.snmp_config?.v3_config?.vacm?.security_to_group).toEqual({ security_model: 'usm', content: [{ security_name: 'monitor', group: 'READERS' }] });
    expect(logsOf(result, 'info')).toContain('SNMP: the groups of the security names of versions 1 and 2c are left out, the template has those of version 3');
  });

  it('reads where the notifications of version 3 go', async () => {
    const result = await convert(
      junos(`
        set snmp v3 target-address NMS address 10.0.0.70
        set snmp v3 target-address NMS port 1162
        set snmp v3 target-address NMS tag-list "TRAPS INFORMS"
        set snmp v3 target-address NMS target-parameters NMS-V3
        set snmp v3 target-parameters NMS-V3 parameters message-processing-model v3
        set snmp v3 target-parameters NMS-V3 parameters security-model usm
        set snmp v3 target-parameters NMS-V3 parameters security-level privacy
        set snmp v3 target-parameters NMS-V3 parameters security-name monitor
        set snmp v3 target-parameters NMS-V3 notify-filter LINKS
        set snmp v3 notify ALL type trap
        set snmp v3 notify ALL tag TRAPS
        set snmp v3 notify-filter LINKS oid .1.3.6.1.6.3.1.1.5 include
      `),
    );

    expect(result.template.snmp_config?.v3_config).toEqual({
      notify: [{ name: 'ALL', tag: 'TRAPS', type: 'trap' }],
      notify_filter: [{ profile_name: 'LINKS', contents: [{ oid: '.1.3.6.1.6.3.1.1.5', include: true }] }],
      target_address: [{ target_address_name: 'NMS', address: '10.0.0.70', port: '1162', tag_list: 'TRAPS INFORMS', target_parameters: 'NMS-V3' }],
      target_parameters: [{ name: 'NMS-V3', message_processing_model: 'v3', security_model: 'usm', security_level: 'privacy', security_name: 'monitor', notify_filter: 'LINKS' }],
    });
  });

  it('reports the SNMP statements that it does not convert, by their first words', async () => {
    const result = await convert(
      junos(`
        set snmp community n3tmon authorization read-only
        set snmp trap-options source-address 10.0.0.1
        set snmp v3 snmp-community INDEX community-name "REDACTED"
        set snmp name ex1
      `),
    );

    expect(logsOf(result, 'info').filter((message) => message.startsWith('Not converted'))).toEqual(['Not converted: "snmp trap-options"', 'Not converted: "snmp v3 snmp-community"', 'Not converted: "snmp name"']);
  });
});
