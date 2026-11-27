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
import { convert } from './support/harness';

describe('Golden files', () => {
  const fixtures = loadFixtures();

  it('finds the fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} converts to its expected.json`, async () => {
      const result = await convert(...fixture.inputs);

      const golden = {
        files: result.files,
        // One line per interface of the sources: "<hostname> <interface> = <port usage>".
        ports: result.ports.map((port) => `${port.hostname} ${port.source} = ${port.usage}`),
        // What the user is told went wrong or needs attention.
        problems: result.logs.filter((entry) => entry.level !== 'info' && entry.level !== 'debug').map((entry) => `${entry.level}: ${entry.message}`),
        errors: result.errors.map((error) => String(error)),
        template: result.template,
      };

      await expect(JSON.stringify(golden, null, 2) + '\n').toMatchFileSnapshot(join(fixture.dir, 'expected.json'));
    });
  }
});
