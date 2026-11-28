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
import { INVARIANTS } from './support/invariants';

/**
 * Rules that a fixture breaks today, with the known defect that explains it:
 *
 *     'cisco-ios/catalyst-2960-legacy': { [NAMES_ARE_VALID]: 'C5' },
 *
 * The ids are those of the defect list in the README next to these tests.
 * No defect is open at the moment.
 */
const KNOWN_VIOLATIONS: Record<string, Record<string, string>> = {};

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
