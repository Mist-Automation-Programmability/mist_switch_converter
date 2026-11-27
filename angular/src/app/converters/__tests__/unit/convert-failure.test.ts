import { expect, it, vi } from 'vitest';
import { convert } from '../../convert';

// An extractor that fails, as a bug of the converter would make it fail.
vi.mock('../../extractors/junos', () => ({
  extractJunos: () => {
    throw new Error('something unexpected');
  },
}));

it('keeps converting the other files when a file makes the converter fail, and reports it', () => {
  const result = convert([
    { name: 'ex1.txt', text: 'set system host-name ex1\nset vlans USERS vlan-id 10\n' },
    { name: 'sw1.txt', text: 'hostname sw1\n!\nvlan 10\n name USERS\n!\ninterface GigabitEthernet1/0/1\n switchport access vlan 10\n!\n' },
  ]);

  expect(result.files).toEqual([
    { name: 'ex1.txt', format: 'Juniper', converted: false, hasVlans: false, message: 'Error when reading configuration from ex1.txt' },
    { name: 'sw1.txt', format: 'Cisco', hostname: 'sw1', converted: true, hasVlans: true },
  ]);
  expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([
    { severity: 'error', code: 'internal-error', message: 'Error when reading configuration from ex1.txt: something unexpected', file: 'ex1.txt' },
  ]);
  expect(result.template.switch_matching.rules.map((rule) => rule.name)).toEqual(['sw1']);
});
