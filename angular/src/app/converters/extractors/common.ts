/**
 * What the extractors of every vendor do the same way once a file is read.
 */
import { Port, PortKind, StormControl } from '../model';
import { Report } from '../report';

/** Interfaces that are not switch ports, and how the report names them. */
export const NOT_A_SWITCH_PORT: Partial<Record<PortKind, string>> = {
  management: 'management port',
  loopback: 'loopback interface',
  internal: 'internal application port',
  other: 'not a switch port',
};

/** Every VLAN that the settings of a port refer to. */
export function referencedVlans(port: Port): number[] {
  const ids = [port.accessVlan, port.voiceVlan, port.nativeVlan, port.auth.guestVlan, port.auth.serverFailVlan, port.auth.serverRejectVlan].filter((id): id is number => id !== undefined);
  return port.allowedVlans === 'all' ? ids : [...ids, ...port.allowedVlans];
}

/**
 * Link aggregations get their settings from the aggregated interface (Port-channel1, ae0).
 * When a file has member ports and no aggregated interface, the aggregation is given
 * the settings of its first member, in the place of that member.
 */
export function addMissingLags(ports: Port[], aeIndexOf: (name: string) => number | undefined, report: Report): Port[] {
  const result: Port[] = [];
  const names = new Set(ports.filter((port) => port.kind === 'lag').map((port) => port.name));
  for (const port of ports) {
    if (port.lag && !names.has(port.lag.name)) {
      names.add(port.lag.name);
      result.push({
        ...structuredCloneOf(port),
        name: port.lag.name,
        kind: 'lag',
        junosName: undefined,
        lag: undefined,
        description: undefined,
        lacp: ports.some((member) => member.lag?.name === port.lag?.name && member.lag?.lacp),
        aeIndex: aeIndexOf(port.lag.name),
      });
      report.info('lag-without-interface', `${port.lag.name} is not configured in the file: the aggregation has the settings of its first member, ${port.name}`);
    }
    result.push(port);
  }
  return result;
}

function structuredCloneOf(port: Port): Port {
  return { ...port, auth: { ...port.auth }, allowedVlans: port.allowedVlans === 'all' ? 'all' : [...port.allowedVlans], groups: [...port.groups], lines: [...port.lines] };
}

/** The kinds of traffic that storm control limits. */
export type StormTraffic = 'broadcast' | 'multicast' | 'unicast';

/**
 * Storm control of a port, from the level of each kind of traffic: a number in percent, or
 * undefined for a level in bits or packets per second.
 *
 * The switches that are read have one level per kind of traffic. Mist has one level for the
 * port and says which kinds of traffic it applies to: the highest level is kept, so that
 * nothing that passed before is dropped.
 */
export function stormControlOf(storm: Map<StormTraffic, number | undefined>, shutdown: boolean, note: (code: string, text: string) => void): StormControl | undefined {
  const levels = [...storm.entries()].filter((entry): entry is [StormTraffic, number] => entry[1] !== undefined);
  if (levels.length < storm.size) note('storm-control-unit', 'Storm control with a level in bits or packets per second has no equivalent, Mist takes a percentage: left out');
  if (levels.length === 0) return undefined;
  const percentages = levels.map(([, level]) => Math.min(100, Math.max(Math.round(level), level > 0 ? 1 : 0)));
  if (new Set(percentages).size > 1) note('storm-control-levels', 'Storm control has one level per kind of traffic and Mist has one for the port: the highest one is kept');
  const limited = (traffic: StormTraffic): boolean => levels.some(([kind]) => kind === traffic);
  return {
    percentage: Math.max(...percentages),
    broadcast: limited('broadcast'),
    multicast: limited('multicast'),
    registeredMulticast: limited('multicast'),
    unknownUnicast: limited('unicast'),
    shutdown,
  };
}
