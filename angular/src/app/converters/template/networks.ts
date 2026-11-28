/**
 * Networks of the template: one per VLAN id, whatever the number of files that use it.
 *
 * Devices refer to VLANs by id. The name of each network is chosen here, once, so
 * that every port usage and every file use the same name for the same VLAN.
 */
import { Device } from '../model';
import { Report } from '../report';
import { MistNetwork } from './mist';
import { Origin } from './origin';

/** Mist accepts 32 characters. */
const MAX_NAME = 32;

export interface Networks {
  /** The networks by name, sorted by VLAN id. */
  byName: Record<string, MistNetwork>;
  /** The name of the network of a VLAN. */
  nameOf(id: number): string;
  /** Where each network comes from and why it has its name. */
  origins: Origin[];
}

interface Collected {
  id: number;
  /** Names that the VLAN databases of the devices give to the VLAN, with the file of each. */
  names: Array<{ name: string; file: string }>;
  aliases: Array<{ alias: string; file: string }>;
  subnets: string[];
  /** The files that declare or use the VLAN, with the lines that name it. */
  sources: Array<{ file: string; lines: number[] }>;
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
      const entry = collected.get(vlan.id) ?? { id: vlan.id, names: [], aliases: [], subnets: [], sources: [] };
      collected.set(vlan.id, entry);
      entry.sources.push({ file: device.file, lines: [...(vlan.lines ?? [])].sort((a, b) => a - b) });
      if (vlan.name !== undefined) entry.names.push({ name: vlan.name, file: device.file });
      if (vlan.alias !== undefined) entry.aliases.push({ alias: vlan.alias, file: device.file });
      for (const subnet of vlan.subnets) if (!entry.subnets.includes(subnet)) entry.subnets.push(subnet);
    }
  }

  const names = new Map<number, string>();
  /** Why each network has its name, for the user. */
  const naming = new Map<number, string>();
  const used = new Set<string>();
  const take = (id: number, wanted: string): void => {
    let name = wanted;
    // Two VLANs with the same name stay two networks: the second one gets its id in its name.
    if (used.has(name)) {
      name = `${wanted.substring(0, MAX_NAME - 7)}-vl${id}`;
      naming.set(id, `${naming.get(id) ?? ''} Another VLAN has the same name, so the VLAN id was added to it.`.trim());
    }
    for (let attempt = 2; used.has(name); attempt++) name = `${wanted.substring(0, MAX_NAME - 10)}-vl${id}-${attempt}`;
    used.add(name);
    names.set(id, name);
  };
  // VLANs with a name of their own choose first, so that a generated name ("vlan20") never takes it from them.
  const candidates = [...collected.values()].map((entry) => ({
    entry,
    declared: entry.names.find((candidate) => networkName(candidate.name) !== ''),
    alias: entry.aliases.find((candidate) => networkName(candidate.alias) !== ''),
  }));
  for (const { entry, declared } of candidates) {
    if (declared === undefined) continue;
    naming.set(entry.id, `Named after the name of VLAN ${entry.id} in ${declared.file}: "${declared.name}".`);
    take(entry.id, networkName(declared.name));
  }
  for (const { entry, declared, alias } of candidates) {
    if (declared !== undefined || alias === undefined) continue;
    naming.set(entry.id, `No file names VLAN ${entry.id}: named after the description of its layer 3 interface in ${alias.file}, "${alias.alias}".`);
    take(entry.id, networkName(alias.alias));
  }
  for (const { entry, declared, alias } of candidates) {
    if (declared !== undefined || alias !== undefined) continue;
    naming.set(entry.id, entry.id === 1 ? 'VLAN 1 is the network that Mist calls "default".' : `No file names VLAN ${entry.id}: named after its id.`);
    take(entry.id, generatedName(entry.id));
    if (entry.id !== 1) report.info('vlan-without-name', `VLAN ${entry.id} has no name in the files: its network is named "${names.get(entry.id)}"`, undefined, `networks.${names.get(entry.id)}`);
  }

  for (const { entry } of candidates) {
    const different = [...new Set(entry.names.map((candidate) => candidate.name))];
    if (new Set(different.map(networkName)).size > 1) {
      report.warning('vlan-names', `VLAN ${entry.id} has multiple names (${different.join(', ')}). Using the first one: "${names.get(entry.id)}"`, undefined, `networks.${names.get(entry.id)}`);
    }
    if (entry.subnets.length > 1) {
      report.warning('vlan-subnets', `VLAN ${entry.id} has multiple subnets (${entry.subnets.join(', ')}). Using the first one: "${entry.subnets[0]}"`, undefined, `networks.${names.get(entry.id)}`);
    }
  }

  const byName: Record<string, MistNetwork> = {};
  const origins: Origin[] = [];
  for (const entry of [...collected.values()].sort((a, b) => a.id - b.id)) {
    const name = names.get(entry.id) ?? generatedName(entry.id);
    byName[name] = { vlan_id: String(entry.id), subnet: entry.subnets[0] ?? null };
    origins.push({ path: `networks.${name}`, sources: entry.sources, naming: naming.get(entry.id) });
  }
  return { byName, nameOf: (id) => names.get(id) ?? generatedName(id), origins };
}
