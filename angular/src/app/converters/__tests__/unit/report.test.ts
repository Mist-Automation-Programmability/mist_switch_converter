import { describe, expect, it } from 'vitest';
import { commandKey, linesText, NOT_A_COMMAND, Report } from '../../report';

describe('Report', () => {
  it('records a message with its file and its lines', () => {
    const report = new Report();
    const file = report.forFile('sw1.txt');
    file.warning('routed-port', 'Interface X: routed port, not converted', [12]);
    report.info('vlan-without-name', 'VLAN 30 has no name');

    expect(report.diagnostics).toEqual([
      { severity: 'warning', code: 'routed-port', message: 'Interface X: routed port, not converted', file: 'sw1.txt', lines: [12] },
      { severity: 'info', code: 'vlan-without-name', message: 'VLAN 30 has no name', file: '' },
    ]);
  });

  it('writes one message for a command that is not converted, however many times it is in the file', () => {
    const report = new Report('sw1.txt');
    for (const line of [10, 11, 12]) report.notConverted('snmp-server enable', line);
    report.notConverted('ip route', 40);
    report.flush();

    expect(report.diagnostics).toEqual([
      { severity: 'info', code: 'not-converted', message: 'Not converted: "snmp-server enable"', file: 'sw1.txt', lines: [10, 11, 12] },
      { severity: 'info', code: 'not-converted', message: 'Not converted: "ip route"', file: 'sw1.txt', lines: [40] },
    ]);
  });

  it('writes one warning for a port setting that is not converted, with the number of ports', () => {
    const report = new Report('sw1.txt');
    report.portSettingNotConverted('storm-control broadcast', 20, 'GigabitEthernet1/0/1');
    report.portSettingNotConverted('storm-control broadcast', 30, 'GigabitEthernet1/0/2');
    // An interface range gives the same line to each of its ports.
    report.portSettingNotConverted('storm-control broadcast', 30, 'GigabitEthernet1/0/3');
    report.portSettingNotConverted('udld port', 21, 'GigabitEthernet1/0/1');
    report.flush();

    expect(report.diagnostics.map((entry) => `${entry.severity}: ${entry.message} [${entry.lines}]`)).toEqual([
      'warning: Not converted: "storm-control broadcast" on 3 ports, the first is GigabitEthernet1/0/1 [20,30]',
      'warning: Not converted: "udld port" on GigabitEthernet1/0/1 [21]',
    ]);
  });

  it('writes nothing twice', () => {
    const report = new Report();
    for (let line = 1; line <= 20; line++) report.notConverted('access-list', line);
    report.flush();
    report.flush();

    expect(report.diagnostics.map((entry) => entry.message)).toEqual(['Not converted: "access-list"']);
    expect(report.diagnostics[0].lines).toHaveLength(20);
  });

  it('writes the lines of a message for a person, eight at most', () => {
    expect(linesText(undefined)).toBe('');
    expect(linesText([])).toBe('');
    expect(linesText([12])).toBe('12');
    expect(linesText([12, 15])).toBe('12, 15');
    expect(linesText(Array.from({ length: 20 }, (_, index) => index + 1))).toBe('1, 2, 3, 4, 5, 6, 7, 8 and 12 more');
  });
});

describe('What a report shows of a command', () => {
  const twoWords = new Set(['ip', 'snmp-server']);

  it('shows the first keyword, and the second one after a keyword that needs it', () => {
    expect(commandKey(['snmp-server', 'community', 'REDACTED', 'RO'], twoWords)).toBe('snmp-server community');
    expect(commandKey(['username', 'admin', 'secret', '9', 'REDACTED'], twoWords)).toBe('username');
    expect(commandKey(['IP', 'Route', '0.0.0.0', '0.0.0.0', '10.0.0.1'], twoWords)).toBe('ip route');
    expect(commandKey(['no', 'ip', 'http', 'server'], twoWords)).toBe('no ip http');
  });

  it('never shows a value in place of a keyword', () => {
    expect(commandKey(['ip', '10.0.0.1'], twoWords)).toBe('ip');
    expect(commandKey(['**********'], twoWords)).toBe(NOT_A_COMMAND);
    expect(commandKey(['7', 'REDACTED'], twoWords)).toBe(NOT_A_COMMAND);
    expect(commandKey(['no', '7', 'REDACTED'], twoWords)).toBe(`no ${NOT_A_COMMAND}`);
  });
});
