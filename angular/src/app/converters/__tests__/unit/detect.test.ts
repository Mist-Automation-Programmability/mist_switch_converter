import { describe, expect, it } from 'vitest';
import { detectFormat } from '../../detect';

const text = (...lines: string[]): string => lines.join('\n');

describe('Detection of the type of file', () => {
  it('recognises a Cisco IOS running configuration', () => {
    expect(detectFormat(text('Building configuration...', '!', 'version 17.9', 'hostname sw1', '!', 'interface GigabitEthernet1/0/1', ' switchport mode access', '!', 'end'))).toEqual({ vendor: 'cisco-ios' });
  });

  it('recognises a Cisco IOS script without any "!" line, with abbreviated commands', () => {
    expect(detectFormat(text('conf t', 'int gi1/0/1', 'sw mode access', 'shut', 'exit'))).toEqual({ vendor: 'cisco-ios' });
  });

  it('recognises a Cisco IOS capture with Windows line endings', () => {
    expect(detectFormat('sw1#show running-config\r\nhostname sw1\r\ninterface GigabitEthernet1/0/1\r\n shutdown\r\n')).toEqual({ vendor: 'cisco-ios' });
  });

  it('recognises the commands of a Cisco IOS terminal after their prompts', () => {
    expect(detectFormat(text('sw1#configure terminal', 'sw1(config)#interface GigabitEthernet1/0/1', 'sw1(config-if)#description Printer', 'sw1(config-if)#end'))).toEqual({ vendor: 'cisco-ios' });
    expect(detectFormat(text('sw1>enable', 'sw1#sh run', 'Building configuration...'))).toEqual({ vendor: 'cisco-ios' });
  });

  it('recognises Junos "display set" output', () => {
    expect(detectFormat(text('admin@ex1> show configuration | display set', 'set version 21.4R3', 'set system host-name ex1', 'set vlans USERS vlan-id 10'))).toEqual({ vendor: 'junos' });
  });

  it('does not take a Cisco configuration with a route-map for Junos', () => {
    expect(detectFormat(text('hostname sw1', '!', 'route-map PBR permit 10', ' set ip next-hop 10.0.0.1', ' set interface Null0', '!', 'interface GigabitEthernet1/0/1'))).toEqual({ vendor: 'cisco-ios' });
  });

  it('refuses a Junos configuration with braces and says how to save it', () => {
    const detection = detectFormat(text('system {', '    host-name ex1;', '}', 'vlans {', '    USERS {', '        vlan-id 10;', '    }', '}'));

    expect(detection.vendor).toBeUndefined();
    expect(detection.reason).toContain('display set');
  });

  it('refuses an Aruba AOS-CX configuration, which looks like Cisco IOS', () => {
    const detection = detectFormat(text('!', '!Version ArubaOS-CX FL.10.10.1020', 'hostname cx1', 'vlan 10', 'interface 1/1/1', '    no shutdown', '    no routing', '    vlan access 10'));

    expect(detection.vendor).toBeUndefined();
    expect(detection.reason).toContain('Aruba AOS-CX');
    // Without its header line, too.
    expect(detectFormat(text('hostname cx1', 'interface 1/1/1', '    no routing', '    vlan access 10')).reason).toContain('Aruba AOS-CX');
  });

  it('refuses a Cisco NX-OS configuration', () => {
    const detection = detectFormat(text('!Command: show running-config', 'version 9.3(8)', 'hostname nx1', 'feature lacp', 'feature interface-vlan', 'interface Ethernet1/1', '  switchport mode trunk'));

    expect(detection.vendor).toBeUndefined();
    expect(detection.reason).toContain('NX-OS');
  });

  it('does not know a file that is not a configuration', () => {
    expect(detectFormat('Switch inventory\nsw1 10.0.0.1\nsw2 10.0.0.2\n')).toEqual({});
    expect(detectFormat('')).toEqual({});
  });
});
