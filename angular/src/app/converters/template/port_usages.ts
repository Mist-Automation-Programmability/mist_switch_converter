/**
 * Port usages (port profiles) of the template.
 *
 * Ports with the same settings share one port usage, in one file or across files.
 * A port usage is named after the interface ranges of its ports, after their
 * descriptions when most of the ports have one, or after its settings.
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
  const storm = port.stormControl;
  if (storm) {
    usage.storm_control = {
      no_broadcast: !storm.broadcast,
      no_multicast: !storm.multicast,
      no_registered_multicast: !storm.registeredMulticast,
      no_unknown_unicast: !storm.unknownUnicast,
      percentage: storm.percentage,
      ...(storm.shutdown ? { disable_port: true } : {}),
    };
  }
  if (port.dhcpTrusted !== undefined) usage.allow_dhcpd = port.dhcpTrusted;
  if (auth.dot1x) {
    if (auth.multipleSupplicants) usage.allow_multiple_supplicants = true;
    if (auth.reauthInterval !== undefined) usage.reauth_interval = auth.reauthInterval;
    if (auth.serverFailVlan !== undefined) usage.server_fail_network = networkOf(auth.serverFailVlan);
    if (auth.serverRejectVlan !== undefined) usage.server_reject_network = networkOf(auth.serverRejectVlan);
    if (auth.permitWhenServerDown) usage.bypass_auth_when_server_down_for_unknown_client = true;
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
  /** How many ports have this usage, and how many of them have a description. */
  ports: number;
  described: number;
  /** Why the port usage has its name, for the user. */
  naming: string;
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

