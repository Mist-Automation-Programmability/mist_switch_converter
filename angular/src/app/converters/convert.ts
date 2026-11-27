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
import { Device, Diagnostic, SourceFile, Vendor } from './model';
import { Report } from './report';
import { buildTemplate, ConvertedPort } from './template/build';
import { MistTemplate } from './template/mist';

export type { ConvertedPort } from './template/build';
export type { Diagnostic, Severity, SourceFile } from './model';
export type { MistTemplate } from './template/mist';

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
}

export interface Conversion {
  template: MistTemplate;
  /** One entry per file, in the order of the files. */
  files: FileReport[];
  /** Every converted port and the port usage it was given. */
  ports: ConvertedPort[];
  /** What the user should know about the conversion: what was left out, what was guessed. */
  diagnostics: Diagnostic[];
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

export function convert(files: SourceFile[], options: ConvertOptions = {}): Conversion {
  const report = new Report();
  const reports: FileReport[] = [];
  const devices: Device[] = [];

  for (const file of files) {
    const fileReport = report.forFile(file.name);
    const detection = detectFormat(file.text);
    if (detection.vendor === undefined) {
      const message = `${detection.reason ?? 'Unable to determine the type of file'}. Please check the format of the file ${file.name}`;
      fileReport.error('unknown-format', message);
      reports.push({ name: file.name, format: 'Unknown', converted: false, hasVlans: false, message });
      continue;
    }
    const entry: FileReport = { name: file.name, format: FORMATS[detection.vendor], converted: false, hasVlans: false };
    reports.push(entry);
    try {
      const device = EXTRACTORS[detection.vendor](file, fileReport);
      devices.push(device);
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

  const { template, ports } = buildTemplate(devices, report, options.copyClearTextSecrets === true);
  return { template, files: reports, ports, diagnostics: report.diagnostics };
}
