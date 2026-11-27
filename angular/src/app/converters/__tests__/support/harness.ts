/**
 * Test harness for the converter.
 *
 * `convert()` feeds configuration text to the converter the same way the app does
 * (see `AppComponent.readfile` and `AppComponent.processFiles`) and returns what a
 * user would get: the exported Mist template, the per-file status and the log.
 *
 * Tests should assert on that result and not on the internals of the parsers, so
 * that they keep their value when the parsers are reworked. When the converter gets
 * a single entry point, only this file has to change.
 */
import { expect, it } from 'vitest';
import { ConfigParser, ConfigFile } from '../../parser_main';
import type { MistTemplateElement, ProfileConfigurationElement, SwitchMatchingRuleElement, SwitchMatchingRulePortConfigElement } from '../../mist_template';
import type { Logger } from '../../../services/logger';
import { resetUuid } from './deterministic-uuid';

/* ------------------------------------------------------------------ types */

export interface InputFile {
  name: string;
  text: string;
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  file: string;
  message: string;
}

/** Status of one input file, as shown in the file list of the app. */
export interface FileResult {
  name: string;
  format: string;
  success_vlan: boolean | undefined;
  success_config: boolean | undefined;
  error_message: string;
}

/** One interface found in an input file and the port usage (profile) it was given. */
export interface SourcePort {
  file: string;
  hostname: string;
  /** Interface name as written in the source configuration. */
  source: string;
  /** Name of the port usage in `template.port_usages`. */
  usage: string;
  description: string;
}

/** A port usage as exported: fields that are `undefined` in the converter are absent. */
export type PortUsage = Partial<ProfileConfigurationElement>;
export type PortConfig = Partial<SwitchMatchingRulePortConfigElement>;
export type SwitchRule = SwitchMatchingRuleElement & Record<string, unknown>;

export interface Conversion {
  /** The Mist template exactly as the app exports it (JSON round trip included). */
  template: MistTemplateElement;
  files: FileResult[];
  ports: SourcePort[];
  logs: LogEntry[];
  /**
   * Exceptions raised inside the converter. In the app these are invisible: the
   * conversion silently skips the rest of the step that failed, or never finishes.
   */
  errors: unknown[];
}

/* ---------------------------------------------------------------- convert */

class RecordingLogger {
  readonly entries: LogEntry[] = [];
  debug(message: string, file = ''): void { this.entries.push({ level: 'debug', file, message }); }
  info(message: string, file = ''): void { this.entries.push({ level: 'info', file, message }); }
  warning(message: string, file = ''): void { this.entries.push({ level: 'warning', file, message }); }
  error(message: string, file = ''): void { this.entries.push({ level: 'error', file, message }); }
  critical(message: string, file = ''): void { this.entries.push({ level: 'critical', file, message }); }
  getall(): LogEntry[] { return this.entries; }
}

/** Same object as the one built by `AppComponent.readfile`. */
function toConfigFile(input: string | InputFile, index: number): ConfigFile {
  const file: InputFile = typeof input === 'string' ? { name: `file${index + 1}.txt`, text: input } : input;
  return {
    name: file.name,
    config: file.text.split('\n'),
    format: 'Unknown',
    success_vlan: undefined,
    success_config: undefined,
    error_message: 'Unknown error',
  };
}

/**
 * Runs `run` and returns the promise rejections nobody handled while it ran.
 * Some parser steps are `async` functions that are called without `await`; when they
 * throw, the error only shows up as an unhandled rejection.
 */
async function collectUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const errors: unknown[] = [];
  const record = (reason: unknown): void => { errors.push(reason); };
  const previous = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', record);
  try {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
    // Node reports unhandled rejections once the current turn of the event loop is over.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', record);
    for (const listener of previous) process.on('unhandledRejection', listener);
  }
  return errors;
}

/**
 * Converts one or more configuration files into a Mist template.
 * A string is turned into a file named `file1.txt`, `file2.txt`, ...
 */
