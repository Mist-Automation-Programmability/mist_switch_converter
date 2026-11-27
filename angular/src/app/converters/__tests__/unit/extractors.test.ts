/**
 * What the extractors give to the template builder: a vendor-neutral `Device`.
 * The behaviour of each command is tested from end to end in cisco-ios.test.ts and
 * junos.test.ts; these tests show the model that the two vendors share.
 */
import { describe, expect, it } from 'vitest';
import { extractCiscoIos } from '../../extractors/cisco_ios';
import { extractJunos } from '../../extractors/junos';
import type { Device, Port } from '../../model';
import { Report } from '../../report';

const CISCO = `sw1#show vlan brief

VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
10   USERS                            active    Gi1/0/1
20   VOICE                            active
1002 fddi-default                     act/unsup
sw1#show running-config
!
hostname sw1
!
vlan 30
 name PRINTERS
!
interface Port-channel1
 description Uplink
 switchport trunk native vlan 30
 switchport trunk allowed vlan 10,20
 switchport mode trunk
!
interface GigabitEthernet0/0
 vrf forwarding Mgmt-vrf
 ip address 192.168.1.1 255.255.255.0
!
interface GigabitEthernet1/0/1
 description Desk 12
 switchport access vlan 10
 switchport mode access
 switchport voice vlan 20
 authentication host-mode multi-auth
 authentication periodic
 authentication timer reauthenticate 3600
 mab
 dot1x pae authenticator
 spanning-tree portfast
!
interface GigabitEthernet1/0/2
 no switchport
 ip address 10.9.9.1 255.255.255.252
!
interface TenGigabitEthernet1/1/1
 channel-group 1 mode active
!
interface Vlan10
 description Users of the first floor
 ip address 10.1.11.1 255.255.255.0 secondary
 ip address 10.1.10.1 255.255.255.0
!
ip dhcp snooping vlan 10,20
ip name-server 10.0.0.53
radius server ISE
 address ipv4 10.0.0.80 auth-port 1812 acct-port 1813
 key 7 REDACTED
!
snmp-server community REDACTED RO
end
`;

const JUNOS = `set system host-name ex1
set interfaces interface-range DESKS member-range ge-0/0/0 to ge-0/0/1
set interfaces interface-range DESKS unit 0 family ethernet-switching vlan members USERS
set interfaces ge-0/0/1 description "Desk 12"
set interfaces ge-0/0/1 unit 0 family ethernet-switching vlan members PRINTERS
set interfaces xe-0/2/0 ether-options 802.3ad ae0
set interfaces ae0 description Uplink
set interfaces ae0 native-vlan-id 30
set interfaces ae0 aggregated-ether-options lacp active
set interfaces ae0 unit 0 family ethernet-switching interface-mode trunk
set interfaces ae0 unit 0 family ethernet-switching vlan members USERS
set interfaces ae0 unit 0 family ethernet-switching vlan members VOICE
set interfaces et-0/1/0 unit 0 family inet address 10.9.9.1/30
set interfaces irb unit 10 family inet address 10.1.10.1/24
set interfaces vme unit 0 family inet dhcp
set protocols dot1x authenticator interface DESKS supplicant multiple
set protocols dot1x authenticator interface DESKS mac-radius
set protocols dot1x authenticator interface DESKS reauthentication 3600
set protocols rstp interface DESKS edge
set switch-options voip interface access-ports vlan VOICE
set access radius-server 10.0.0.80 secret "REDACTED"
set snmp community REDACTED authorization read-only
set vlans USERS vlan-id 10
set vlans USERS l3-interface irb.10
set vlans USERS forwarding-options dhcp-security
set vlans VOICE vlan-id 20
set vlans PRINTERS vlan-id 30
`;

