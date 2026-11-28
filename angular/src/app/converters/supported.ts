/**
 * The commands that the converter reads, per platform, as its rule tables write them.
 * The help page lists them, so that the list is always the one the converter applies.
 */
import { ARUBA_CX_RULES } from './extractors/aruba_cx';
import { CISCO_IOS_RULES } from './extractors/cisco_ios';
import { JUNOS_RULES } from './extractors/junos';

export interface SupportedPlace {
  /** Where the commands are written: "interface", "Global commands", "snmp-server". */
  place: string;
  /** The commands that are converted, as patterns: "switchport access vlan <id>". */
  converted: string[];
  /** How many more commands are read and left out on purpose, because a Mist template has no use for them. */
  ignored: number;
}

export interface SupportedPlatform {
  name: string;
  places: SupportedPlace[];
}

function placesOf(tables: ReadonlyArray<{ place: string; table: { patterns(): Array<{ pattern: string; converted: boolean }> } }>): SupportedPlace[] {
  return tables.map(({ place, table }) => {
    const patterns = table.patterns();
    return { place, converted: [...new Set(patterns.filter((entry) => entry.converted).map((entry) => entry.pattern))], ignored: patterns.filter((entry) => !entry.converted).length };
  });
}

export function supportedCommands(): SupportedPlatform[] {
  return [
    { name: 'Cisco IOS and IOS-XE', places: placesOf(CISCO_IOS_RULES) },
    { name: 'Juniper Junos', places: placesOf(JUNOS_RULES) },
    { name: 'Aruba AOS-CX', places: placesOf(ARUBA_CX_RULES) },
  ];
}
