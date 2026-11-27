/**
 * Reader for what engineers save from a Cisco IOS terminal. A file can be:
 *
 *  - the output of one or more commands, each after its prompt:
 *        sw1#show vlan brief
 *        sw1#show running-config
 *  - a configuration alone, with or without its "Current configuration" header,
 *  - the commands typed in configuration mode, with or without their prompt:
 *        sw1(config)#interface GigabitEthernet1/0/1
 *        configure terminal
 *
 * The reader separates the lines of configuration from the rest and reads the
 * table of "show vlan". It does not interpret the configuration.
 *
 * A terminal of Aruba AOS-CX has the same prompts and the same "Current configuration"
 * header: its captures are read here too.
 */
import { NumberedLine, numberedLines } from './statement';

export interface VlanTableRow {
  id: number;
  name: string;
  line: number;
}

export interface IosCapture {
  /** The lines of configuration, in the order of the file, without prompts. */
  config: NumberedLine[];
  /** The rows of the table of "show vlan" or "show vlan brief". */
  vlanTable: VlanTableRow[];
  /** True when the file holds that table, even with no row. */
  hasVlanTable: boolean;
  /** The hostname that the prompts of the file show. */
  promptHostname?: string;
}

// "sw1#show vlan brief", "sw1>enable", "sw1(config-if)#shutdown"
const PROMPT = /^([A-Za-z0-9][\w.:/-]*)(?:\(([\w-]+)\))?[#>]\s*(.*)$/;
const VLAN_TABLE_HEADER = /^VLAN\s+Name\s+Status(\s+Ports)?$/i;
const VLAN_TABLE_RULE = /^-{2,}[\s-]*$/;
const VLAN_TABLE_ROW = /^(\d{1,4})\s+(\S+)\s+\S+/;
/** First lines of the output of "show running-config". */
const CONFIG_HEADER = /^(Building configuration|Current configuration|Using \d+ out of \d+ bytes)/;
/** Lines that some devices print between the command and the configuration. */
const NOISE = /^(Load for five secs|Time source is)/;
/** Left in a capture by the pager, with the characters that erase it from the screen. */
const PAGER = /^ ?--More-- ?(\x08+ +\x08+)?/;

/** True when `word` is `command` or an abbreviation of it of at least `min` letters. */
export function abbreviates(word: string | undefined, command: string, min: number): boolean {
  return word !== undefined && word.length >= min && command.startsWith(word.toLowerCase());
}

/** Commands of the exec mode whose output, or what follows, is configuration. */
function startsConfiguration(command: string): boolean {
  const words = command.trim().split(/\s+/);
  if (abbreviates(words[0], 'do', 2)) words.shift();
  if (abbreviates(words[0], 'show', 2)) {
    return abbreviates(words[1], 'running-config', 3) || abbreviates(words[1], 'startup-config', 3) || abbreviates(words[1], 'configuration', 4);
  }
  if (abbreviates(words[0], 'write', 2)) return abbreviates(words[1], 'terminal', 1);
  if (abbreviates(words[0], 'more', 3)) return /config/i.test(words[1] ?? '');
  if (abbreviates(words[0], 'configure', 4)) return words[1] === undefined || abbreviates(words[1], 'terminal', 1);
  return false;
}

interface Prompt {
  host: string;
  /** "config", "config-if"... for a prompt of the configuration mode. */
  mode?: string;
  command: string;
}

function readPrompt(text: string): Prompt | undefined {
  const match = PROMPT.exec(text);
  return match ? { host: match[1], mode: match[2], command: match[3] } : undefined;
}

/** Commands that people type at the prompt when they collect a configuration. */
const EXEC_COMMAND = /^(sh|sho|show|ter|term|terminal|en|enable|conf|config|configure|wr|write|more|exit|logout|do)\b/i;

/**
 * The hostname of the prompts of a capture. Every prompt of a capture shows the same
 * hostname, which tells a prompt from a line that only looks like one, such as a line
 * of a banner that ends with "#".
 */
function findPromptHost(lines: NumberedLine[]): string | undefined {
  let fallback: string | undefined;
  for (const line of lines) {
    const prompt = readPrompt(line.text);
    if (!prompt) continue;
    if (prompt.mode !== undefined || EXEC_COMMAND.test(prompt.command)) return prompt.host;
    if (prompt.command === '') fallback = fallback ?? prompt.host;
  }
  return fallback;
}

export function readIosCapture(text: string): IosCapture {
  const lines = numberedLines(text).map((line) => ({ ...line, text: line.text.replace(PAGER, '').replace(/\s+$/, '') }));
  const capture: IosCapture = { config: [], vlanTable: [], hasVlanTable: false, promptHostname: findPromptHost(lines) };
  const promptOf = (line: string): Prompt | undefined => {
    const prompt = readPrompt(line);
    return prompt && prompt.host === capture.promptHostname ? prompt : undefined;
  };

  // A file that never says where its configuration starts is a configuration from its first line.
  const saysWhereConfigurationStarts = lines.some(({ text: line }) => {
    const prompt = promptOf(line);
    if (prompt) return prompt.mode !== undefined || startsConfiguration(prompt.command);
    return CONFIG_HEADER.test(line) || startsConfiguration(line);
  });
  let inConfiguration = !saysWhereConfigurationStarts;
  let inVlanTable = false;

  for (const line of lines) {
    let content = line.text;

    if (inVlanTable) {
      if (VLAN_TABLE_RULE.test(content)) continue;
      const row = VLAN_TABLE_ROW.exec(content);
      if (row) {
        capture.vlanTable.push({ id: Number(row[1]), name: row[2], line: line.line });
        continue;
      }
      // The list of ports of a VLAN can continue on the next lines.
      if (/^\s+\S/.test(content)) continue;
      inVlanTable = false;
    }
    if (VLAN_TABLE_HEADER.test(content.trim())) {
      inVlanTable = true;
      capture.hasVlanTable = true;
      continue;
    }

    const prompt = promptOf(content);
    if (prompt) {
      if (prompt.mode === undefined) {
        inConfiguration = startsConfiguration(prompt.command);
        continue;
      }
      // A command typed in configuration mode.
      inConfiguration = true;
      content = prompt.command;
    } else if (CONFIG_HEADER.test(content) || startsConfiguration(content)) {
      inConfiguration = true;
      continue;
    }

    if (!inConfiguration || NOISE.test(content)) continue;
    if (content === 'end') {
      // "end" leaves the configuration mode. The separator closes the block that was open.
      inConfiguration = false;
      capture.config.push({ text: '!', line: line.line });
      continue;
    }
    capture.config.push({ text: content, line: line.line });
  }
  return capture;
}
