import { describe, expect, it } from 'vitest';
import { convert } from '../converters/convert';
import { containerPaths, defaultExpanded, jsonRows } from './json-rows';
import { lineLinks, navSections, partOf, segmentsOf, summaryOf } from './view-model';

const CISCO = ['hostname sw1', '!', 'vlan 10', ' name USERS', '!', 'interface GigabitEthernet1/0/1', ' description Desk 12', ' switchport access vlan 10', ' ip verify source', '!', 'ntp server 10.0.0.123', 'end', ''].join('\n');

describe('JSON rows', () => {
  const value = { name: 't', list: [1, 'a', null], nested: { on: true, empty: {} } };

  it('writes every value with its key and its comma, objects unfolded', () => {
    const rows = jsonRows(value, new Set(containerPaths(value)), 'root');
    const text = rows.map((row) => `${'  '.repeat(row.depth)}${row.key ? `${row.key}: ` : ''}${row.scalar?.text ?? ''}${row.open ?? ''}${row.size === 0 ? (row.close ?? '') : ''}${!row.open && row.close ? row.close : ''}${row.comma ? ',' : ''}`);
    expect(text).toEqual(['"root": {', '  "name": "t",', '  "list": [', '    1,', '    "a",', '    null', '  ],', '  "nested": {', '    "on": true,', '    "empty": {}', '  }', '}']);
  });

  it('folds an object into one row that says how many items it has', () => {
    const rows = jsonRows(value, new Set(['']));
    expect(rows.find((row) => row.key === '"list"')).toMatchObject({ folded: true, size: 3, open: '[', close: ']' });
  });

  it('unfolds the first levels, except long lists', () => {
    const long = { a: { b: 1 }, many: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, index])) };
    expect([...defaultExpanded(long, 3)]).toEqual(['', 'a']);
  });
});

describe('view model', () => {
  const conversion = convert([{ name: 'sw1.txt', text: CISCO }]);

  it('lists the parts of the template by section', () => {
    const sections = navSections(conversion);
    expect(sections.map((section) => `${section.title}: ${section.items.map((item) => `${item.name} (${item.detail})`).join(', ')}`)).toEqual([
      'Networks: users (VLAN 10)',
      'Port profiles: desk_12 (1 port)',
      'Switch rules: sw1 (1 port)',
      'Settings: NTP servers ()',
    ]);
    expect(summaryOf(conversion, partOf('port_usages.desk_12')!)).toBe('Used by 1 port on 1 switch.');
  });

  it('cuts a file into runs of lines, each with what it became', () => {
    const segments = segmentsOf(CISCO, conversion.files[0].outcomes, lineLinks(conversion, 'sw1.txt'));
    const described = segments.map((segment) => {
      const link = segment.link === undefined ? '' : segment.link.kind === 'port' ? ` -> ${segment.link.portKey}` : ` -> ${segment.link.path}`;
      return `${segment.first}-${segment.first + segment.lines.length - 1} ${segment.outcome}${link}`;
    });
    expect(described).toEqual(['1-1 converted', '3-4 converted -> networks.users', '6-8 converted -> ge-0/0/0', '9-9 not-converted', '11-11 converted -> ntp_servers', '12-12 ignored']);
  });
});
