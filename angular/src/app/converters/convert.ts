/**
 * The converter: configuration files in, one Mist switch template out.
 *
 *     const result = convert([{ name: 'sw1.txt', text }]);
 *
 * `convert` is a plain function. It runs where it is called, in the browser of the
 * user, and reads nothing but its arguments: no network, no storage, no page. The
 * configuration files never leave the computer of the user.
 *
 * It works in three stages:
 *   1. a reader (`readers/`) cuts a file into statements, without knowing what they mean,
 *   2. an extractor (`extractors/`, one per vendor) fills a vendor-neutral `Device`,
 *   3. the template builder (`template/`) turns the devices into one template.
 */
import { detectFormat } from './detect';
import { extractArubaCx } from './extractors/aruba_cx';
import { extractCiscoIos } from './extractors/cisco_ios';
import { extractJunos } from './extractors/junos';
import { recordOutcomes } from './extractors/rules';
import { Device, Diagnostic, SourceFile, Vendor } from './model';
import { numberedLines } from './readers/statement';
import { Report } from './report';
import { settingSections } from './sections';
import { buildTemplate, ConvertedPort } from './template/build';
import { MistTemplate } from './template/mist';
import { Origin } from './template/origin';
import { LineOutcome } from './trace';

export type { ConvertedPort } from './template/build';
export type { Diagnostic, Severity, SourceFile } from './model';
export type { MistTemplate } from './template/mist';
export type { Origin, OriginSource } from './template/origin';
export type { LineOutcome } from './trace';

export type FileFormat = 'Cisco' | 'Juniper' | 'Aruba' | 'Unknown';

/** What happened to one file. */
export interface FileReport {
  name: string;
  format: FileFormat;
  /** Name of the device, when the file is converted and names it. */
  hostname?: string;
  /** True when the file was read and is part of the template. */
  converted: boolean;
  /** True when the file declares VLANs. Without them, its networks are named after their ids. */
  hasVlans: boolean;
  /** Why the file is not converted, or what is missing from it. */
  message?: string;
  /**
   * What happened to each line of the file, the first line at index 0: converted, not
   * needed in a Mist template, not converted, or nothing to read (blank, comment).
   * Every line is 'none' in a file that is not converted.
   */
  outcomes: LineOutcome[];
  /** How many lines have each outcome. */
  counts: Record<LineOutcome, number>;
  /** How many interfaces of the file are in the template. */
  ports: number;
}

export interface Conversion {
  template: MistTemplate;
  /** One entry per file, in the order of the files. */
  files: FileReport[];
  /** Every converted port and the port usage it was given. */
  ports: ConvertedPort[];
  /** What the user should know about the conversion: what was left out, what was guessed. */
  diagnostics: Diagnostic[];
  /**
   * Where each part of the template comes from (files, lines, ports) and, for the parts the
   * converter names, why it has its name. One entry per network, port usage, switch rule,
   * and per list of settings (`ntp_servers`, `radius_config`, `snmp_config`...).
   */
  origins: Origin[];
}

/** What a message is, for the user: the kinds by which the page sorts the log. */
export type MessageKind =
  | 'not-read' // a file that is not converted at all
  | 'not-converted' // a command or a port that is not in the template
  | 'check' // something to check before importing the template
  | 'decision'; // what the converter chose, for information

const NOT_READ = new Set(['unknown-format', 'internal-error']);
const NOT_CONVERTED = new Set(['not-converted', 'port-setting-not-converted', 'routed-port', 'port-name', 'lag-without-member', 'port-twice']);

export function messageKind(diagnostic: Diagnostic): MessageKind {
  if (NOT_READ.has(diagnostic.code)) return 'not-read';
  if (NOT_CONVERTED.has(diagnostic.code)) return 'not-converted';
  return diagnostic.severity === 'info' ? 'decision' : 'check';
}

export interface ConvertOptions {
  /**
   * Copies into the template the secrets that a file has in clear text: the SNMP communities,
   * and the passwords of SNMP version 3 when a file has them in clear text. False by default:
   * they are replaced by a placeholder. A secret that a file only has encrypted or hashed is
   * never copied.
   */
  copyClearTextSecrets?: boolean;
}

