/**
 * Invariants: rules that every exported template must respect, whatever the input.
 * They are checked on the conversion of every fixture in `__fixtures__`, so a new
 * fixture is covered as soon as it is added.
 *
 * A rule that a fixture breaks today because of a known defect is listed in
 * KNOWN_VIOLATIONS with the id of that defect. Remove the entry when the defect is
 * fixed: the test then fails until you do, on purpose.
 */
import { describe, expect, it } from 'vitest';
import { loadFixtures } from './support/fixtures';
import { convert, knownDefect } from './support/harness';
import {
  ACCESS_HAS_NETWORK,
  INVARIANTS,
  MODE_IS_KNOWN,
  NAMES_ARE_VALID,
  NETWORKS_EXIST,
  ONE_RADIUS_PORT,
  PORT_NAMES_ARE_VALID,
  SERVERS_ARE_COMPLETE,
  VLAN_IDS_ARE_VALID,
} from './support/invariants';

/**
 * Rules that a fixture breaks today, with the known defect that explains it.
 * The ids are those of the defect list in the README next to these tests.
 */
const KNOWN_VIOLATIONS: Record<string, Record<string, string>> = {
  'cisco-ios/catalyst-2960-legacy': {
    [NAMES_ARE_VALID]: 'C5',
    [MODE_IS_KNOWN]: 'A8',
  },
  'cisco-ios/catalyst-9300-access': {
    [PORT_NAMES_ARE_VALID]: 'A7',
    [VLAN_IDS_ARE_VALID]: 'A2',
    [NAMES_ARE_VALID]: 'A2, C5',
    [ONE_RADIUS_PORT]: 'C1',
  },
  'junos/ex2200-legacy': {
    [ACCESS_HAS_NETWORK]: 'B12, B14',
  },
  'junos/ex4300-els': {
    [NETWORKS_EXIST]: 'B7',
    [PORT_NAMES_ARE_VALID]: 'B8',
    [NAMES_ARE_VALID]: 'C5',
    [ACCESS_HAS_NETWORK]: 'B2, B8, C8',
    [SERVERS_ARE_COMPLETE]: 'B5',
    [ONE_RADIUS_PORT]: 'B4, C1',
  },
  'multi/cisco-and-junos': {
    [ONE_RADIUS_PORT]: 'C1',
  },
  'multi/two-junos-vlan-clash': {
    [NETWORKS_EXIST]: 'C3',
  },
};

describe('Invariants', () => {
  for (const fixture of loadFixtures()) {
    describe(fixture.name, () => {
      for (const [rule, check] of Object.entries(INVARIANTS)) {
        const body = async (): Promise<void> => {
          expect(check(await convert(...fixture.inputs))).toEqual([]);
        };
        const defect = KNOWN_VIOLATIONS[fixture.name]?.[rule];
        if (defect) knownDefect(defect, rule, body);
        else it(rule, body);
      }

      it('converting the same files twice gives the same result', async () => {
        const first = await convert(...fixture.inputs);
        const second = await convert(...fixture.inputs);

        expect(second.template).toEqual(first.template);
        expect(second.ports).toEqual(first.ports);
      });
    });
  }
});
