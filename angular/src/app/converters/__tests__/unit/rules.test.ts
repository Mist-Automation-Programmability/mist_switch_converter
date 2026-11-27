import { describe, expect, it } from 'vitest';
import { ignore, rule, RuleTable } from '../../extractors/rules';
import type { Statement } from '../../readers/statement';

const statement = (text: string): Statement => ({ words: text.split(' '), text, line: 1, children: [] });

interface Target {
  seen: string[];
}

describe('Command rules', () => {
  it('gives the words of the command to the handler under the names of the pattern', () => {
    const table = new RuleTable<Target>([
      rule('switchport access vlan <id>', (target, m) => {
        target.seen.push(`vlan ${m.id}`);
      }),
      rule('description <text...>', (target, m) => {
        target.seen.push(`description "${m.text}"`);
      }),
      rule('channel-group <id> mode <mode>', (target, m) => {
        target.seen.push(`lag ${m.id} ${m.mode}`);
      }),
      rule('ip address ...', (target, m) => {
        target.seen.push(`address "${m.rest}"`);
      }),
    ]);
    const target: Target = { seen: [] };

    expect(table.apply(target, statement('switchport access vlan 30'))).toBe('converted');
    expect(table.apply(target, statement('description Printer on the 2nd floor'))).toBe('converted');
    expect(table.apply(target, statement('channel-group 1 mode active'))).toBe('converted');
    expect(table.apply(target, statement('ip address 10.0.0.1 255.255.255.0'))).toBe('converted');
    expect(table.apply(target, statement('ip address'))).toBe('converted');
    expect(target.seen).toEqual(['vlan 30', 'description "Printer on the 2nd floor"', 'lag 1 active', 'address "10.0.0.1 255.255.255.0"', 'address ""']);
  });

  it('tells a command that is left out on purpose from a command it does not know', () => {
    const table = new RuleTable<Target>([ignore('negotiation auto', 'snmp trap ...')]);
    const target: Target = { seen: [] };

    expect(table.apply(target, statement('negotiation auto'))).toBe('ignored');
    expect(table.apply(target, statement('snmp trap link-status'))).toBe('ignored');
    expect(table.apply(target, statement('storm-control broadcast level 1.00'))).toBe('unknown');
    expect(table.matches(['negotiation', 'auto'])).toBe(true);
    expect(table.matches(['negotiation'])).toBe(false);
  });

  it('needs every word of the pattern: a longer or shorter command is another command', () => {
    const table = new RuleTable<Target>([rule('switchport mode <mode>', (target, m) => void target.seen.push(m.mode))]);
    const target: Target = { seen: [] };

    expect(table.apply(target, statement('switchport mode'))).toBe('unknown');
    expect(table.apply(target, statement('switchport mode dynamic auto'))).toBe('unknown');
    expect(table.apply(target, statement('switchport mode trunk'))).toBe('converted');
    expect(target.seen).toEqual(['trunk']);
  });

  it('accepts abbreviated keywords of two letters or more, and prefers the command written in full', () => {
    const table = new RuleTable<Target>(
      [
        rule('shutdown', (target) => void target.seen.push('shutdown')),
        rule('switchport mode <mode>', (target, m) => void target.seen.push(`mode ${m.mode}`)),
        rule('speed <speed>', (target, m) => void target.seen.push(`speed ${m.speed}`)),
        rule('sh', (target) => void target.seen.push('the command "sh"')),
      ],
      { ignoreCase: true, abbreviations: true },
    );
    const target: Target = { seen: [] };

    expect(table.apply(target, statement('shut'))).toBe('converted');
    expect(table.apply(target, statement('SW mo access'))).toBe('converted');
    // "sh" could be "shutdown" cut short: the rule written for "sh" itself comes first.
    expect(table.apply(target, statement('sh'))).toBe('converted');
    expect(table.apply(target, statement('s'))).toBe('unknown');
    expect(target.seen).toEqual(['shutdown', 'mode access', 'the command "sh"']);
  });

  it('is strict about keywords unless told otherwise', () => {
    const table = new RuleTable<Target>([rule('disable', (target) => void target.seen.push('disable'))]);

    expect(table.apply({ seen: [] }, statement('dis'))).toBe('unknown');
    expect(table.apply({ seen: [] }, statement('Disable'))).toBe('unknown');
  });

  it('tries the next rule when a handler answers that the command is not for it', () => {
    const table = new RuleTable<Target>([
      rule('logging <address>', (target, m) => {
        if (!/^\d/.test(m.address)) return false;
        target.seen.push(`server ${m.address}`);
        return undefined;
      }),
      ignore('logging ...'),
    ]);
    const target: Target = { seen: [] };

    expect(table.apply(target, statement('logging 10.0.0.60'))).toBe('converted');
    expect(table.apply(target, statement('logging buffered'))).toBe('ignored');
    expect(target.seen).toEqual(['server 10.0.0.60']);
  });

  it('keeps the rules of "otherwise" for the commands that no other rule accepts, abbreviated or not', () => {
    const table = new RuleTable<Target>([rule('no shutdown', (target) => void target.seen.push('enabled'))], { abbreviations: true, otherwise: [ignore('no ...')] });
    const target: Target = { seen: [] };

    expect(table.apply(target, statement('no shut'))).toBe('converted');
    expect(table.apply(target, statement('no cdp enable'))).toBe('ignored');
    expect(target.seen).toEqual(['enabled']);
  });

  it('refuses a pattern with words after "..."', () => {
    expect(() => rule('ip ... address', () => undefined)).toThrow('"..." can only end a pattern');
  });
});

describe('supported commands', () => {
  it('lists, per platform, the commands that the rule tables convert', async () => {
    const { supportedCommands } = await import('../../supported');
    const platforms = supportedCommands();

    expect(platforms.map((platform) => platform.name)).toEqual(['Cisco IOS and IOS-XE', 'Juniper Junos', 'Aruba AOS-CX']);
    const cisco = platforms[0].places.find((place) => place.place === 'interface');
    expect(cisco?.converted).toContain('switchport access vlan <id>');
    expect(cisco?.ignored).toBeGreaterThan(0);
    for (const platform of platforms) for (const place of platform.places) expect(place.converted.length + place.ignored).toBeGreaterThan(0);
  });
});
