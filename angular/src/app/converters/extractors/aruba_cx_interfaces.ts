/**
 * Aruba AOS-CX interface names: what kind of interface they name and where the port
 * sits on a Juniper switch.
 */
import { PortKind } from '../model';

export interface ArubaInterface {
  /** The name without spaces: 1/1/1, lag1, vlan10, mgmt. */
  name: string;
  kind: PortKind;
  junosName?: string;
  /** For a VLAN interface, the id of its VLAN. For a link aggregation, its number. */
  number?: number;
}

/**
 * Reads an interface name as it is written after "interface".
 *
 * A port is member/slot/port, all numbered from 1. Member 1 of a stack is FPC 0, slot 1
 * is PIC 0 and port 1 is port 0:
 *     1/1/1     ge-0/0/0
 *     2/1/24    ge-1/0/23
 * The name of a port does not say its speed: every port is named "ge".
 */
export function readArubaInterface(text: string): ArubaInterface {
  const words = text.trim().toLowerCase().split(/\s+/);
  // "lag 1", "lag1", "lag 1 multi-chassis", "vlan 10", "vlan10", "loopback 0"
  const typed = /^(lag|vlan|loopback)\s?(\d+)\b/.exec(words.join(' '));
  if (typed) {
    const kind: PortKind = typed[1] === 'lag' ? 'lag' : typed[1] === 'vlan' ? 'svi' : 'loopback';
    return { name: `${typed[1]}${typed[2]}`, kind, number: Number(typed[2]) };
  }
  const name = words.join('');
  if (name === 'mgmt') return { name, kind: 'management' };
  const position = /^(\d+)\/(\d+)\/(\d+)$/.exec(name);
  if (position) {
    const [member, slot, port] = position.slice(1).map(Number);
    return { name, kind: 'physical', junosName: member < 1 || slot < 1 || port < 1 ? undefined : `ge-${member - 1}/${slot - 1}/${port - 1}` };
  }
  // 1/1/49:1 is one lane of a port that is split: its position has no equivalent.
  if (/^\d+\/\d+\/\d+:\d+$/.test(name)) return { name, kind: 'physical' };
  // Sub-interfaces (1/1/1.100), tunnels, VXLAN
  return { name, kind: 'other' };
}

/** An interface range never names more ports than this. */
const MAX_RANGE = 512;

/**
 * The ports of "interface 1/1/1-1/1/24" or "interface 1/1/1,1/1/5-1/1/8".
 * Returns undefined for a name that is not a list of ports.
 */
export function expandArubaInterfaceRange(spec: string): string[] | undefined {
  const compact = spec.replace(/\s+/g, '');
  if (!/[-,]/.test(compact)) return undefined;
  const names: string[] = [];
  for (const part of compact.split(',')) {
    const range = /^(\d+\/\d+\/)(\d+)(?:-(\d+\/\d+\/)(\d+))?$/.exec(part);
    if (!range) return undefined;
    const from = Number(range[2]);
    const to = range[4] === undefined ? from : Number(range[4]);
    // A range stays within one member and one slot.
    if ((range[3] !== undefined && range[3] !== range[1]) || from > to || names.length + to - from >= MAX_RANGE) return undefined;
    for (let port = from; port <= to; port++) names.push(`${range[1]}${port}`);
  }
  return names;
}
