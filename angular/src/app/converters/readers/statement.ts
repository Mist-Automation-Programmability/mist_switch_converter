/**
 * What the readers produce: statements. A statement is one command of a
 * configuration, cut into words, with the commands that are nested under it.
 *
 * Readers know how a family of configuration languages is laid out (indented blocks,
 * "set" lines). They do not know what a command means: that is the job of the
 * extractors.
 */
export interface Statement {
  /** The words of the command. */
  words: string[];
  /** The command as written, without its indentation. */
  text: string;
  /** Line of the source file, starting at 1. */
  line: number;
  /** Commands nested under this one. */
  children: Statement[];
  /** Free text that belongs to the command, such as the text of a banner. */
  body?: string;
  /** True for a comment line ("!") that ends the block before it. It has no words. */
  separator?: boolean;
}

export interface NumberedLine {
  text: string;
  /** Line of the source file, starting at 1. */
  line: number;
}

/** The lines of a file with their numbers. Handles Unix and Windows line endings. */
export function numberedLines(text: string): NumberedLine[] {
  return text.split('\n').map((line, index) => ({ text: line.replace(/\r$/, ''), line: index + 1 }));
}

/** The text of a statement after its first `count` words, with the spacing of the source. */
export function textAfter(statement: Statement, count: number): string {
  let rest = statement.text;
  for (let index = 0; index < count; index++) rest = rest.replace(/^\S+\s*/, '');
  return rest.trim();
}

/** Every line of a statement and of the statements nested under it, indented as blocks. */
export function sourceLines(statement: Statement, depth = 0): string[] {
  return [' '.repeat(depth) + statement.text, ...statement.children.flatMap((child) => sourceLines(child, depth + 1))];
}

/** The line numbers of a statement and of the statements nested under it. */
export function sourceLineNumbers(statement: Statement): number[] {
  return [statement.line, ...statement.children.flatMap(sourceLineNumbers)];
}
