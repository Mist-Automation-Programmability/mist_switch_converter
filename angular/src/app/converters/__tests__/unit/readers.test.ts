import { describe, expect, it } from 'vitest';
import { readIndentedBlocks } from '../../readers/indented_blocks';
import { readIosCapture } from '../../readers/ios_capture';
import { readSetLines, splitQuotedWords } from '../../readers/set_lines';
import { numberedLines, sourceLines, Statement, textAfter } from '../../readers/statement';

/** A statement tree as text: one line per statement, children indented by two spaces. */
function outline(statements: Statement[], depth = 0): string[] {
  return statements.flatMap((statement) => [`${'  '.repeat(depth)}${statement.separator ? '!' : statement.text}`, ...outline(statement.children, depth + 1)]);
}

const blocks = (text: string): Statement[] => readIndentedBlocks(numberedLines(text));

describe('Reader: indented blocks', () => {
  it('nests a command under the last command that is indented less', () => {
    const statements = blocks(['hostname sw1', 'interface GigabitEthernet1/0/1', ' description Printer', ' switchport access vlan 30', 'ip route 0.0.0.0 0.0.0.0 10.0.0.1'].join('\n'));

    expect(outline(statements)).toEqual(['hostname sw1', 'interface GigabitEthernet1/0/1', '  description Printer', '  switchport access vlan 30', 'ip route 0.0.0.0 0.0.0.0 10.0.0.1']);
    expect(statements[1].children[1]).toMatchObject({ words: ['switchport', 'access', 'vlan', '30'], line: 4 });
  });

  it('reads blocks inside blocks, whatever the width of the indentation', () => {
    const statements = blocks(['policy-map QOS', '    class VOICE', '        priority', '    class class-default', 'end'].join('\n'));

    expect(outline(statements)).toEqual(['policy-map QOS', '  class VOICE', '    priority', '  class class-default', 'end']);
  });

  it('does not need a "!" between two blocks, and ends a block at a "!"', () => {
    const statements = blocks(['interface GigabitEthernet1/0/1', ' shutdown', 'interface GigabitEthernet1/0/2', ' shutdown', '!', ' description lost its interface'].join('\n'));

    expect(outline(statements)).toEqual(['interface GigabitEthernet1/0/1', '  shutdown', 'interface GigabitEthernet1/0/2', '  shutdown', '!', 'description lost its interface']);
  });

  it('skips the "!" lines inside a block and the empty lines', () => {
    const statements = blocks(['interface GigabitEthernet1/0/1', ' description Printer', ' !', '', ' shutdown'].join('\n'));

    expect(outline(statements)).toEqual(['interface GigabitEthernet1/0/1', '  description Printer', '  shutdown']);
  });

  it.each([
    ['the usual "^C"', ['banner motd ^C', 'Authorized access only', 'All activity is logged', '^C']],
    ['another delimiter', ['banner motd #', 'Authorized access only', 'All activity is logged', '#']],
    ['text on the lines of the delimiters', ['banner motd ^CAuthorized access only', 'All activity is logged^C']],
    ['a first line that lost its delimiter', ['banner motd', 'Authorized access only', 'All activity is logged', '^C']],
  ])('reads the text of a banner written with %s', (_title, lines) => {
    const statements = blocks([...lines, 'hostname sw1'].join('\n'));

    expect(statements[0].body).toBe('Authorized access only\nAll activity is logged');
    expect(outline(statements)).toEqual([lines[0], 'hostname sw1']);
  });

  it('reads a banner on one line, and the text of a banner is never read as commands', () => {
    const statements = blocks(['banner login ^CAuthorized access only^C', 'banner exec %', 'interface GigabitEthernet1/0/1', ' shutdown', '%', 'hostname sw1'].join('\n'));

    expect(statements.map((statement) => statement.body)).toEqual(['Authorized access only', 'interface GigabitEthernet1/0/1\n shutdown', undefined]);
  });

  it('reads a banner that is never closed as a command of one line', () => {
    const statements = blocks(['banner motd ^C', 'Authorized access only', 'hostname sw1'].join('\n'));

    expect(statements[0].body).toBeUndefined();
    expect(outline(statements)).toContain('hostname sw1');
  });

  it('skips the commands of a macro', () => {
    const statements = blocks(['macro name DESK', 'switchport mode access', 'spanning-tree portfast', '@', 'hostname sw1'].join('\n'));

    expect(outline(statements)).toEqual(['macro name DESK', 'hostname sw1']);
  });

  it('gives back the lines of a block and the text after the first words of a command', () => {
    const [statement] = blocks(['interface GigabitEthernet1/0/1', ' description  Two  spaces kept', ' shutdown'].join('\n'));

    expect(sourceLines(statement)).toEqual(['interface GigabitEthernet1/0/1', ' description  Two  spaces kept', ' shutdown']);
    expect(textAfter(statement.children[0], 1)).toBe('Two  spaces kept');
  });
});

