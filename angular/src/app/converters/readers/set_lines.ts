/**
 * Reader for Junos configurations in "display set" form: one statement per line,
 * each with its full path.
 *
 *     set interfaces ge-0/0/1 description "Reception desk"
 *     set vlans USERS vlan-id 10
 *
 * The reader cuts the lines into words, drops what Junos itself would not apply
 * (deactivated statements) and brings in the statements of the configuration groups
 * that are applied to the whole configuration. It does not interpret the statements.
 */
import { numberedLines, Statement } from './statement';

/** Words of a line. A quoted string is one word, without its quotes. */
export function splitQuotedWords(text: string): string[] {
  const words: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    words.push(match[1] !== undefined ? match[1].replace(/\\"/g, '"') : match[2]);
  }
  return words;
}

function startsWith(words: string[], path: string[]): boolean {
  return path.every((word, index) => words[index] === word);
}

/**
 * The active statements of a file, without the word "set", in the order of the file.
 * The statements of applied groups come first, so that the statements of the
 * configuration itself, which Junos prefers, are read after them.
 */
export function readSetLines(text: string): Statement[] {
  const statements: Statement[] = [];
  const deactivated: string[][] = [];
  for (const line of numberedLines(text)) {
    const content = line.text.trim();
    if (content.startsWith('set ')) {
      const words = splitQuotedWords(content).slice(1);
      if (words.length > 0) statements.push({ words, text: content, line: line.line, children: [] });
    } else if (content.startsWith('deactivate ')) {
      deactivated.push(splitQuotedWords(content).slice(1));
    }
  }
  const active = statements.filter((statement) => !deactivated.some((path) => startsWith(statement.words, path)));

  // "set groups <name> ..." holds statements that "set apply-groups <name>" adds to the configuration.
  // A group that nothing applies has no effect and is dropped. A statement with a wildcard
  // ("<ge-*>") stays as it is: the extractor reports it as not converted.
  const applied = active.filter((statement) => statement.words[0] === 'apply-groups').flatMap((statement) => statement.words.slice(1));
  const inherited: Statement[] = [];
  const own: Statement[] = [];
  for (const statement of active) {
    if (statement.words[0] === 'apply-groups') continue;
    if (statement.words[0] !== 'groups') own.push(statement);
    else if (!applied.includes(statement.words[1])) continue;
    else if (statement.words.some((word) => word.includes('<'))) own.push(statement);
    else inherited.push({ ...statement, words: statement.words.slice(2) });
  }
  return [...inherited, ...own];
}
