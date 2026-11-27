/**
 * Networks of the template: one per VLAN id, whatever the number of files that use it.
 *
 * Devices refer to VLANs by id. The name of each network is chosen here, once, so
 * that every port usage and every file use the same name for the same VLAN.
 */
import { Device } from '../model';
import { Report } from '../report';
import { MistNetwork } from './mist';

/** Mist accepts 32 characters. */
const MAX_NAME = 32;

export interface Networks {
  /** The networks by name, sorted by VLAN id. */
  byName: Record<string, MistNetwork>;
  /** The name of the network of a VLAN. */
  nameOf(id: number): string;
}

interface Collected {
  id: number;
  /** Names that the VLAN databases of the devices give to the VLAN, with the file of each. */
  names: Array<{ name: string; file: string }>;
  aliases: string[];
  subnets: string[];
}

/** A name with the characters that Mist accepts: lower case letters, digits and "_". */
export function networkName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, MAX_NAME)
    .replace(/_+$/, '');
}

function generatedName(id: number): string {
  // VLAN 1 is the network that Mist calls "default".
  return id === 1 ? 'default' : `vlan${id}`;
}

export function buildNetworks(devices: Device[], report: Report): Networks {
  // In the order in which the files mention the VLANs: the first file to name a VLAN wins.
  const collected = new Map<number, Collected>();
  for (const device of devices) {
    for (const vlan of device.vlans) {
      const entry = collected.get(vlan.id) ?? { id: vlan.id, names: [], aliases: [], subnets: [] };
      collected.set(vlan.id, entry);
      if (vlan.name !== undefined) entry.names.push({ name: vlan.name, file: device.file });
      if (vlan.alias !== undefined) entry.aliases.push(vlan.alias);
      for (const subnet of vlan.subnets) if (!entry.subnets.includes(subnet)) entry.subnets.push(subnet);
    }
  }

  const names = new Map<number, string>();
  const used = new Set<string>();
  const take = (id: number, wanted: string): void => {
    let name = wanted;
    // Two VLANs with the same name stay two networks: the second one gets its id in its name.
    if (used.has(name)) name = `${wanted.substring(0, MAX_NAME - 7)}-vl${id}`;
    for (let attempt = 2; used.has(name); attempt++) name = `${wanted.substring(0, MAX_NAME - 10)}-vl${id}-${attempt}`;
    used.add(name);
    names.set(id, name);
  };
  // VLANs with a name of their own choose first, so that a generated name ("vlan20") never takes it from them.
  const candidates = [...collected.values()].map((entry) => ({
    entry,
    declared: entry.names.map((candidate) => networkName(candidate.name)).find((name) => name !== ''),
    alias: entry.aliases.map(networkName).find((name) => name !== ''),
  }));
  for (const { entry, declared } of candidates) if (declared !== undefined) take(entry.id, declared);
  for (const { entry, declared, alias } of candidates) if (declared === undefined && alias !== undefined) take(entry.id, alias);
  for (const { entry, declared, alias } of candidates) {
    if (declared !== undefined || alias !== undefined) continue;
    take(entry.id, generatedName(entry.id));
    if (entry.id !== 1) report.info('vlan-without-name', `VLAN ${entry.id} has no name in the files: its network is named "${names.get(entry.id)}"`);
  }

  for (const { entry } of candidates) {
    const different = [...new Set(entry.names.map((candidate) => candidate.name))];
    if (new Set(different.map(networkName)).size > 1) {
      report.warning('vlan-names', `VLAN ${entry.id} has multiple names (${different.join(', ')}). Using the first one: "${names.get(entry.id)}"`);
    }
    if (entry.subnets.length > 1) {
      report.warning('vlan-subnets', `VLAN ${entry.id} has multiple subnets (${entry.subnets.join(', ')}). Using the first one: "${entry.subnets[0]}"`);
    }
  }

  const byName: Record<string, MistNetwork> = {};
  for (const entry of [...collected.values()].sort((a, b) => a.id - b.id)) {
    byName[names.get(entry.id) ?? generatedName(entry.id)] = { vlan_id: String(entry.id), subnet: entry.subnets[0] ?? null };
  }
  return { byName, nameOf: (id) => names.get(id) ?? generatedName(id) };
}
