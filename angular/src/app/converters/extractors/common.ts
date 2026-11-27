/**
 * What the extractors of every vendor do the same way once a file is read.
 */
import { Port, PortKind } from '../model';
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
