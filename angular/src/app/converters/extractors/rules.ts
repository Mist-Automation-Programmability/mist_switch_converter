/**
 * Command rules: the way an extractor says what it does with each command.
 *
 *     rule('switchport access vlan <id>', (port, m) => { port.accessVlan = Number(m.id); }),
 *     ignore('negotiation auto', 'no ip address'),
 *
 * A pattern is written like the command:
 *     word        that word
 *     <name>      any one word, given to the handler as m.name
 *     <name...>   one or more words up to the end of the command, joined by a space
 *     ...         anything, or nothing, up to the end of the command (m.rest)
 *
 * A command that no rule accepts is not dropped: `RuleTable.apply` returns 'unknown'
 * and the extractor reports it. `ignore` is for commands that are known and that have
 * no place in a Mist template.
 */
import { Statement } from '../readers/statement';

export type Captures = Record<string, string>;

/** The names that a pattern captures: 'id' for "<id>", 'text' for "<text...>". */
type CaptureName<P extends string> = P extends `${string}<${infer Name}>${infer After}` ? (Name extends `${infer Many}...` ? Many : Name) | CaptureName<After> : never;
type RestName<P extends string> = P extends `${string} ...` | '...' ? 'rest' : never;
/** What a handler receives for a pattern: one property per capture, so that `m.id` is checked by the compiler. */
export type CapturesOf<P extends string> = { [Name in CaptureName<P> | RestName<P>]: string };

/**
 * Returns false when the command turns out not to be what the rule reads, before
 * changing anything. The next rule that matches the command is then tried.
 */
export type Handler<T, M = Captures> = (target: T, m: M, statement: Statement) => void | false;

type Segment = { kind: 'word'; value: string } | { kind: 'one'; name: string } | { kind: 'many'; name: string } | { kind: 'rest' };

export interface Rule<T> {
  pattern: string;
  segments: Segment[];
  /** Absent for a command that is ignored on purpose. */
  handler?: Handler<T>;
}

function parsePattern(pattern: string): Segment[] {
  const segments = pattern
    .trim()
    .split(/\s+/)
    .map((part): Segment => {
      if (part === '...') return { kind: 'rest' };
      const many = /^<(\w+)\.\.\.>$/.exec(part);
      if (many) return { kind: 'many', name: many[1] };
      const one = /^<(\w+)>$/.exec(part);
      if (one) return { kind: 'one', name: one[1] };
      return { kind: 'word', value: part };
    });
  const open = segments.findIndex((segment) => segment.kind === 'rest' || segment.kind === 'many');
  if (open >= 0 && open !== segments.length - 1) throw new Error(`Pattern "${pattern}": "..." can only end a pattern`);
  return segments;
}

export function rule<T, P extends string = string>(pattern: P, handler: Handler<T, CapturesOf<P>>): Rule<T> {
  return { pattern, segments: parsePattern(pattern), handler: handler as Handler<T> };
}

/** Commands that are read and left out on purpose. */
export function ignore<T>(...patterns: string[]): Array<Rule<T>> {
  return patterns.map((pattern) => ({ pattern, segments: parsePattern(pattern) }));
}

export interface RuleOptions<T> {
  /** Keywords are compared without regard to case. */
  ignoreCase?: boolean;
  /** A keyword can be shortened to its first letters, two at least, as on a Cisco command line ("sw mode acc"). */
  abbreviations?: boolean;
  /** Rules for whole families of commands ("no ..."), tried when no other rule accepts a command. */
  otherwise?: Array<Rule<T> | Array<Rule<T>>>;
}

export type Outcome = 'converted' | 'ignored' | 'unknown';

export class RuleTable<T> {
  private readonly rules: Array<Rule<T>>;
  private readonly otherwise: Array<Rule<T>>;

  constructor(
    rules: Array<Rule<T> | Array<Rule<T>>>,
    private readonly options: RuleOptions<T> = {},
  ) {
    this.rules = rules.flat();
    this.otherwise = (options.otherwise ?? []).flat();
  }

  /** True when a rule of the table is written for these words. */
  matches(words: string[]): boolean {
    return !this.candidates(words).next().done;
  }

  /** Runs the first rule that accepts the statement on `target`. */
  apply(target: T, statement: Statement): Outcome {
    for (const { rule: candidate, captures } of this.candidates(statement.words)) {
      if (!candidate.handler) return 'ignored';
      if (candidate.handler(target, captures, statement) !== false) return 'converted';
    }
    return 'unknown';
  }

  /** The rules that match the words: full keywords first, then abbreviations, then the "otherwise" rules. */
  private *candidates(words: string[]): Generator<{ rule: Rule<T>; captures: Captures }> {
    const passes: Array<[Array<Rule<T>>, boolean]> = [[this.rules, false]];
    if (this.options.abbreviations) passes.push([this.rules, true]);
    passes.push([this.otherwise, false]);
    if (this.options.abbreviations) passes.push([this.otherwise, true]);
    const seen = new Set<Rule<T>>();
    for (const [rules, abbreviated] of passes) {
      for (const candidate of rules) {
        if (seen.has(candidate)) continue;
        const captures = this.match(candidate, words, abbreviated);
        if (!captures) continue;
        seen.add(candidate);
        yield { rule: candidate, captures };
      }
    }
  }

  private match(candidate: Rule<T>, words: string[], abbreviated: boolean): Captures | undefined {
    const captures: Captures = {};
    for (let index = 0; index < candidate.segments.length; index++) {
      const segment = candidate.segments[index];
      if (segment.kind === 'rest') {
        captures['rest'] = words.slice(index).join(' ');
        return captures;
      }
      if (index >= words.length) return undefined;
      if (segment.kind === 'many') {
        captures[segment.name] = words.slice(index).join(' ');
        return captures;
      }
      if (segment.kind === 'one') captures[segment.name] = words[index];
      else if (!this.sameWord(segment.value, words[index], abbreviated)) return undefined;
    }
    return words.length === candidate.segments.length ? captures : undefined;
  }

  private sameWord(keyword: string, word: string, abbreviated: boolean): boolean {
    const expected = this.options.ignoreCase ? keyword.toLowerCase() : keyword;
    const actual = this.options.ignoreCase ? word.toLowerCase() : word;
    if (expected === actual) return true;
    return abbreviated && actual.length >= 2 && expected.startsWith(actual);
  }
}
