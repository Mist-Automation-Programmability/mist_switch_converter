/**
 * Where the notifications of SNMP go, said the way Junos and a Mist template say it.
 * The vendors that name a station on one line ("snmp-server host ...") share this.
 */
import { addOnce, named, Snmp, SnmpSecurityLevel, SnmpTargetParameters, SnmpTrapGroup } from '../model';

/** The trap group of versions 1 and 2c that sends to a station. There is one group per version. */
export function trapGroupFor(snmp: Snmp, version: 'v1' | 'v2', address: string): SnmpTrapGroup {
  const name = version === 'v1' ? 'traps_v1' : 'traps_v2';
  const group = named<SnmpTrapGroup>(snmp.trapGroups, name, () => ({ name, version, targets: [], categories: [] }));
  addOnce(group.targets, address);
  return group;
}

/**
 * A station that receives the notifications of version 3 in the name of a user: the
 * parameters say how the notifications are sent to the station.
 */
export function addV3Target(snmp: Snmp, station: { address: string; type: 'trap' | 'inform'; user: string; level: SnmpSecurityLevel; port?: number }): void {
  const tag = station.type === 'inform' ? 'informs' : 'traps';
  const parameters = `${tag}_${station.user}`;
  named(snmp.notifies, tag, () => ({ name: tag, tag, type: station.type }));
  named<SnmpTargetParameters>(snmp.targetParameters, parameters, () => ({ name: parameters, processing: 'v3', model: 'usm', level: station.level, securityName: station.user }));
  const target = named(snmp.targets, `target_${station.address}`, () => ({ name: `target_${station.address}`, address: station.address, tags: [], parameters }));
  addOnce(target.tags, tag);
  if (station.port !== undefined) target.port = station.port;
}

/** Said once when a station of versions 1 and 2c listens on another port than 162. */
export const TRAP_PORT_WARNING = 'SNMP: a trap group has no port, the traps of versions 1 and 2c go to port 162';
