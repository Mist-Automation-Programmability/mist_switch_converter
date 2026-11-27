/**
 * Unit tests of two small functions of `ConfigData` that are easy to get wrong:
 * the subnet calculation and the translation of Cisco port names.
 *
 * Unlike the other tests, these call the current implementation directly. If the
 * functions move or change name, move the tests with them.
 */
import { describe, expect, it } from 'vitest';
import { ConfigData } from '../parser_config';
import type { Logger } from '../../services/logger';

const silent = { debug() {}, info() {}, warning() {}, error() {}, critical() {}, getall: () => [] } as unknown as Logger;
const data = new ConfigData(silent);

describe('calculate_cidr', () => {
  it.each([
    ['10.1.10.1/24', '10.1.10.0/24'],
    ['10.1.10.200/25', '10.1.10.128/25'],
    ['172.16.5.9/23', '172.16.4.0/23'],
    ['192.168.1.130/26', '192.168.1.128/26'],
    ['10.255.0.1/32', '10.255.0.1/32'],
    ['10.20.30.40/8', '10.0.0.0/8'],
  ])('gives the subnet of the prefix %s', (input, expected) => {
    expect(data.calculate_cidr(input)).toBe(expected);
  });

  it.each([
    ['10.1.10.1 255.255.255.0', '10.1.10.0/24'],
    ['10.1.20.129 255.255.255.128', '10.1.20.128/25'],
    ['172.16.5.9 255.255.254.0', '172.16.4.0/23'],
    ['192.168.200.17 255.255.255.240', '192.168.200.16/28'],
    ['10.1.10.1 255.255.255.0 secondary', '10.1.10.0/24'],
  ])('gives the subnet of the address and mask "%s"', (input, expected) => {
    expect(data.calculate_cidr(input)).toBe(expected);
  });

  it('returns null when there is no mask, as in "ip address dhcp"', () => {
    expect(data.calculate_cidr('dhcp')).toBeNull();
    expect(data.calculate_cidr('10.1.10.1')).toBeNull();
  });
});

describe('inteface_name_converter', () => {
  it.each([
    ['FastEthernet0/1', 'fe-0/0/0'],
    ['FastEthernet0/24', 'fe-0/0/23'],
    ['GigabitEthernet0/1', 'ge-0/0/0'],
    ['GigabitEthernet1/0/1', 'ge-0/0/0'],
    ['GigabitEthernet1/0/48', 'ge-0/0/47'],
    ['GigabitEthernet3/0/12', 'ge-2/0/11'],
    ['GigabitEthernet1/1/4', 'ge-0/1/3'],
    ['TenGigabitEthernet1/1/1', 'mge-0/1/0'],
    ['TwentyFiveGigE1/1/1', 'et-0/1/0'],
    ['FortyGigabitEthernet1/1/2', 'et-0/1/1'],
  ])('translates %s into %s', (cisco, junos) => {
    expect(data.inteface_name_converter(cisco)).toBe(junos);
  });

  it('translates every member of a comma separated list', () => {
    expect(data.inteface_name_converter('TenGigabitEthernet1/1/1,TenGigabitEthernet2/1/1')).toBe('mge-0/1/0,mge-1/1/0');
  });

  it('leaves Junos port names as they are', () => {
    expect(data.inteface_name_converter('ge-0/0/5')).toBe('ge-0/0/5');
    expect(data.inteface_name_converter('xe-0/2/0,xe-0/2/1')).toBe('xe-0/2/0,xe-0/2/1');
  });
});