describe('Reader: Cisco IOS terminal capture', () => {
  const text = (lines: string[]): string => lines.join('\n');

  it('keeps the configuration of "show running-config" and drops its header, the prompts and the other commands', () => {
    const capture = readIosCapture(
      text(['sw1#terminal length 0', 'sw1#show running-config', 'Building configuration...', '', 'Current configuration : 4096 bytes', '!', 'hostname sw1', '!', 'end', '', 'sw1#show version', 'Cisco IOS Software', 'sw1#']),
    );

    expect(capture.config.map((line) => line.text).filter((line) => line !== '')).toEqual(['!', 'hostname sw1', '!', '!']);
    expect(capture.config.find((line) => line.text === 'hostname sw1')?.line).toBe(7);
    expect(capture.promptHostname).toBe('sw1');
    expect(capture.hasVlanTable).toBe(false);
  });

  it('reads a file that is a configuration from its first line', () => {
    const capture = readIosCapture(text(['version 17.9', 'hostname sw1', 'interface GigabitEthernet1/0/1', ' shutdown']));

    expect(capture.config.map((line) => line.text)).toEqual(['version 17.9', 'hostname sw1', 'interface GigabitEthernet1/0/1', ' shutdown']);
    expect(capture.promptHostname).toBeUndefined();
  });

  it('reads the table of "show vlan brief", with port lists wrapped over several lines', () => {
    const capture = readIosCapture(
      text([
        'sw1#show vlan brief',
        '',
        'VLAN Name                             Status    Ports',
        '---- -------------------------------- --------- -------------------------------',
        '1    default                          active    Gi1/0/1, Gi1/0/2, Gi1/0/3, Gi1/0/4',
        '                                                Gi1/0/5, Gi1/0/6',
        '10   USERS                            active    Gi1/0/7',
        '20   VOICE                            active',
        '1002 fddi-default                     act/unsup',
        'sw1#show running-config',
        'hostname sw1',
      ]),
    );

    expect(capture.hasVlanTable).toBe(true);
    expect(capture.vlanTable.map((row) => `${row.id} ${row.name}`)).toEqual(['1 default', '10 USERS', '20 VOICE', '1002 fddi-default']);
    expect(capture.config.map((line) => line.text)).toEqual(['hostname sw1']);
  });

  it('reads the abbreviated commands of a capture: "sh run", "sh vlan br"', () => {
    const capture = readIosCapture(text(['sw1#sh vlan br', 'VLAN Name Status Ports', '---- ---- ------ -----', '10   USERS active', 'sw1#sh run', 'hostname sw1']));

    expect(capture.vlanTable.map((row) => row.id)).toEqual([10]);
    expect(capture.config.map((line) => line.text)).toEqual(['hostname sw1']);
  });

  it('reads the commands typed in configuration mode, with their prompts', () => {
    const capture = readIosCapture(text(['sw1#configure terminal', 'sw1(config)#interface GigabitEthernet1/0/1', 'sw1(config-if)#description Printer', 'sw1(config-if)#exit', 'sw1(config)#end', 'sw1#show clock', '12:00:00.000 UTC']));

    expect(capture.config.map((line) => line.text)).toEqual(['interface GigabitEthernet1/0/1', 'description Printer', 'exit', '!']);
  });

  it('does not take a line of the configuration that looks like a prompt for a prompt', () => {
    const capture = readIosCapture(text(['sw1#show running-config', 'hostname sw1', 'banner motd ^C', 'Call#4500 before you log in', '^C', 'end']));

    expect(capture.config.map((line) => line.text)).toContain('Call#4500 before you log in');
    expect(capture.promptHostname).toBe('sw1');
  });

  it('handles Windows line endings', () => {
    const capture = readIosCapture(['sw1#show running-config', 'hostname sw1', 'interface GigabitEthernet1/0/1', ' shutdown'].join('\r\n'));

    expect(capture.config.map((line) => line.text)).toEqual(['hostname sw1', 'interface GigabitEthernet1/0/1', ' shutdown']);
  });
});

describe('Reader: Junos set lines', () => {
  const words = (text: string): string[][] => readSetLines(text).map((statement) => statement.words);

  it('cuts a line into words and keeps a quoted string as one word', () => {
    expect(splitQuotedWords('set interfaces ge-0/0/1 description "Reception desk"')).toEqual(['set', 'interfaces', 'ge-0/0/1', 'description', 'Reception desk']);
    expect(splitQuotedWords('set system login message "Say \\"hello\\""')).toEqual(['set', 'system', 'login', 'message', 'Say "hello"']);
  });

  it('keeps the "set" lines, without the word "set", and nothing else', () => {
    const statements = readSetLines(['admin@ex1> show configuration | display set', 'set system host-name ex1', '', '  set vlans USERS vlan-id 10  ', '{master:0}', 'admin@ex1>'].join('\r\n'));

    expect(statements.map((statement) => statement.words)).toEqual([['system', 'host-name', 'ex1'], ['vlans', 'USERS', 'vlan-id', '10']]);
    expect(statements.map((statement) => statement.line)).toEqual([2, 4]);
    expect(statements[1].text).toBe('set vlans USERS vlan-id 10');
  });

  it('drops what "deactivate" turns off', () => {
    expect(
      words(['set interfaces ge-0/0/1 description A', 'set interfaces ge-0/0/1 disable', 'set interfaces ge-0/0/10 disable', 'set protocols dot1x authenticator interface ge-0/0/1', 'deactivate interfaces ge-0/0/1 disable', 'deactivate protocols dot1x'].join('\n')),
    ).toEqual([['interfaces', 'ge-0/0/1', 'description', 'A'], ['interfaces', 'ge-0/0/10', 'disable']]);
  });

  it('brings in the statements of the applied groups, before the statements of the configuration itself', () => {
    expect(
      words(['set groups COMMON system name-server 10.0.0.53', 'set groups UNUSED system name-server 10.9.9.9', 'set apply-groups COMMON', 'set system host-name ex1'].join('\n')),
    ).toEqual([['system', 'name-server', '10.0.0.53'], ['system', 'host-name', 'ex1']]);
  });

  it('leaves a group statement with a wildcard as it is, for the extractor to report', () => {
    expect(words(['set groups PORTS interfaces <ge-*> mtu 9216', 'set apply-groups PORTS'].join('\n'))).toEqual([['groups', 'PORTS', 'interfaces', '<ge-*>', 'mtu', '9216']]);
  });
});