const FORMATS: Record<Vendor, FileFormat> = { 'cisco-ios': 'Cisco', junos: 'Juniper', 'aruba-cx': 'Aruba' };
const EXTRACTORS: Record<Vendor, (file: SourceFile, report: Report) => Device> = { 'cisco-ios': extractCiscoIos, junos: extractJunos, 'aruba-cx': extractArubaCx };
const NO_VLAN: Record<Vendor, string> = {
  'cisco-ios': 'Unable to retrieve the VLAN list. Add the output of "show vlan brief" to the file to get the names of the VLANs',
  junos: 'Unable to retrieve the VLAN list',
  'aruba-cx': 'Unable to retrieve the VLAN list',
};

function countOf(outcomes: LineOutcome[]): Record<LineOutcome, number> {
  const counts: Record<LineOutcome, number> = { converted: 0, ignored: 0, 'not-converted': 0, none: 0 };
  for (const outcome of outcomes) counts[outcome] += 1;
  return counts;
}

function unread(text: string): LineOutcome[] {
  return numberedLines(text).map((): LineOutcome => 'none');
}

export function convert(files: SourceFile[], options: ConvertOptions = {}): Conversion {
  const report = new Report();
  const reports: FileReport[] = [];
  const devices: Device[] = [];
  const vendors = new Map<string, Vendor>();

  for (const file of files) {
    const fileReport = report.forFile(file.name);
    const detection = detectFormat(file.text);
    if (detection.vendor === undefined) {
      const message = `${detection.reason ?? 'Unable to determine the type of file'}. Please check the format of the file ${file.name}`;
      fileReport.error('unknown-format', message);
      const outcomes = unread(file.text);
      reports.push({ name: file.name, format: 'Unknown', converted: false, hasVlans: false, message, outcomes, counts: countOf(outcomes), ports: 0 });
      continue;
    }
    const entry: FileReport = { name: file.name, format: FORMATS[detection.vendor], converted: false, hasVlans: false, outcomes: [], counts: countOf([]), ports: 0 };
    reports.push(entry);
    try {
      const trace = fileReport.trace();
      const extract = EXTRACTORS[detection.vendor];
      const device = recordOutcomes((line, outcome) => trace.rule(line, outcome), () => extract(file, fileReport));
      devices.push(device);
      vendors.set(file.name, detection.vendor);
      entry.converted = true;
      entry.hostname = device.hostname;
      const declared = device.vlans.filter((vlan) => vlan.declared).map((vlan) => vlan.id);
      entry.hasVlans = declared.length > 0;
      if (entry.hasVlans) fileReport.info('vlans', `VLANs of the file: ${declared.sort((a, b) => a - b).join(', ')}`);
      else {
        entry.message = NO_VLAN[detection.vendor];
        fileReport.warning('no-vlan', entry.message);
      }
    } catch (error) {
      // A file that cannot be read must not stop the conversion of the others.
      entry.message = `Error when reading configuration from ${file.name}`;
      fileReport.error('internal-error', `${entry.message}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const { template, ports, origins } = buildTemplate(devices, report, options.copyClearTextSecrets === true);

  // What happened to each line, once the template builder has said which ports it left out
  files.forEach((file, index) => {
    const entry = reports[index];
    if (!entry.converted) {
      entry.outcomes = unread(file.text);
    } else {
      entry.outcomes = report.forFile(file.name).trace().outcomes(file.text);
      entry.ports = ports.filter((port) => port.file === file.name).length;
    }
    entry.counts = countOf(entry.outcomes);
  });

  // The lines of the settings of the switch, found by their keywords (see sections.ts)
  for (const origin of origins) {
    if (origin.sources.every((source) => source.lines.length > 0)) continue;
    for (const source of origin.sources) {
      if (source.lines.length > 0) continue;
      const vendor = vendors.get(source.file);
      const index = files.findIndex((file) => file.name === source.file);
      if (vendor === undefined || index < 0) continue;
      const sections = settingSections(vendor, files[index].text, reports[index].outcomes);
      source.lines = [...sections.entries()].filter(([, path]) => path === origin.path).map(([line]) => line);
    }
  }

  // Messages about SNMP are about its part of the template
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.subject === undefined && (diagnostic.code.startsWith('snmp') || diagnostic.code === 'secrets-copied')) diagnostic.subject = 'snmp_config';
  }

  return { template, files: reports, ports, diagnostics: report.diagnostics, origins };
}