export async function convert(...inputs: Array<string | InputFile>): Promise<Conversion> {
  resetUuid();
  const logger = new RecordingLogger();
  const parser = new ConfigParser(logger as unknown as Logger);
  const files = inputs.map(toConfigFile);

  // Same sequence as AppComponent.processFiles(): all files go through one step
  // before the next step starts.
  const errors = await collectUnhandledRejections(async () => {
    for (const file of files) await parser.detect_source(file);
    for (const file of files) {
      const success = await parser.read_vlans(file);
      if (!success && file.format == 'Cisco') file.error_message = 'Unable to parse the VLAN database';
      else if (!success) file.error_message = 'Unable to retrieve the VLAN list';
    }
    for (const file of files) {
      const success = await parser.read_config(file);
      if (!success && file.error_message == 'Unknown error') file.error_message = 'Unable to parse the configuration';
      file.success_config = success;
    }
    parser.generate();
  });

  return {
    // The app downloads JSON.stringify(mist_template); do the same so tests see the real export.
    template: JSON.parse(JSON.stringify(parser.config_data.mist_template)) as MistTemplateElement,
    files: files.map((file) => ({
      name: file.name,
      format: file.format,
      success_vlan: file.success_vlan,
      success_config: file.success_config,
      error_message: file.error_message,
    })),
    ports: parser.config_data.interfaces.map((port) => ({
      file: port.file,
      hostname: port.hostname,
      source: port.interface_name,
      usage: port.profile_name,
      description: port.description,
    })),
    logs: [...logger.entries],
    errors,
  };
}

/* ---------------------------------------------------------- input helpers */

/** Removes the indentation that a template literal picks up from the test source. */
export function dedent(text: string): string {
  const lines = text.replace(/^\n/, '').replace(/\n[ \t]*$/, '').split('\n');
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => line.match(/^ */)![0].length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(indent)).join('\n');
}

export interface IosOptions {
  /** `null` leaves the `hostname` command out. Default: `sw1`. */
  hostname?: string | null;
  /** VLAN id and name, printed as a `show vlan brief` table before the running configuration. */
  vlans?: Record<number, string>;
}

/**
 * Builds a Cisco IOS capture the way engineers usually collect it: an optional
 * `show vlan brief` followed by `show running-config`. `body` is the part of the
 * running configuration under test; write it as in a real configuration, with
 * sub-commands indented by one space and blocks separated by `!`.
 */
export function ios(body: string, options: IosOptions = {}): string {
  const hostname = options.hostname === undefined ? 'sw1' : options.hostname;
  const prompt = `${hostname ?? 'Switch'}#`;
  const lines: string[] = [];
  if (options.vlans) {
    lines.push(
      `${prompt}show vlan brief`,
      '',
      'VLAN Name                             Status    Ports',
      '---- -------------------------------- --------- -------------------------------',
    );
    for (const [id, name] of Object.entries(options.vlans)) lines.push(`${id.padEnd(4)} ${name.padEnd(32)} active`);
    lines.push(
      '1002 fddi-default                     act/unsup',
      '1003 token-ring-default               act/unsup',
      '1004 fddinet-default                  act/unsup',
      '1005 trnet-default                    act/unsup',
      '',
    );
  }
  lines.push(`${prompt}show running-config`, 'Building configuration...', '', 'Current configuration : 4096 bytes', '!', 'version 17.9', '!');
  if (hostname) lines.push(`hostname ${hostname}`, '!');
  lines.push(...dedent(body).split('\n'), '!', 'end', '');
  return lines.join('\n');
}

/**
 * Junos `display set` output: one statement per line, without indentation.
 * Indentation and empty lines of the template literal are removed.
 */
export function junos(body: string): string {
  return body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n') + '\n';
}

/* --------------------------------------------------------- result helpers */

function describePorts(conversion: Conversion): string {
  return conversion.ports.map((port) => `${port.hostname || port.file}:${port.source}`).join(', ') || '(none)';
}

/**
 * The port usage given to an interface of the source configuration, for example
 * `usageFor(result, 'GigabitEthernet1/0/1')` or `usageFor(result, 'ge-0/0/1')`.
 * `owner` (a hostname or a file name) is only needed when several files are converted.
 */
export function usageFor(conversion: Conversion, sourceInterface: string, owner?: string): PortUsage {
  const port = conversion.ports.find(
    (candidate) => candidate.source === sourceInterface && (owner === undefined || candidate.hostname === owner || candidate.file === owner),
  );
  expect(port, `interface ${sourceInterface} was not converted. Converted interfaces: ${describePorts(conversion)}`).toBeDefined();
  const usage = conversion.template.port_usages[port!.usage];
  expect(usage, `port usage "${port!.usage}" of ${sourceInterface} is missing from the template`).toBeDefined();
  return usage as PortUsage;
}

