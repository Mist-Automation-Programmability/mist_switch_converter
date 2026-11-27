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
  it('reads the subnet of an address with a prefix length or a mask', () => {
    expect(subnetOf('10.1.10.1/24')).toBe('10.1.10.0/24');
    expect(subnetOf('10.1.10.1 255.255.255.0')).toBe('10.1.10.0/24');
    expect(subnetOf('10.1.10.77 255.255.255.192 secondary')).toBe('10.1.10.64/26');
    expect(subnetOf('192.168.200.9/30')).toBe('192.168.200.8/30');
    expect(subnetOf('10.0.0.1/32')).toBe('10.0.0.1/32');
    expect(subnetOf('172.16.5.4/0')).toBe('0.0.0.0/0');
  });

  it.each(['dhcp', '', '10.1.10.1', '10.1.10.1 24', '10.1.10.1/33', 'negotiated', '10.1.10.300/24'])('finds no subnet in "%s"', (text) => {
    expect(subnetOf(text)).toBeNull();
  });

  it('knows an address from a name', () => {
    expect(['10.0.0.53', '256.0.0.1', '10.0.0', 'Mgmt-vrf'].map(isIpv4)).toEqual([true, false, false, false]);
    expect(['10.0.0.53', '2001:db8::53', 'ntp.example.com', 'vrf'].map(isIpAddress)).toEqual([true, true, false, false]);
  });
});
