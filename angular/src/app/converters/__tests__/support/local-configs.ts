/**
 * Real configurations for local tests.
 *
 * `test_configs/` at the root of the repository is ignored by git. It is the place for
 * real configurations, which can hold customer data and must never be committed, sent
 * or copied elsewhere. Everything this file produces from them is written back into
 * that folder, under `test_configs/_results`:
 *
 *  - one golden file per case, the full result of the conversion. It holds customer
 *    data, like the configurations themselves.
 *  - `summary.json`, which holds numbers and rule names only: no hostname, address,
 *    description, VLAN name, file name or log text. It is the only file that is safe
 *    to share.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import type { Golden } from './golden';
import type { Conversion, InputFile } from './harness';
import { INVARIANTS, SECRETS_ARE_NOT_COPIED } from './invariants';
import { secretsOf } from './privacy';

export const REPOSITORY_DIR = fileURLToPath(new URL('../../../../../../', import.meta.url));
/** Set SWITCH_CONVERTER_TEST_CONFIGS to keep the configurations outside the repository. */
export const LOCAL_CONFIGS_DIR = process.env['SWITCH_CONVERTER_TEST_CONFIGS'] || join(REPOSITORY_DIR, 'test_configs');
export const RESULTS_DIR = join(LOCAL_CONFIGS_DIR, '_results');
export const SUMMARY_FILE = join(RESULTS_DIR, 'summary.json');

/** Hidden entries and `_results` are not configurations. */
const IGNORED_ENTRY = /^[._]/;
const NOT_A_CONFIGURATION = /\.(json|md|ya?ml|csv|xlsx?|docx?|pdf|png|jpe?g|gif|zip|gz|tgz|tar|7z)$/i;

export interface LocalCase {
  /** Path below `test_configs`: a directory (`site1`) or one file of it (`site1/core.txt`). */
  name: string;
  kind: 'directory' | 'file';
  inputs: InputFile[];
  /** Where the result of the conversion is recorded. */
  resultFile: string;
}

/**
 * A directory that holds configuration files is one case: its files are converted
 * together into one template, as when a user drops them on the app together.
 * When it holds several files, each file is also converted on its own.
 */
export function loadLocalCases(): LocalCase[] {
  const cases: LocalCase[] = [];
  const visit = (dir: string): void => {
    const entries = readdirSync(dir)
      .filter((entry) => !IGNORED_ENTRY.test(entry))
      .sort();
    const name = relative(LOCAL_CONFIGS_DIR, dir).split(sep).join('/');
    const inputs = entries
      .filter((entry) => statSync(join(dir, entry)).isFile() && !NOT_A_CONFIGURATION.test(entry))
      .map((entry) => ({ name: entry, text: readFileSync(join(dir, entry), 'utf8') }));

    if (inputs.length > 0) cases.push({ name: name || '(top folder)', kind: 'directory', inputs, resultFile: join(RESULTS_DIR, name, '_all-files.json') });
    if (inputs.length > 1) {
      for (const input of inputs) {
        cases.push({ name: name ? `${name}/${input.name}` : input.name, kind: 'file', inputs: [input], resultFile: join(RESULTS_DIR, name, `${input.name}.json`) });
      }
    }
    for (const entry of entries) if (statSync(join(dir, entry)).isDirectory()) visit(join(dir, entry));
  };
  if (existsSync(LOCAL_CONFIGS_DIR)) visit(LOCAL_CONFIGS_DIR);
  return cases;
}

/* --------------------------------------------------------------- rules */

/** The secrets of the source files that appear in the template or in the log, as "<file> line <n>". */
function copiedSecrets(inputs: InputFile[], result: Conversion): string[] {
  // Every text of the output, so that a secret is compared with whole words of it.
  const words = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') value.split(/[\s"',;:=]+/).forEach((word) => words.add(word));
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object' && value !== null) Object.entries(value).forEach(([key, entry]) => (collect(key), collect(entry)));
  };
  collect(result.template);
  collect(result.logs);
  return inputs.flatMap((input) =>
    secretsOf(input.text)
      .filter((secret) => words.has(secret.value))
      .map((secret) => `${input.name} line ${secret.line}`),
  );
}

