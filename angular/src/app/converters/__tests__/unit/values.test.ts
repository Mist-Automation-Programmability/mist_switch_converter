import { describe, expect, it } from 'vitest';
import { expandVlanRanges, isIpAddress, isIpv4, isVlanId, parseVlanList, subnetOf } from '../../extractors/values';

describe('Lists of VLANs', () => {
  it('reads ids and ranges', () => {
    expect(parseVlanList('10,20,30-32')).toEqual([{ from: 10, to: 10 }, { from: 20, to: 20 }, { from: 30, to: 32 }]);
    expect(parseVlanList('1-4094')).toEqual([{ from: 1, to: 4094 }]);
  });

  it.each(['', 'all', '10,', '0', '4095', '20-10', 'USERS', '10 20'])('refuses "%s"', (text) => {
    expect(parseVlanList(text)).toBeUndefined();
  });

  it('knows a VLAN id from another word', () => {
    expect(['1', '4094', '0', '4095', '10a', 'default'].map(isVlanId)).toEqual([true, true, false, false, false, false]);
  });

  it('reads a range from 1 to 4094 as every VLAN', () => {
    expect(expandVlanRanges([{ from: 1, to: 4094 }], [10, 20], true)).toBe('all');
  });

  it('gives the VLANs of the switch for a wide range', () => {
    expect(expandVlanRanges([{ from: 2, to: 4094 }], [30, 1, 10], true)).toEqual([10, 30]);
    expect(expandVlanRanges([{ from: 2000, to: 3000 }], [10, 30], true)).toEqual([]);
  });

  it('gives every id of a short range on a device whose VLAN list may be missing, and the known VLANs otherwise', () => {
    expect(expandVlanRanges([{ from: 10, to: 12 }], [10], true)).toEqual([10, 11, 12]);
    expect(expandVlanRanges([{ from: 10, to: 12 }], [10], false)).toEqual([10]);
  });

  it('always keeps a VLAN that is named on its own, and lists a VLAN once', () => {
    expect(expandVlanRanges([{ from: 50, to: 50 }, { from: 40, to: 60 }], [45, 50], false)).toEqual([50, 45]);
  });
});

describe('Addresses', () => {
  it.each([
    ['10.1.10.1/24', '10.1.10.0/24'],
    ['10.1.10.200/25', '10.1.10.128/25'],
    ['172.16.5.9/23', '172.16.4.0/23'],
    ['192.168.1.130/26', '192.168.1.128/26'],
    ['192.168.200.9/30', '192.168.200.8/30'],
    ['10.255.0.1/32', '10.255.0.1/32'],
    ['10.20.30.40/8', '10.0.0.0/8'],
    ['172.16.5.4/0', '0.0.0.0/0'],
  ])('gives the subnet of the prefix %s', (input, expected) => {
    expect(subnetOf(input)).toBe(expected);
  });

  it.each([
    ['10.1.10.1 255.255.255.0', '10.1.10.0/24'],
    ['10.1.20.129 255.255.255.128', '10.1.20.128/25'],
    ['172.16.5.9 255.255.254.0', '172.16.4.0/23'],
    ['192.168.200.17 255.255.255.240', '192.168.200.16/28'],
    ['10.1.10.77 255.255.255.192 secondary', '10.1.10.64/26'],
  ])('gives the subnet of the address and mask "%s"', (input, expected) => {
    expect(subnetOf(input)).toBe(expected);
  });

  it.each(['dhcp', '', '10.1.10.1', '10.1.10.1 24', '10.1.10.1/33', 'negotiated', '10.1.10.300/24'])('finds no subnet in "%s"', (text) => {
    expect(subnetOf(text)).toBeNull();
  });

  it('knows an address from a name', () => {
    expect(['10.0.0.53', '256.0.0.1', '10.0.0', 'Mgmt-vrf'].map(isIpv4)).toEqual([true, false, false, false]);
    expect(['10.0.0.53', '2001:db8::53', 'ntp.example.com', 'vrf'].map(isIpAddress)).toEqual([true, true, false, false]);
  });
});
