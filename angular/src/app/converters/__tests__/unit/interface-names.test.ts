import { describe, expect, it } from 'vitest';
import { expandCiscoInterfaceRange, readCiscoInterface } from '../../extractors/cisco_interfaces';
import { expandMember, expandMemberRange, readJunosInterface, wildcardMember } from '../../extractors/junos_interfaces';

describe('Cisco interface names', () => {
  it.each([
    ['GigabitEthernet1/0/1', 'GigabitEthernet1/0/1', 'ge-0/0/0'],
    ['GigabitEthernet2/0/48', 'GigabitEthernet2/0/48', 'ge-1/0/47'],
    ['GigabitEthernet1/1/4', 'GigabitEthernet1/1/4', 'ge-0/1/3'],
    ['GigabitEthernet0/1', 'GigabitEthernet0/1', 'ge-0/0/0'],
    ['FastEthernet0/24', 'FastEthernet0/24', 'fe-0/0/23'],
    ['TenGigabitEthernet1/1/1', 'TenGigabitEthernet1/1/1', 'mge-0/1/0'],
    ['TwoGigabitEthernet1/0/5', 'TwoGigabitEthernet1/0/5', 'mge-0/0/4'],
    ['TwentyFiveGigE1/1/1', 'TwentyFiveGigE1/1/1', 'et-0/1/0'],
    ['FortyGigabitEthernet1/1/1', 'FortyGigabitEthernet1/1/1', 'et-0/1/0'],
    ['HundredGigE1/0/49', 'HundredGigE1/0/49', 'et-0/0/48'],
  ])('%s is a port, %s, at %s', (text, name, junosName) => {
    expect(readCiscoInterface(text)).toEqual({ name, kind: 'physical', junosName });
  });

  it.each([
    ['gi1/0/1', 'GigabitEthernet1/0/1'],
    ['Gi 1/0/1', 'GigabitEthernet1/0/1'],
    ['GigabitEthernet 1/0/1', 'GigabitEthernet1/0/1'],
    ['te1/1/1', 'TenGigabitEthernet1/1/1'],
    ['tw1/0/5', 'TwoGigabitEthernet1/0/5'],
    ['twe1/1/1', 'TwentyFiveGigE1/1/1'],
    ['fa0/1', 'FastEthernet0/1'],
    ['po1', 'Port-channel1'],
    ['vl99', 'Vlan99'],
  ])('reads the abbreviation "%s" as %s', (text, name) => {
    expect(readCiscoInterface(text).name).toBe(name);
  });

  it('tells the kinds of interfaces apart', () => {
    expect(readCiscoInterface('Port-channel12')).toEqual({ name: 'Port-channel12', kind: 'lag', number: 12 });
    expect(readCiscoInterface('Vlan99')).toEqual({ name: 'Vlan99', kind: 'svi', number: 99 });
    expect(readCiscoInterface('GigabitEthernet0/0').kind).toBe('management');
    expect(readCiscoInterface('FastEthernet0').kind).toBe('management');
    expect(readCiscoInterface('Loopback0').kind).toBe('loopback');
    expect(readCiscoInterface('AppGigabitEthernet1/0/1').kind).toBe('internal');
    expect(readCiscoInterface('Tunnel10').kind).toBe('other');
    expect(readCiscoInterface('GigabitEthernet1/0/1.100').kind).toBe('other');
    expect(readCiscoInterface('Ethernet1/1')).toEqual({ name: 'Ethernet1/1', kind: 'other' });
  });

  it('lists the interfaces of "interface range"', () => {
    expect(expandCiscoInterfaceRange('GigabitEthernet1/0/5 - 8')).toEqual(['GigabitEthernet1/0/5', 'GigabitEthernet1/0/6', 'GigabitEthernet1/0/7', 'GigabitEthernet1/0/8']);
    expect(expandCiscoInterfaceRange('gi1/0/1-2 , gi1/0/10 , te1/1/1 - 2')).toEqual(['gi1/0/1', 'gi1/0/2', 'gi1/0/10', 'te1/1/1', 'te1/1/2']);
    expect(expandCiscoInterfaceRange('macro UPLINKS')).toBeUndefined();
    expect(expandCiscoInterfaceRange('GigabitEthernet1/0/8 - 5')).toBeUndefined();
    expect(expandCiscoInterfaceRange('GigabitEthernet1/0/1 - 9999')).toBeUndefined();
  });
});

describe('Junos interface names', () => {
  it('tells the kinds of interfaces apart and drops the unit', () => {
    expect(readJunosInterface('ge-0/0/1.0')).toEqual({ name: 'ge-0/0/1', kind: 'physical' });
    expect(['mge-0/0/1', 'xe-0/2/0', 'et-0/1/0', 'fe-0/0/1'].map((name) => readJunosInterface(name).kind)).toEqual(['physical', 'physical', 'physical', 'physical']);
    expect(readJunosInterface('ae10')).toEqual({ name: 'ae10', kind: 'lag', number: 10 });
    expect(['irb', 'vlan'].map((name) => readJunosInterface(name).kind)).toEqual(['svi', 'svi']);
    expect(['me0', 'vme', 'em0', 'fxp0'].map((name) => readJunosInterface(name).kind)).toEqual(['management', 'management', 'management', 'management']);
    expect(readJunosInterface('lo0').kind).toBe('loopback');
    expect(['st0', 'gr-0/0/0', 'access-ports', 'all'].map((name) => readJunosInterface(name).kind)).toEqual(['other', 'other', 'other', 'other']);
  });

  it('lists the ports of a member of an interface range', () => {
    expect(expandMember('ge-0/0/10')).toEqual(['ge-0/0/10']);
    expect(expandMember('ge-0/0/[20-21]')).toEqual(['ge-0/0/20', 'ge-0/0/21']);
    expect(expandMember('ge-[0-1]/0/[0,2]')).toEqual(['ge-0/0/0', 'ge-0/0/2', 'ge-1/0/0', 'ge-1/0/2']);
    expect(expandMember('ae0')).toEqual(['ae0']);
    expect(expandMember('ge-0/0/*')).toBeUndefined();
    expect(expandMember('ge-0/0/[0-99999]')).toBeUndefined();
  });

  it('lists the ports of "member-range": every position between the two ends', () => {
    expect(expandMemberRange('ge-0/0/0', 'ge-0/0/3')).toEqual(['ge-0/0/0', 'ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3']);
    expect(expandMemberRange('ge-0/0/46', 'ge-1/0/47')).toEqual(['ge-0/0/46', 'ge-0/0/47', 'ge-1/0/46', 'ge-1/0/47']);
    expect(expandMemberRange('ge-0/0/0', 'xe-0/0/3')).toBeUndefined();
    expect(expandMemberRange('ge-0/0/3', 'ge-0/0/0')).toBeUndefined();
  });

  it('matches the names that a member with wildcards stands for', () => {
    expect(['ge-0/0/1', 'ge-0/0/47', 'ge-1/0/1', 'xe-0/0/1'].map((name) => wildcardMember('ge-0/0/*').test(name))).toEqual([true, true, false, false]);
    expect(['ge-0/0/1', 'ge-0/1/1', 'ge-0/10/1'].map((name) => wildcardMember('ge-0/?/1').test(name))).toEqual([true, true, false]);
  });
});