/** The invariants that a conversion breaks, with one line per violation. */
export function brokenRules(inputs: InputFile[], result: Conversion): Record<string, string[]> {
  const broken: Record<string, string[]> = {};
  for (const [rule, check] of Object.entries(INVARIANTS)) {
    const violations = rule === SECRETS_ARE_NOT_COPIED ? copiedSecrets(inputs, result) : check(result);
    if (violations.length > 0) broken[rule] = violations;
  }
  return broken;
}

/** What is recorded for a local case: the golden content plus the rules it breaks. */
export type LocalGolden = Golden & { broken_rules: Record<string, string[]> };

/* ------------------------------------------------------------- summary */

/** Fields of a port usage. A field that is not listed is counted as "other". */
const PORT_USAGE_FIELDS = [
  'all_networks', 'disable_autoneg', 'disabled', 'duplex', 'speed', 'enable_mac_auth', 'enable_qos', 'mac_auth_only', 'mac_limit',
  'guest_network', 'mode', 'mtu', 'poe_disabled', 'port_auth', 'stp_edge', 'networks', 'port_network',
  'voip_network', 'persist_mac', 'bypass_auth_when_server_down', 'allow_multiple_supplicants', 'reauth_interval',
  'server_fail_network', 'server_reject_network', 'bypass_auth_when_server_down_for_unknown_client',
];

/** Parts of the template that hold settings and no name taken from the configurations. */
const TEMPLATE_SETTINGS = ['ntp_servers', 'dns_servers', 'dns_suffix', 'radius_config', 'switch_mgmt', 'additional_config_cmds', 'dhcp_snooping', 'remote_syslog'];

type Counts = Record<string, number>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function count(counts: Counts, key: string, by = 1): void {
  if (by > 0) counts[key] = (counts[key] ?? 0) + by;
}

/** Compares two dictionaries by key: entries added, removed, and changed. */
function compareEntries(label: string, before: Record<string, unknown>, after: Record<string, unknown>, counts: Counts): string[] {
  const changed = Object.keys(before).filter((key) => key in after && !same(before[key], after[key]));
  count(counts, `${label} added`, Object.keys(after).filter((key) => !(key in before)).length);
  count(counts, `${label} removed`, Object.keys(before).filter((key) => !(key in after)).length);
  count(counts, `${label} changed`, changed.length);
  return changed;
}

/** Compares two lists of lines. */
function compareLines(label: string, before: string[], after: string[], counts: Counts): void {
  count(counts, `${label} added`, after.filter((line) => !before.includes(line)).length);
  count(counts, `${label} removed`, before.filter((line) => !after.includes(line)).length);
}

/**
 * What differs between the recorded result and the new one, as counts.
 * The keys are built from fixed words and field names of the template, never from
 * the content of a configuration.
 */
export function describeChanges(before: LocalGolden, after: LocalGolden): Counts {
  const counts: Counts = {};

  const changedUsages = compareEntries('port usages', before.template.port_usages, after.template.port_usages, counts);
  for (const name of changedUsages) {
    const old = before.template.port_usages[name] as unknown as Record<string, unknown>;
    const now = after.template.port_usages[name] as unknown as Record<string, unknown>;
    for (const field of new Set([...Object.keys(old), ...Object.keys(now)])) {
      if (!same(old[field], now[field])) count(counts, `port usages changed: ${PORT_USAGE_FIELDS.includes(field) ? field : 'other field'}`);
    }
  }
  compareEntries('networks', before.template.networks, after.template.networks, counts);
  compareLines('interfaces (port usage given to an interface)', before.ports, after.ports, counts);
  if (!same(before.template.switch_matching, after.template.switch_matching)) count(counts, 'switch rules changed');

  for (const part of TEMPLATE_SETTINGS) {
    const old = (before.template as unknown as Record<string, unknown>)[part];
    const now = (after.template as unknown as Record<string, unknown>)[part];
    if (same(old, now)) continue;
    const isSettings = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
    if (isSettings(old) && isSettings(now)) {
      for (const field of new Set([...Object.keys(old), ...Object.keys(now)])) if (!same(old[field], now[field])) count(counts, `${part}.${field} changed`);
    } else count(counts, `${part} changed`);
  }

  compareLines('problems reported to the user', before.problems, after.problems, counts);
  compareLines('exceptions', before.errors, after.errors, counts);
  if (!same(before.files, after.files)) count(counts, 'file status changed');
  for (const rule of new Set([...Object.keys(before.broken_rules ?? {}), ...Object.keys(after.broken_rules ?? {})])) {
    const difference = (after.broken_rules?.[rule]?.length ?? 0) - (before.broken_rules?.[rule]?.length ?? 0);
    if (difference !== 0) counts[`violations of "${rule}"`] = difference;
  }
  return counts;
}