/** The switch rule of a device. `hostname` is only needed when the template has several rules. */
export function switchRule(conversion: Conversion, hostname?: string): SwitchRule {
  const rules = conversion.template.switch_matching.rules as SwitchRule[];
  const rule = hostname === undefined ? rules[0] : rules.find((candidate) => candidate.name === hostname);
  expect(rule, `no switch rule${hostname === undefined ? '' : ` named "${hostname}"`}. Rules: ${rules.map((r) => `"${r.name}"`).join(', ') || '(none)'}`).toBeDefined();
  if (hostname === undefined) expect(rules, 'several switch rules: pass the hostname').toHaveLength(1);
  return rule as SwitchRule;
}

/**
 * The entry of a switch rule that configures a given port, looked up by its Junos
 * name as used by Mist (`ge-0/0/0`). Link aggregations are stored under the list
 * of their member ports, so the key can name several ports.
 * Returns `undefined` when the rule does not configure the port.
 */
export function portConfig(conversion: Conversion, mistPort: string, hostname?: string): (PortConfig & { key: string }) | undefined {
  const rule = switchRule(conversion, hostname);
  for (const [key, config] of Object.entries(rule.port_config)) {
    if (key.split(',').includes(mistPort)) return { key, ...config };
  }
  return undefined;
}

/** Every port name configured by a switch rule, link aggregation members included, in alphabetical order. */
export function configuredPorts(conversion: Conversion, hostname?: string): string[] {
  return Object.keys(switchRule(conversion, hostname).port_config).flatMap((key) => key.split(',')).sort();
}

/** The networks of the template as `{ name: vlan id }`, with the id as a number. */
export function vlanIds(conversion: Conversion): Record<string, number> {
  return Object.fromEntries(Object.entries(conversion.template.networks).map(([name, network]) => [name, Number(network.vlan_id)]));
}

/** A list of servers as `host:port` strings, whatever the type used for the port. */
export function endpoints(servers: object[]): string[] {
  return (servers as Array<{ host: string; port: string | number }>).map((server) => `${server.host}:${server.port}`);
}

/**
 * Networks that a port usage or the DHCP snooping list refers to but that the
 * template does not define. Mist rejects a template with such references.
 */
export function missingNetworks(conversion: Conversion): string[] {
  const defined = new Set(Object.keys(conversion.template.networks));
  const missing = new Set<string>();
  const check = (name: string | undefined): void => {
    if (name !== undefined && !defined.has(name)) missing.add(name);
  };
  for (const usage of Object.values(conversion.template.port_usages) as PortUsage[]) {
    check(usage.port_network);
    check(usage.voip_network);
    check(usage.guest_network);
    check(usage.rejected_network);
    (usage.networks ?? []).forEach(check);
  }
  conversion.template.dhcp_snooping.networks.forEach(check);
  return [...missing].sort();
}

export function logsOf(conversion: Conversion, ...levels: Array<LogEntry['level']>): string[] {
  return conversion.logs.filter((entry) => levels.includes(entry.level)).map((entry) => entry.message);
}

/* ----------------------------------------------------------- known defects */

const showDefects = Boolean(process.env['SHOW_DEFECTS']);

function isFailedExpectation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AssertionError';
}

/**
 * A test for a defect that is known and not fixed yet.
 *
 * The body describes the CORRECT behaviour, so today it fails. The test is reported
 * as passed as long as it fails on an expectation, which keeps the suite green while
 * the defect is documented. It turns red when:
 *   - the defect is fixed: replace `knownDefect(id, ...)` by `it(...)` to keep the test,
 *   - the body crashes instead of failing an expectation: the test itself is broken.
 *
 * `id` refers to the defect list in the README next to these tests.
 * Run `npm run test:defects` to see every known defect fail with its real message.
 */
export function knownDefect(id: string, title: string, body: () => Promise<void> | void): void {
  const name = `${id} (known defect): ${title}`;
  if (showDefects) {
    it(name, body);
    return;
  }
  it(name, async () => {
    let failure: unknown;
    try {
      await body();
    } catch (error) {
      failure = error;
    }
    if (failure === undefined) {
      throw new Error(`Known defect ${id} no longer reproduces. If it was fixed, turn this test into a normal one: replace knownDefect('${id}', ...) by it(...).`);
    }
    if (!isFailedExpectation(failure)) throw failure;
  });
}
