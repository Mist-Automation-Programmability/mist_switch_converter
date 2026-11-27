/**
 * Junos interface names: what kind of interface they name, and the ports of an
 * interface range.
 */
import { PortKind } from '../model';

export interface JunosInterface {
  /** The name without its unit: ge-0/0/1 for "ge-0/0/1.0". */
  name: string;
  kind: PortKind;
  /** For an aggregated interface, its number: 10 for ae10. */
  number?: number;
}

const PHYSICAL = /^(ge|mge|xe|et|fe)-\d+\/\d+\/\d+$/;

export function readJunosInterface(text: string): JunosInterface {
  const name = text.replace(/\.\d+$/, '');
  if (PHYSICAL.test(name)) return { name, kind: 'physical' };
  const aggregated = /^ae(\d+)$/.exec(name);
  if (aggregated) return { name, kind: 'lag', number: Number(aggregated[1]) };
  if (name === 'irb' || name === 'vlan') return { name, kind: 'svi' };
  if (/^(me|vme|em|fxp)\d*$/.test(name)) return { name, kind: 'management' };
  if (/^lo\d+$/.test(name)) return { name, kind: 'loopback' };
  return { name, kind: 'other' };
}

/** A member of an interface range never names more ports than this. */
const MAX_MEMBERS = 2000;

/** "0", "0-3" or "[0-3,7]" as numbers. */
function numbersOf(field: string): number[] | undefined {
  const numbers: number[] = [];
  for (const part of field.replace(/^\[|\]$/g, '').split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) return undefined;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from > to || to - from >= MAX_MEMBERS) return undefined;
    for (let value = from; value <= to; value++) numbers.push(value);
  }
  return numbers;
}

function portsOf(type: string, fpcs: number[], pics: number[], ports: number[]): string[] | undefined {
  if (fpcs.length * pics.length * ports.length > MAX_MEMBERS) return undefined;
  return fpcs.flatMap((fpc) => pics.flatMap((pic) => ports.map((port) => `${type}-${fpc}/${pic}/${port}`)));
}

/**
 * The ports of "member ge-0/0/10", "member ge-0/0/[20-21]" or "member ge-[0-1]/0/[0-47]".
 * Returns undefined when the member is not a list of ports, as with a wildcard ("ge-0/0/*").
 */
export function expandMember(member: string): string[] | undefined {
  const match = /^([a-z]+)-([^/]+)\/([^/]+)\/([^/]+)$/.exec(member);
  if (!match) return /^[a-z]+\d*$/.test(member) ? [member] : undefined;
  const [fpcs, pics, ports] = [numbersOf(match[2]), numbersOf(match[3]), numbersOf(match[4])];
  return fpcs && pics && ports ? portsOf(match[1], fpcs, pics, ports) : undefined;
}

/** The ports of "member-range ge-0/0/0 to ge-0/0/3": every position between the two ends. */
export function expandMemberRange(first: string, last: string): string[] | undefined {
  const from = /^([a-z]+)-(\d+)\/(\d+)\/(\d+)$/.exec(first);
  const to = /^([a-z]+)-(\d+)\/(\d+)\/(\d+)$/.exec(last);
  if (!from || !to || from[1] !== to[1]) return undefined;
  const span = (index: number): number[] | undefined => numbersOf(`${from[index]}-${to[index]}`);
  const [fpcs, pics, ports] = [span(2), span(3), span(4)];
  return fpcs && pics && ports ? portsOf(from[1], fpcs, pics, ports) : undefined;
}

/** A test for the names that a member with wildcards stands for: "ge-0/0/*", "ge-0/?/1". */
export function wildcardMember(member: string): RegExp {
  const pattern = member.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\[!/g, '[^');
  return new RegExp(`^${pattern}$`);
}