/** The words that more than half of the descriptions have: "desk" for "Desk 12" and "Desk 13". */
function commonWords(descriptions: string[]): string {
  const counts = new Map<string, number>();
  for (const description of descriptions) {
    const words = description.toLowerCase().split(/[^a-z0-9.]+/);
    for (const word of new Set(words)) {
      if (word !== '' && word !== 'null') counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count * 2 > descriptions.length)
    .map(([word]) => word)
    .join(' ');
}

/**
 * The name that the descriptions give, or "". Descriptions name a port usage when more
 * than half of its ports have one: the description of one port says nothing about the
 * other ports that happen to have the same settings.
 */
function nameFromDescriptions(entry: Entry): string {
  if (entry.described * 2 <= entry.ports) return '';
  return usageName(entry.descriptions.length === 1 ? entry.descriptions[0] : commonWords(entry.descriptions));
}

/** What a port usage does, in a few words: "access users voip", "trunk all", "trunk 12_vlans". */
function settingsWords(usage: MistPortUsage): string[] {
  const words: string[] = [];
  if (usage.disabled) words.push('disabled');
  words.push(usage.mode);
  if (usage.mode === 'trunk') {
    if (usage.all_networks) words.push('all');
    else if (usage.networks.length === 1) words.push(usage.networks[0]);
    else if (usage.networks.length > 1) words.push(`${usage.networks.length}_vlans`);
  } else {
    if (usage.port_network !== undefined) words.push(usage.port_network);
    if (usage.voip_network !== undefined) words.push('voip');
  }
  if (usage.mac_auth_only) words.push('mab');
  else if (usage.port_auth !== undefined) words.push(usage.enable_mac_auth ? 'dot1x_mab' : 'dot1x');
  return words;
}

function nameFromSettings(usage: MistPortUsage): string {
  return settingsWords(usage).join('_');
}

/**
 * Words for the settings that tell port usages with the same name apart. A word is used
 * only when the port usages differ on it: "access_users" and "access_users_qos_nopoe".
 */
const DISTINCTIVE: Array<(usage: MistPortUsage) => string> = [
  (usage) => (usage.mode === 'trunk' && usage.port_network !== undefined ? `native_${usage.port_network}` : ''),
  (usage) => (usage.guest_network !== undefined ? 'guest' : ''),
  (usage) => (usage.enable_qos ? 'qos' : ''),
  (usage) => (usage.poe_disabled ? 'nopoe' : ''),
  (usage) => (usage.stp_edge ? 'edge' : ''),
  (usage) => (usage.speed === 'auto' ? '' : usage.speed),
  (usage) => (usage.duplex === 'auto' ? '' : usage.duplex),
  (usage) => (usage.disable_autoneg ? 'noneg' : ''),
  (usage) => (usage.mtu !== undefined ? `mtu${usage.mtu}` : ''),
  (usage) => (usage.mac_limit > 0 ? `mac${usage.mac_limit}` : ''),
  (usage) => (usage.persist_mac ? 'sticky' : ''),
  (usage) => (usage.storm_control ? `storm${usage.storm_control.percentage}` : ''),
  (usage) => (usage.allow_dhcpd === undefined ? '' : usage.allow_dhcpd ? 'trusted' : 'untrusted'),
];

/** The words that tell each port usage apart from the others of the list. */
function distinctiveWords(usages: MistPortUsage[]): string[][] {
  const differing = DISTINCTIVE.filter((word) => new Set(usages.map(word)).size > 1);
  return usages.map((usage) => differing.map((word) => word(usage)).filter((word) => word !== ''));
}

/** A name and more words, as many as fit: a name is never cut in the middle of a word that tells it apart. */
function withWords(name: string, words: string[]): string {
  let result = usageName(name);
  for (const word of words) {
    if (result.length + 1 + word.length > MAX_NAME) break;
    result = `${result}_${usageName(word)}`;
  }
  return result;
}

/** Names after the settings for the given port usages: the common part, then what tells them apart. */
function namesFromSettings(usages: MistPortUsage[]): string[] {
  const names = usages.map(nameFromSettings);
  return usages.map((usage, index) => {
    const alike = usages.filter((_, other) => names[other] === names[index]);
    return withWords(names[index], distinctiveWords(alike)[alike.indexOf(usage)]);
  });
}

/**
 * Port usages that their ranges or descriptions name alike: "printer" for the printers
 * of two VLANs. What tells them apart is added: "printer_floor1" and "printer_floor2",
 * "desk" and "desk_voip", "camera" and "camera_nopoe".
 */
function tellApart(names: string[], usages: MistPortUsage[]): string[] {
  return names.map((name, index) => {
    const alike = usages.filter((_, other) => names[other] === name);
    if (name === '' || alike.length === 1) return name;
    const position = alike.indexOf(usages[index]);
    const settings = alike.map(settingsWords);
    // A word that all of them have says nothing: "access" when all are access ports
    const telling = settings[position].filter((word) => !settings.every((words) => words.includes(word)));
    return withWords(name, [...telling, ...distinctiveWords(alike)[position]]);
  });
}

/** Why a port usage has its name, in a sentence or two. */
function namingOf(entry: Entry, given: boolean, toldApart: boolean, numbered: boolean): string {
  const sentences: string[] = [];
  if (!given) sentences.push(`Named after its settings: ${settingsWords(entry.usage).join(', ')}.`);
  else if (entry.groups.length > 0) sentences.push(`Named after the interface range${entry.groups.length > 1 ? 's' : ''} of its ports: ${entry.groups.join(', ')}.`);
  else if (entry.descriptions.length === 1) sentences.push(`Named after the description of its ports: "${entry.descriptions[0]}".`);
  else sentences.push(`Named after the words that most descriptions of its ports share: "${commonWords(entry.descriptions)}".`);
  if (given && entry.groups.length === 0 && entry.described < entry.ports) sentences.push(`${entry.described} of its ${entry.ports} ports have a description.`);
  if (toldApart) sentences.push('Other port usages would have the same name: words for the settings that differ were added.');
  if (numbered) sentences.push('Another port usage has the same name: a number was added.');
  return sentences.join(' ');
}

/** The port usages of a template, in the order in which the ports need them. */
export class PortUsages {
  private readonly entries = new Map<string, Entry>();

  /** Gives a port its usage. The returned object gets its name when `assignNames` runs. */
  add(port: Port, usage: MistPortUsage): { readonly name: string } {
    const key = JSON.stringify(usage);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, usage, name: '', groups: [], descriptions: [], ports: 0, described: 0, naming: '' };
      this.entries.set(key, entry);
    }
    for (const group of port.groups) if (!entry.groups.includes(group)) entry.groups.push(group);
    entry.ports += 1;
    if (port.description) entry.described += 1;
    if (port.description && !entry.descriptions.includes(port.description)) entry.descriptions.push(port.description);
    return entry;
  }

  assignNames(report: Report): void {
    const entries = [...this.entries.values()];
    // The name that the interface ranges or the descriptions give, when they give one
    const first = entries.map((entry) => (entry.groups.length > 0 ? usageName(entry.groups.join('_')) : nameFromDescriptions(entry)));
    const given = tellApart(
      first,
      entries.map((entry) => entry.usage),
    );
    // The others are named after their settings
    const unnamed = entries.filter((_, index) => given[index] === '');
    const fromSettings = namesFromSettings(unnamed.map((entry) => entry.usage));

    const used = new Set<string>();
    entries.forEach((entry, index) => {
      const wanted = given[index] || fromSettings[unnamed.indexOf(entry)] || 'profile';
      let name = wanted;
      // Two usages that would have the same name: the second one gets a number.
      for (let number = index + 1; used.has(name); number++) name = `${wanted.substring(0, MAX_NAME - 4)}-${number.toString(16).padStart(4, '0')}`;
      used.add(name);
      entry.name = name;
      entry.naming = namingOf(entry, given[index] !== '', given[index] !== first[index], name !== wanted);
      const subject = `port_usages.${name}`;

      if (entry.groups.length === 0 && given[index] !== '' && entry.descriptions.length > 1) {
        const listed = entry.descriptions.slice(0, MAX_DESCRIPTIONS_LISTED).join(',');
        const more = entry.descriptions.length > MAX_DESCRIPTIONS_LISTED ? ` and ${entry.descriptions.length - MAX_DESCRIPTIONS_LISTED} more` : '';
        report.warning('usage-name', `Port usage "${name}" is shared by ports with different descriptions and is named after the words they have in common: ${listed}${more}`, undefined, subject);
      }
      if (MIST_PORT_USAGES.includes(name)) {
        report.warning('usage-name-reserved', `Port usage "${name}" has the name of a port usage that Mist defines itself: check it, or rename it, before importing the template`, undefined, subject);
      }
    });
  }

  /** Why each port usage has its name, by name. Filled by `assignNames`. */
  namings(): Map<string, string> {
    return new Map([...this.entries.values()].map((entry) => [entry.name, entry.naming]));
  }

  /** The port usages by name. */
  byName(): Record<string, MistPortUsage> {
    return Object.fromEntries([...this.entries.values()].map((entry) => [entry.name, entry.usage]));
  }
}
