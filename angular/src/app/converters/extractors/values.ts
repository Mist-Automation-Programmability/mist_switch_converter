/**
 * Values that every vendor writes in much the same way: lists of VLAN ids,
 * addresses, subnets.
 */

export interface VlanRange {
  from: number;
  to: number;
}

/** "10,20,30-32" as ranges. Returns undefined when the text is not a list of VLAN ids. */
export function parseVlanList(text: string): VlanRange[] | undefined {
  const ranges: VlanRange[] = [];
  for (const entry of text.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(entry.trim());
    if (!match) return undefined;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > 4094 || from > to) return undefined;
    ranges.push({ from, to });
  }
  return ranges;
}

export function isVlanId(text: string): boolean {
  return /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 4094;
}

/** A range that names more VLANs than this stands for "the VLANs of the switch in that range". */
export const WIDE_VLAN_RANGE = 100;

/**
 * The VLAN ids of a list of ranges.
 *  - A range from 1 to 4094 is every VLAN: the result is 'all'.
 *  - A wide range gives the VLANs of `known` that are in it, in ascending order.
 *  - A short range gives every id of the range when `createShortRanges` is set
 *    (a device whose VLAN database may not be in the file), and the VLANs of `known`
 *    that are in it otherwise.
 */
export function expandVlanRanges(ranges: VlanRange[], known: number[], createShortRanges: boolean): number[] | 'all' {
  const ids: number[] = [];
  const add = (id: number): void => {
    if (!ids.includes(id)) ids.push(id);
  };
  const sorted = [...known].sort((a, b) => a - b);
  for (const range of ranges) {
    if (range.from <= 1 && range.to >= 4094) return 'all';
    const wide = range.to - range.from > WIDE_VLAN_RANGE;
    if (range.from === range.to || (createShortRanges && !wide)) {
      for (let id = range.from; id <= range.to; id++) add(id);
    } else {
      sorted.filter((id) => id >= range.from && id <= range.to).forEach(add);
    }
  }
  return ids;
}

export function isIpv4(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isIpAddress(text: string): boolean {
  return isIpv4(text) || (/^[0-9a-fA-F:.]+$/.test(text) && text.includes(':') && text.length > 2);
}

function toNumber(address: string): number {
  return address.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
}

function toAddress(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');
}

/**
 * The subnet of an interface address, as "10.1.10.0/24".
 * Accepts "10.1.10.1/24" and "10.1.10.1 255.255.255.0"; what follows the mask is not read.
 * Returns null when the text has no address or no mask, as in "dhcp".
 */
export function subnetOf(text: string): string | null {
  const [address, mask] = text.trim().split(/[\s/]+/);
  if (address === undefined || mask === undefined || !isIpv4(address)) return null;
  let length: number;
  if (/^\d{1,2}$/.test(mask) && Number(mask) <= 32 && text.includes('/')) length = Number(mask);
  else if (isIpv4(mask)) length = toNumber(mask).toString(2).split('1').length - 1;
  else return null;
  const size = 2 ** (32 - length);
  return `${toAddress(Math.floor(toNumber(address) / size) * size)}/${length}`;
}