function tally(values: string[]): Counts {
  const counts: Counts = {};
  for (const value of values) count(counts, value);
  return counts;
}

export interface CaseSummary {
  /** Position of the case in alphabetical order. Names stay out of the summary. */
  case: number;
  kind: 'directory' | 'file';
  /** `new`: recorded for the first time. `changed`: differs from the recorded result. */
  result: 'new' | 'same' | 'changed';
  changes?: Counts;
  files: number;
  lines: number;
  formats: Counts;
  files_not_converted: number;
  switch_rules: number;
  interfaces: number;
  port_usages: number;
  networks: number;
  servers: Counts;
  log_entries: Counts;
  exceptions: Counts;
  /** Number of violations per invariant. */
  broken_rules: Counts;
}

const KNOWN_FORMATS = ['Cisco', 'Juniper', 'Unknown'];

export function summarize(index: number, localCase: LocalCase, result: Conversion, golden: LocalGolden, recorded: LocalGolden | undefined): CaseSummary {
  const template = result.template;
  const changes = recorded ? describeChanges(recorded, golden) : undefined;
  return {
    case: index + 1,
    kind: localCase.kind,
    result: recorded === undefined ? 'new' : same(recorded, golden) ? 'same' : 'changed',
    ...(changes && Object.keys(changes).length > 0 ? { changes } : {}),
    files: localCase.inputs.length,
    lines: localCase.inputs.reduce((total, input) => total + input.text.split('\n').length, 0),
    formats: tally(result.files.map((file) => (KNOWN_FORMATS.includes(file.format) ? file.format : 'other'))),
    files_not_converted: result.files.filter((file) => !file.success_config).length,
    switch_rules: template.switch_matching.rules.length,
    interfaces: result.ports.length,
    port_usages: Object.keys(template.port_usages).length,
    networks: Object.keys(template.networks).length,
    servers: {
      radius_auth: template.radius_config.auth_servers.length,
      radius_acct: template.radius_config.acct_servers.length,
      tacacs: template.switch_mgmt.tacacs.tacplus_servers.length,
      syslog: template.remote_syslog.servers.length,
      ntp: template.ntp_servers.length,
      dns: template.dns_servers.length,
    },
    log_entries: tally(result.logs.map((entry) => entry.level)),
    // The message of a failure names its file, so only the number of failures is kept.
    exceptions: tally(result.errors.map(() => 'failure of the converter')),
    broken_rules: Object.fromEntries(Object.entries(golden.broken_rules).map(([rule, violations]) => [rule, violations.length])),
  };
}

/** The recorded result of a case, or `undefined` when there is none yet or it cannot be read. */
export function readRecorded(localCase: LocalCase): LocalGolden | undefined {
  try {
    return JSON.parse(readFileSync(localCase.resultFile, 'utf8')) as LocalGolden;
  } catch {
    return undefined;
  }
}

export function writeSummary(cases: CaseSummary[]): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const summary = {
    note: 'Numbers and rule names only. The other files of this folder hold data of the configurations: never share or commit them.',
    cases: cases.length,
    totals: {
      new: cases.filter((entry) => entry.result === 'new').length,
      same: cases.filter((entry) => entry.result === 'same').length,
      changed: cases.filter((entry) => entry.result === 'changed').length,
    },
    results: [...cases].sort((a, b) => a.case - b.case),
  };
  writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n');
}
