/**
 * Local test on real configurations.
 *
 * It converts the files of `test_configs/`, a folder at the root of the repository
 * that git ignores, and compares each result with the one recorded on the previous
 * run. Use it to see what a change to the converter does to real configurations:
 *
 *   npm run test:local          compare with the recorded results
 *   npm run test:local -- -u    accept the new results
 *
 * The folder does not exist on GitHub, so the test is skipped there. Nothing it
 * reads or writes leaves `test_configs/`: see `support/local-configs.ts`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { goldenOf, goldenText } from './support/golden';
import { convert } from './support/harness';
import { brokenRules, CaseSummary, loadLocalCases, LocalGolden, readRecorded, summarize, writeSummary } from './support/local-configs';

describe('Local configurations (test_configs)', () => {
  const cases = loadLocalCases();

  if (cases.length === 0) {
    it.skip('has nothing to convert: test_configs does not exist or is empty', () => undefined);
    return;
  }

  const summaries: CaseSummary[] = [];
  afterAll(() => writeSummary(summaries));

  cases.forEach((localCase, index) => {
    it(`${localCase.name} converts to its recorded result`, async () => {
      const result = await convert(...localCase.inputs);
      const golden: LocalGolden = { ...goldenOf(result), broken_rules: brokenRules(localCase.inputs, result) };
      summaries.push(summarize(index, localCase, result, golden, readRecorded(localCase)));

      await expect(goldenText(golden)).toMatchFileSnapshot(localCase.resultFile);
    });
  });
});
