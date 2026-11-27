/**
 * Cisco IOS interface names: their long form, what kind of interface they name and
 * where the port sits on a Juniper switch.
 */
import { PortKind } from '../model';

interface InterfaceType {
  /** Long form, as a running configuration prints it. */
  name: string;
  kind: PortKind;
  /** Prefix of the port at the same position on a Juniper switch. */
  junos?: string;
}

// The order matters for abbreviations: "tw" is TwoGigabitEthernet and "twe" TwentyFiveGigE, as on the device.
const TYPES: InterfaceType[] = [
  { name: 'FastEthernet', kind: 'physical', junos: 'fe' },
  { name: 'GigabitEthernet', kind: 'physical', junos: 'ge' },
  { name: 'TwoGigabitEthernet', kind: 'physical', junos: 'mge' },
  { name: 'FiveGigabitEthernet', kind: 'physical', junos: 'mge' },
  { name: 'TenGigabitEthernet', kind: 'physical', junos: 'mge' },
  { name: 'TwentyFiveGigE', kind: 'physical', junos: 'et' },
  { name: 'FortyGigabitEthernet', kind: 'physical', junos: 'et' },
  { name: 'HundredGigE', kind: 'physical', junos: 'et' },
  { name: 'Port-channel', kind: 'lag' },
  { name: 'Vlan', kind: 'svi' },
  { name: 'Loopback', kind: 'loopback' },
  // The internal port of a Catalyst 9000 towards its hosted applications. It has no connector,
  // and its number (1/0/1) is also the number of the first port of the front panel.
  { name: 'AppGigabitEthernet', kind: 'internal' },
  { name: 'Tunnel', kind: 'other' },
  { name: 'Null', kind: 'other' },
  { name: 'Bluetooth', kind: 'other' },
];

export interface CiscoInterface {
  /** Long form of the name: GigabitEthernet1/0/1 for "gi1/0/1" or "GigabitEthernet 1/0/1". */
  name: string;
  kind: PortKind;
  junosName?: string;
  /** For a VLAN interface, the id of its VLAN. For a port-channel, its number. */
  number?: number;
}

function findType(prefix: string): InterfaceType | undefined {
  const wanted = prefix.toLowerCase();
  return TYPES.find((type) => type.name.toLowerCase() === wanted) ?? (wanted.length >= 2 ? TYPES.find((type) => type.name.toLowerCase().startsWith(wanted)) : undefined);
}

/** Reads an interface name as it can be written after "interface". */
export function readCiscoInterface(text: string): CiscoInterface {
  const compact = text.replace(/\s+/g, '');
  const match = /^([A-Za-z][A-Za-z-]*?)(\d[\d/.:]*)?$/.exec(compact);
  const type = match ? findType(match[1]) : undefined;
  if (!match || !type) return { name: compact, kind: 'other' };

  const numbers = match[2] ?? '';
  const name = type.name + numbers;
  if (type.kind !== 'physical') return { name, kind: type.kind, number: /^\d+$/.test(numbers) ? Number(numbers) : undefined };

  // GigabitEthernet1/0/1.100 is a sub-interface, not a switch port.
  if (!/^\d+(\/\d+)*$/.test(numbers)) return { name, kind: 'other' };
  const position = numbers.split('/').map(Number);
  // Front panel ports are numbered from 1: GigabitEthernet0/0 and FastEthernet0 are management ports.
  if (position[position.length - 1] === 0) return { name, kind: 'management' };
  return { name, kind: 'physical', junosName: junosPortName(type.junos ?? 'ge', position) };
}

/**
 * Member 1 of a stack is FPC 0 and port 1 is port 0:
 *     GigabitEthernet1/0/1  ge-0/0/0     switch / module / port
 *     GigabitEthernet0/1    ge-0/0/0     module / port, on a switch that does not stack
 */
function junosPortName(prefix: string, position: number[]): string | undefined {
  let fpc: number;
  let pic = 0;
  let port: number;
  if (position.length === 3) [fpc, pic, port] = [position[0] - 1, position[1], position[2] - 1];
  else if (position.length === 2) [fpc, port] = [position[0], position[1] - 1];
  else if (position.length === 1) [fpc, port] = [0, position[0] - 1];
  else return undefined;
  return fpc < 0 || port < 0 ? undefined : `${prefix}-${fpc}/${pic}/${port}`;
}

/** An "interface range" never names more ports than this. */
const MAX_RANGE = 512;

/**
 * The interfaces of "interface range GigabitEthernet1/0/5 - 8 , gi1/0/20 - 22".
 * Returns undefined when the range cannot be read, for example "interface range macro <name>".
 */
export function expandCiscoInterfaceRange(spec: string): string[] | undefined {
  const names: string[] = [];
  for (const part of spec.split(',')) {
    const compact = part.replace(/\s+/g, '');
    const range = /^(.*?)(\d+)-(\d+)$/.exec(compact);
    if (!range) {
      if (!/\d$/.test(compact)) return undefined;
      names.push(compact);
      continue;
    }
    const [from, to] = [Number(range[2]), Number(range[3])];
    if (from > to || names.length + to - from >= MAX_RANGE) return undefined;
    for (let port = from; port <= to; port++) names.push(range[1] + port);
  }
  return names.length > 0 ? names : undefined;
}