const port = (device: Device, name: string): Port => {
  const found = device.ports.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no port ${name}: ${device.ports.map((candidate) => candidate.name).join(', ')}`);
  return found;
};
const messages = (report: Report): string[] => report.diagnostics.map((entry) => `${entry.severity} ${entry.code}: ${entry.message}`);

describe('Cisco IOS extractor', () => {
  const report = new Report('sw1.txt');
  const device = extractCiscoIos({ name: 'sw1.txt', text: CISCO }, report);

  it('reads the device, its VLANs by id, and its servers', () => {
    expect(device).toMatchObject({ file: 'sw1.txt', vendor: 'cisco-ios', hostname: 'sw1' });
    expect(device.vlans).toEqual([
      { id: 10, name: 'USERS', alias: 'Users of the first floor', subnets: ['10.1.10.0/24', '10.1.11.0/24'], declared: true, dhcpSnooping: true },
      { id: 20, name: 'VOICE', subnets: [], declared: true, dhcpSnooping: true },
      { id: 30, name: 'PRINTERS', subnets: [], declared: true, dhcpSnooping: false },
    ]);
    expect(device.system).toMatchObject({
      dnsServers: ['10.0.0.53'],
      radius: { auth: [{ host: '10.0.0.80', port: 1812, timeout: 5 }], acct: [{ host: '10.0.0.80', port: 1813, timeout: 5 }] },
    });
  });

  it('keeps the switch ports, with the position of each on a Juniper switch', () => {
    expect(device.ports.map((candidate) => `${candidate.name} ${candidate.kind} ${candidate.junosName ?? '-'}`)).toEqual([
      'Port-channel1 lag -',
      'GigabitEthernet1/0/1 physical ge-0/0/0',
      'TenGigabitEthernet1/1/1 physical mge-0/1/0',
    ]);
  });

  it('reads an access port', () => {
    expect(port(device, 'GigabitEthernet1/0/1')).toMatchObject({
      description: 'Desk 12',
      mode: 'access',
      accessVlan: 10,
      voiceVlan: 20,
      stpEdge: true,
      auth: { dot1x: true, macAuth: true, macAuthOnly: false, multipleSupplicants: true, reauthInterval: 3600 },
    });
    expect(port(device, 'GigabitEthernet1/0/1').lines).toEqual(['interface GigabitEthernet1/0/1', ' description Desk 12', ' switchport access vlan 10', ' switchport mode access', ' switchport voice vlan 20', ' authentication host-mode multi-auth', ' authentication periodic', ' authentication timer reauthenticate 3600', ' mab', ' dot1x pae authenticator', ' spanning-tree portfast']);
  });

  it('reads a link aggregation and its member', () => {
    expect(port(device, 'Port-channel1')).toMatchObject({ kind: 'lag', mode: 'trunk', nativeVlan: 30, allowedVlans: [10, 20], lacp: true, aeIndex: 0 });
    expect(port(device, 'TenGigabitEthernet1/1/1').lag).toEqual({ name: 'Port-channel1', lacp: true });
  });

  it('reports what it leaves out, without the text of the commands', () => {
    expect(messages(report)).toEqual([
      'info interface-skipped: Interface GigabitEthernet0/0: management port, not converted',
      'warning routed-port: Interface GigabitEthernet1/0/2: routed port ("no switchport"), not converted',
      'info not-converted: Not converted: "snmp-server community"',
      'warning dhcp-untrusted-trunk: DHCP snooping: the trunk has no "ip dhcp snooping trust", DHCP servers are refused on it on Port-channel1',
    ]);
    expect(JSON.stringify([device.system, device.vlans, report.diagnostics])).not.toContain('REDACTED');
  });
});

describe('Junos extractor', () => {
  const report = new Report('ex1.txt');
  const device = extractJunos({ name: 'ex1.txt', text: JUNOS }, report);

  it('reads the device, its VLANs by id, and its servers', () => {
    expect(device).toMatchObject({ file: 'ex1.txt', vendor: 'junos', hostname: 'ex1' });
    expect(device.vlans).toEqual([
      { id: 10, name: 'USERS', subnets: ['10.1.10.0/24'], declared: true, dhcpSnooping: true },
      { id: 20, name: 'VOICE', subnets: [], declared: true, dhcpSnooping: false },
      { id: 30, name: 'PRINTERS', subnets: [], declared: true, dhcpSnooping: false },
    ]);
    expect(device.system.radius).toEqual({ auth: [{ host: '10.0.0.80', port: 1812, timeout: 5 }], acct: [], coaPort: undefined });
  });

  it('keeps the switch ports: every port of an interface range is a port', () => {
    expect(device.ports.map((candidate) => `${candidate.name} ${candidate.kind} ${candidate.junosName ?? '-'}`)).toEqual(['ge-0/0/0 physical ge-0/0/0', 'ge-0/0/1 physical ge-0/0/1', 'xe-0/2/0 physical xe-0/2/0', 'ae0 lag -']);
  });

  it('gives a port the settings of its interface range, then its own, then those written outside "interfaces"', () => {
    const shared = { mode: 'access', voiceVlan: 20, stpEdge: true, groups: ['DESKS'], auth: { dot1x: true, macAuth: true, multipleSupplicants: true, reauthInterval: 3600 } };
    expect(port(device, 'ge-0/0/0')).toMatchObject({ ...shared, accessVlan: 10 });
    // What the port says itself comes before what the range says.
    expect(port(device, 'ge-0/0/1')).toMatchObject({ ...shared, accessVlan: 30, description: 'Desk 12' });
  });

  it('keeps every line about a port, in the order of the file: its range, and what is written outside "interfaces"', () => {
    expect(port(device, 'ge-0/0/0').lines).toEqual([
      'set interfaces interface-range DESKS unit 0 family ethernet-switching vlan members USERS',
      'set protocols dot1x authenticator interface DESKS supplicant multiple',
      'set protocols dot1x authenticator interface DESKS mac-radius',
      'set protocols dot1x authenticator interface DESKS reauthentication 3600',
      'set protocols rstp interface DESKS edge',
      'set switch-options voip interface access-ports vlan VOICE',
    ]);
  });

  it('keeps the lines that name a port and are not converted', () => {
    const text = [
      'set interfaces ge-0/0/5 unit 0 family ethernet-switching vlan members USERS',
      'set interfaces ge-0/0/6 unit 0 family ethernet-switching vlan members USERS',
      'set vlans USERS vlan-id 10',
      'set class-of-service interfaces ge-0/0/5 unit 0 classifiers dscp PHONES',
      'set poe interface ge-0/0/5 disable',
      'set vlans USERS forwarding-options dhcp-security group TRUSTED interface ge-0/0/5.0',
      'set protocols lldp interface ge-0/0/6 disable',
    ].join('\n');
    const read = extractJunos({ name: 'ex2.txt', text }, new Report('ex2.txt'));

    expect(port(read, 'ge-0/0/5')).toMatchObject({ qos: true, poe: false });
    expect(port(read, 'ge-0/0/5').lines).toEqual([
      'set interfaces ge-0/0/5 unit 0 family ethernet-switching vlan members USERS',
      'set class-of-service interfaces ge-0/0/5 unit 0 classifiers dscp PHONES',
      'set poe interface ge-0/0/5 disable',
      'set vlans USERS forwarding-options dhcp-security group TRUSTED interface ge-0/0/5.0',
    ]);
    expect(port(read, 'ge-0/0/6').lines).toEqual(['set interfaces ge-0/0/6 unit 0 family ethernet-switching vlan members USERS', 'set protocols lldp interface ge-0/0/6 disable']);
  });

  it('reads a link aggregation and its member', () => {
    expect(port(device, 'ae0')).toMatchObject({ kind: 'lag', mode: 'trunk', nativeVlan: 30, allowedVlans: [10, 20], lacp: true, aeIndex: 0, description: 'Uplink' });
    expect(port(device, 'xe-0/2/0').lag).toEqual({ name: 'ae0', lacp: true });
  });

  it('reports what it leaves out, without the text of the statements', () => {
    expect(messages(report)).toEqual([
      'warning routed-port: Interface et-0/1/0: routed port (it has an address or tagged units of its own), not converted',
      'info interface-skipped: Interface vme: management port, not converted',
      'info not-converted: Not converted: "snmp community"',
    ]);
    expect(JSON.stringify([device.system, device.vlans, report.diagnostics])).not.toContain('REDACTED');
  });
});
