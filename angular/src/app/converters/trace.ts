/**
 * What happened to each line of a file: converted, left out on purpose because Mist has
 * no use for it, or not converted.
 *
 * Rule tables tell the outcome of every statement they read (see `recordOutcomes` in
 * `extractors/rules.ts`). Extractors and the template builder can then overrule it for
 * lines whose result did not reach the template: the lines of a routed port were read by
 * rules, yet the port is left out.
 */
import { Outcome } from './extractors/rules';
import { numberedLines } from './readers/statement';

export type LineOutcome =
  | 'converted'
  | 'ignored' // read, and not needed in a Mist template
  | 'not-converted'
  | 'none'; // blank lines and comments

/** When several rules read a line, the best outcome wins: a rule that converts it beats one that does not know it. */
const RANK: Record<Outcome, number> = { unknown: 0, ignored: 1, converted: 2 };
const FROM_RULE: Record<Outcome, LineOutcome> = { unknown: 'not-converted', ignored: 'ignored', converted: 'converted' };

export class LineTrace {
  private readonly ruled = new Map<number, Outcome>();
  private readonly forced = new Map<number, LineOutcome>();

  /** The outcome of a rule table for the statement of a line. */
  rule(line: number, outcome: Outcome): void {
    const previous = this.ruled.get(line);
    if (previous === undefined || RANK[outcome] > RANK[previous]) this.ruled.set(line, outcome);
  }

  /** Overrules what the rules said: the last call wins. */
  force(lines: number[], outcome: LineOutcome): void {
    for (const line of lines) this.forced.set(line, outcome);
  }

  /**
   * The outcome of every line of the text, the first line at index 0. A line that no rule
   * read is not needed in the template (a prompt, the header of "show running-config"),
   * unless it is blank or a comment.
   */
  outcomes(text: string): LineOutcome[] {
    return numberedLines(text).map(({ text: content, line }) => {
      const forced = this.forced.get(line);
      if (forced !== undefined) return forced;
      const ruled = this.ruled.get(line);
      if (ruled !== undefined) return FROM_RULE[ruled];
      const trimmed = content.trim();
      return trimmed === '' || trimmed.startsWith('!') || trimmed.startsWith('#') ? 'none' : 'ignored';
    });
  }
}
