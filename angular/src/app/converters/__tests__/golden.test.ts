/**
 * Golden files: every fixture in `__fixtures__` is converted and the whole result is
 * compared with the `expected.json` stored next to it.
 *
 * `expected.json` records what the converter does TODAY, known defects included. It
 * is there to show the full effect of a change: after a change, run
 * `npm test -- -u` and review the differences in `expected.json` like any other code.
 */
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { loadFixtures } from './support/fixtures';
import { goldenOf, goldenText } from './support/golden';
import { convert } from './support/harness';

describe('Golden files', () => {
  const fixtures = loadFixtures();

  it('finds the fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} converts to its expected.json`, async () => {
      const result = await convert(...fixture.inputs);

      await expect(goldenText(goldenOf(result))).toMatchFileSnapshot(join(fixture.dir, 'expected.json'));
    });
  }
});
