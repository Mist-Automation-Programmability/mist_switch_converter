/**
 * Test harness for the converter.
 *
 * `convert()` feeds configuration text to the converter the same way the app does
 * (see `AppComponent.processFiles`) and returns what a user gets: the exported Mist
 * template, the status of each file and the log.
 *
 * Tests should assert on that result and not on the internals of the converter, so
 * that they keep their value when the converter changes. The readers, the rule
 * tables and the other building blocks have tests of their own in `unit/`.
 */
import { expect, it } from 'vitest';
import { convert as convertFiles, type ConvertOptions } from '../../convert';
import type { MistPortConfig, MistPortUsage, MistSwitchRule, MistTemplate } from '../../template/mist';

/* ------------------------------------------------------------------ types */

export interface InputFile {
  name: string;
  text: string;
}

export interface LogEntry {
  level: 'info' | 'warning' | 'error';
  file: string;
  message: string;
  /** Lines of the file that the message is about. */
  lines?: number[];
}

/** Status of one input file, as shown in the file list of the app. */
export interface FileResult {
  name: string;
  format: string;
  /** The file declares VLANs. */
  success_vlan: boolean;
  /** The file was converted. */
  success_config: boolean;
  /** Why the file was not converted or what is missing from it, '' when there is nothing to say. */
  error_message: string;
}

/** One interface found in an input file and the port usage (profile) it was given. */
export interface SourcePort {
  file: string;
  hostname: string;
  /** Interface name as written in the source configuration, in its long form. */
  source: string;
  /** Name of the port usage in `template.port_usages`. */
  usage: string;
  description: string;
}

export type PortUsage = Partial<MistPortUsage>;
export type PortConfig = Partial<MistPortConfig>;
export type SwitchRule = MistSwitchRule;

export interface Conversion {
  /** The Mist template exactly as the app exports it (JSON round trip included). */
  template: MistTemplate;
  files: FileResult[];
  ports: SourcePort[];
  logs: LogEntry[];
  /** Failures of the converter itself. It reports them and goes on with the other files. */
  errors: string[];
}

/* ---------------------------------------------------------------- convert */

/**
 * Converts one or more configuration files into a Mist template.
 * A string is turned into a file named `file1.txt`, `file2.txt`, ...
 *
 * The converter is synchronous. This function is `async` because the tests were
 * written with `await` for the converter that came before it.
 */
export async function convert(...inputs: Array<string | InputFile>): Promise<Conversion> {
  return convertWith({}, ...inputs);
}

/** `convert` with the options of the page, such as "Copy the SNMP secrets that are in clear text". */
export async function convertWith(options: ConvertOptions, ...inputs: Array<string | InputFile>): Promise<Conversion> {
  const result = convertFiles(inputs.map((input, index) => (typeof input === 'string' ? { name: `file${index + 1}.txt`, text: input } : input)), options);
  return {
    // The app downloads JSON.stringify(template); do the same so tests see the real export.
    template: JSON.parse(JSON.stringify(result.template)) as MistTemplate,
    files: result.files.map((file) => ({ name: file.name, format: file.format, success_vlan: file.hasVlans, success_config: file.converted, error_message: file.message ?? '' })),
    ports: result.ports.map((port) => ({ file: port.file, hostname: port.hostname, source: port.name, usage: port.usage, description: port.description })),
    logs: result.diagnostics.map((entry) => ({ level: entry.severity, file: entry.file, message: entry.message, ...(entry.lines ? { lines: entry.lines } : {}) })),
    errors: result.diagnostics.filter((entry) => entry.code === 'internal-error').map((entry) => entry.message),
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

/**
 * The port usage that a switch rule gives to a port, looked up by its Junos name
 * (`ge-0/0/0`). Unlike `usageFor`, this reads the rule, which is what Mist applies:
 * the two differ when two source interfaces end up on the same port.
 */
export function usageOfPort(conversion: Conversion, mistPort: string, hostname?: string): PortUsage {
  const config = portConfig(conversion, mistPort, hostname);
  expect(config, `the switch rule does not configure ${mistPort}. Configured ports: ${configuredPorts(conversion, hostname).join(', ') || '(none)'}`).toBeDefined();
  const usage = conversion.template.port_usages[config!.usage ?? ''];
  expect(usage, `port usage "${config!.usage}" of ${mistPort} is missing from the template`).toBeDefined();
  return usage as PortUsage;
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
export function endpoints(servers: Array<{ host: string; port: string | number }>): string[] {
  return servers.map((server) => `${server.host}:${server.port}`);
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
    check(usage.server_fail_network);
    check(usage.server_reject_network);
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
