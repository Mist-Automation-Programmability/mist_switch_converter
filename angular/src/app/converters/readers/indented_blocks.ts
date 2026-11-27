/**
 * Reader for configurations written as indented blocks, the layout of Cisco IOS and
 * of the command lines modelled on it:
 *
 *     interface GigabitEthernet1/0/1
 *      description Printer
 *      switchport access vlan 30
 *     !
 *
 * A command belongs to the last command above it that is indented less. Blocks do
 * not need a "!" between them, and a "!" inside a block does not end it.
 */
import { NumberedLine, Statement } from './statement';

/** A banner that does not end within this many lines is taken for a one-line command. */
const MAX_BANNER_LINES = 200;

export function readIndentedBlocks(lines: NumberedLine[]): Statement[] {
  const root: Statement[] = [];
  let open: Array<{ indent: number; children: Statement[] }> = [{ indent: -1, children: root }];

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].text;
    const text = raw.trim();
    if (text === '') continue;
    const indent = raw.length - raw.trimStart().length;

    if (text.startsWith('!')) {
      // A comment. At the start of a line it also separates two blocks.
      if (indent === 0) {
        root.push({ words: [], text: '!', line: lines[index].line, children: [], separator: true });
        open = [open[0]];
      }
      continue;
    }

    while (open[open.length - 1].indent >= indent) open.pop();
    const statement: Statement = { words: text.split(/\s+/), text, line: lines[index].line, children: [] };
    open[open.length - 1].children.push(statement);
    open.push({ indent, children: statement.children });

    if (indent === 0 && statement.words[0] === 'banner' && statement.words.length >= 2) {
      index = readBanner(lines, index, statement);
    } else if (indent === 0 && statement.words[0] === 'macro' && statement.words[1] === 'name') {
      index = skipMacro(lines, index);
    }
  }
  return root;
}

/**
 * "banner motd ^C", then the text, then "^C". The delimiter is the first character
 * after the banner type, whatever it is; a running configuration prints the usual
 * one, Ctrl-C, as the two characters "^C". The text can start and end on the lines
 * of the delimiters. A capture can lose the delimiter of the first line: the text
 * then ends at the first Ctrl-C.
 * Returns the index of the last line of the banner.
 */
function readBanner(lines: NumberedLine[], start: number, statement: Statement): number {
  const afterType = lines[start].text.replace(/^\s*banner\s+\S+\s*/, '');
  const delimiters = afterType === '' ? ['^C', '\u0003'] : [afterType.startsWith('^C') ? '^C' : afterType.charAt(0)];
  const first = afterType === '' ? '' : afterType.slice(delimiters[0].length);
  const endOf = (text: string): number => Math.min(...delimiters.map((delimiter) => text.indexOf(delimiter)).map((position) => (position < 0 ? Infinity : position)));

  if (endOf(first) !== Infinity) {
    statement.body = first.slice(0, endOf(first));
    return start;
  }
  const body: string[] = first.trim() === '' ? [] : [first];
  for (let index = start + 1; index < lines.length && index <= start + MAX_BANNER_LINES; index++) {
    const end = endOf(lines[index].text);
    if (end !== Infinity) {
      const last = lines[index].text.slice(0, end);
      if (last !== '') body.push(last);
      statement.body = body.join('\n');
      return index;
    }
    body.push(lines[index].text);
  }
  // No closing delimiter: leave the following lines to be read as commands.
  return start;
}

/** "macro name <name>", then the commands of the macro, then "@". The commands are not configuration. */
function skipMacro(lines: NumberedLine[], start: number): number {
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].text.trim() === '@') return index;
  }
  return start;
}
