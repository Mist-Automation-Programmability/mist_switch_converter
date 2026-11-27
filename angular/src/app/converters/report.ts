/**
 * What the converter tells the user: the diagnostics of a conversion.
 *
 * Messages that would repeat for every port or every line are collected and written
 * once, with the number of ports and the line numbers. The text of a command never
 * goes into a message: only its first keywords do (see `commandKey`), because the
 * rest can hold a secret.
 */
import { Diagnostic, Severity } from './model';

interface Collected {
  severity: Severity;
  code: string;
  text: string;
  lines: number[];
  ports: string[];
}

/** At most this many line numbers are listed in a message. */
const MAX_LINES_LISTED = 8;

export class Report {
  private collected = new Map<string, Collected>();

  constructor(
    /** Name of the source file the messages are about, or '' for the whole conversion. */
    readonly file: string = '',
    readonly diagnostics: Diagnostic[] = [],
  ) {}

  /** A report for one file that writes to the same list of diagnostics. */
  forFile(file: string): Report {
    return new Report(file, this.diagnostics);
  }

  info(code: string, message: string, lines?: number[]): void {
    this.add('info', code, message, lines);
  }

  warning(code: string, message: string, lines?: number[]): void {
    this.add('warning', code, message, lines);
  }

  error(code: string, message: string, lines?: number[]): void {
    this.add('error', code, message, lines);
  }

  /** A command of the device that the converter read and has no rule for. Reported once per command by `flush`. */
  notConverted(command: string, line: number): void {
    this.collect('info', 'not-converted', `Not converted: "${command}"`, line);
  }

  /** A setting of a port that the converter read and has no rule for. Reported once per setting by `flush`. */
  portSettingNotConverted(command: string, line: number, port: string): void {
    this.collect('warning', 'port-setting-not-converted', `Not converted: "${command}"`, line, port);
  }

  /** Something to say about a port that is likely to be true of many ports. Reported once per text by `flush`. */
  portNote(severity: Severity, code: string, text: string, line: number, port: string): void {
    this.collect(severity, code, text, line, port);
  }

  /** Writes what was collected: one message per text, with the ports and the lines it is about. */
  flush(): void {
    for (const entry of this.collected.values()) {
      let where = '';
      if (entry.ports.length === 1) where = ` on ${entry.ports[0]}`;
      else if (entry.ports.length > 1) where = ` on ${entry.ports.length} ports, the first is ${entry.ports[0]}`;
      this.add(entry.severity, entry.code, `${entry.text}${where} (${listLines(entry.lines)})`, entry.lines);
    }
    this.collected.clear();
  }

  private collect(severity: Severity, code: string, text: string, line: number, port?: string): void {
    const key = `${severity} ${code} ${text}`;
    const entry = this.collected.get(key) ?? { severity, code, text, lines: [], ports: [] };
    if (!entry.lines.includes(line)) entry.lines.push(line);
    if (port !== undefined && !entry.ports.includes(port)) entry.ports.push(port);
    this.collected.set(key, entry);
  }

  private add(severity: Severity, code: string, message: string, lines?: number[]): void {
    this.diagnostics.push({ severity, code, message, file: this.file, ...(lines && lines.length > 0 ? { lines } : {}) });
  }
}

function listLines(lines: number[]): string {
  const shown = lines.slice(0, MAX_LINES_LISTED).join(', ');
  const more = lines.length > MAX_LINES_LISTED ? ` and ${lines.length - MAX_LINES_LISTED} more` : '';
  return `${lines.length === 1 ? 'line' : 'lines'} ${shown}${more}`;
}

/**
 * The part of a command that is safe to show: its first keyword, and the second one
 * after a keyword that is always followed by another keyword. What comes after can be
 * a name, an address or a secret.
 */
export function commandKey(words: string[], twoWordKeywords: ReadonlySet<string>): string {
  const first = (words[0] ?? '').toLowerCase();
  if (first === 'no' && words.length > 1) return `no ${commandKey(words.slice(1), twoWordKeywords)}`;
  // A line of free text, such as a title or a stray line of a banner, is not shown.
  if (!KEYWORD.test(first)) return NOT_A_COMMAND;
  if (twoWordKeywords.has(first) && words.length > 1 && KEYWORD.test(words[1])) return `${first} ${words[1].toLowerCase()}`;
  return first;
}

const KEYWORD = /^[a-z][a-z0-9-]*$/i;
export const NOT_A_COMMAND = 'text that is not a command';
