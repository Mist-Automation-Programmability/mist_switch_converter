/**
 * Port usages (port profiles) of the template.
 *
 * Ports with the same settings share one port usage, in one file or across files.
 * A port usage is named after the interface ranges of its ports, or after their
 * descriptions.
 */
import { Port } from '../model';
import { Report } from '../report';
import { MistPortUsage } from './mist';

/** Mist accepts 32 characters. One is kept, as before, so that names stay what they were. */
const MAX_NAME = 31;
/** Port usages that Mist defines itself. */
const MIST_PORT_USAGES = ['ap', 'default', 'disabled', 'dynamic', 'iot', 'uplink'];
/** At most this many descriptions are listed in a message. */
const MAX_DESCRIPTIONS_LISTED = 8;

/** The settings of a port as a port usage. The order of the fields is the order of the exported file. */
export function portUsageOf(port: Port, networkOf: (id: number) => string): MistPortUsage {
  const trunk = port.mode === 'trunk';
  const untagged = trunk ? port.nativeVlan : port.accessVlan;
  const auth = port.auth;
  const network = (id: number | undefined): string | undefined => (id === undefined ? undefined : networkOf(id));
  const usage: MistPortUsage = {
    all_networks: trunk && port.allowedVlans === 'all',
    disable_autoneg: !port.autoneg,
    disabled: port.disabled,
    duplex: port.duplex,
    speed: port.speed,
    enable_mac_auth: auth.dot1x && auth.macAuth,
    enable_qos: port.qos,
    mac_auth_only: auth.dot1x && auth.macAuthOnly,
    mac_limit: port.macLimit,
    mode: trunk ? 'trunk' : 'access',
    mtu: port.mtu,
    networks: trunk && port.allowedVlans !== 'all' ? port.allowedVlans.map(networkOf) : [],
    poe_disabled: !port.poe,
    port_auth: auth.dot1x ? 'dot1x' : undefined,
    stp_edge: port.stpEdge,
    voip_network: trunk ? undefined : network(port.voiceVlan),
    port_network: network(untagged),
    persist_mac: port.persistMac,
    guest_network: auth.dot1x ? network(auth.guestVlan) : undefined,
    bypass_auth_when_server_down: auth.dot1x && auth.bypassWhenServerDown,
  };
  if (auth.dot1x) {
    if (auth.multipleSupplicants) usage.allow_multiple_supplicants = true;
    if (auth.reauthInterval !== undefined) usage.reauth_interval = auth.reauthInterval;
    if (auth.serverFailVlan !== undefined) usage.server_fail_network = networkOf(auth.serverFailVlan);
    if (auth.serverRejectVlan !== undefined) usage.server_reject_network = networkOf(auth.serverRejectVlan);
    if (auth.permitWhenServerDown) usage.bypass_auth_when_server_down_for_unkown_client = true;
  }
  // As in the exported file, a setting without a value is absent.
  return JSON.parse(JSON.stringify(usage)) as MistPortUsage;
}

interface Entry {
  key: string;
  usage: MistPortUsage;
  name: string;
  /** Interface ranges of the ports that have this usage. */
  groups: string[];
  /** Descriptions of the ports that have this usage. */
  descriptions: string[];
}

/** A name with the characters that Mist accepts: lower case letters, digits and "_". */
function usageName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, MAX_NAME)
    .replace(/_+$/, '');
}

/** The words that most of the descriptions have in common: "desk" for "Desk 12" and "Desk 13". */
function commonWords(descriptions: string[]): string {
  const counts = new Map<string, number>();
  for (const description of descriptions) {
    for (const word of description.toLowerCase().split(/[^a-z0-9.]+/)) {
      if (word !== '' && word !== 'null') counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const most = Math.max(0, ...counts.values());
  return [...counts.entries()]
    .filter(([, count]) => count === most)
    .map(([word]) => word)
    .join(' ');
}

/** The port usages of a template, in the order in which the ports need them. */
export class PortUsages {
  private readonly entries = new Map<string, Entry>();

  /** Gives a port its usage. The returned object gets its name when `assignNames` runs. */
  add(port: Port, usage: MistPortUsage): { readonly name: string } {
    const key = JSON.stringify(usage);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, usage, name: '', groups: [], descriptions: [] };
      this.entries.set(key, entry);
    }
    for (const group of port.groups) if (!entry.groups.includes(group)) entry.groups.push(group);
    if (port.description && !entry.descriptions.includes(port.description)) entry.descriptions.push(port.description);
    return entry;
  }

  assignNames(report: Report): void {
    const used = new Set<string>();
    let sequence = 0;
    for (const entry of this.entries.values()) {
      sequence += 1;
      let wanted = '';
      if (entry.groups.length > 0) wanted = usageName(entry.groups.join('_'));
      else if (entry.descriptions.length === 1) wanted = usageName(entry.descriptions[0]);
      else if (entry.descriptions.length > 1) wanted = usageName(commonWords(entry.descriptions));
      if (wanted === '') wanted = 'profile';

      let name = wanted;
      // Two usages that would have the same name: the second one gets a number.
      for (let number = sequence; used.has(name); number++) name = `${wanted.substring(0, MAX_NAME - 4)}-${number.toString(16).padStart(4, '0')}`;
      used.add(name);
      entry.name = name;

      if (entry.groups.length === 0 && entry.descriptions.length > 1) {
        const listed = entry.descriptions.slice(0, MAX_DESCRIPTIONS_LISTED).join(',');
        const more = entry.descriptions.length > MAX_DESCRIPTIONS_LISTED ? ` and ${entry.descriptions.length - MAX_DESCRIPTIONS_LISTED} more` : '';
        report.warning('usage-name', `Port usage "${name}" is shared by ports with different descriptions and is named after the words they have in common: ${listed}${more}`);
      }
      if (MIST_PORT_USAGES.includes(name)) {
        report.warning('usage-name-reserved', `Port usage "${name}" has the name of a port usage that Mist defines itself: check it, or rename it, before importing the template`);
      }
    }
  }

  /** The port usages by name. */
  byName(): Record<string, MistPortUsage> {
    return Object.fromEntries([...this.entries.values()].map((entry) => [entry.name, entry.usage]));
  }
}
