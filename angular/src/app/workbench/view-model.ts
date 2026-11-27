/**
 * What the page shows of a conversion, worked out from the result of `convert()` alone.
 * Plain functions with no Angular, so that they are tested in Node like the converter.
 */
import { Conversion, ConvertedPort, Diagnostic, FileReport, LineOutcome, MessageKind, messageKind, Origin } from '../converters/convert';

/* ------------------------------------------------------------------ parts */

/** The kinds of parts that the Template list shows. */
export type PartKind = 'network' | 'usage' | 'rule' | 'setting';

export interface PartRef {
  kind: PartKind;
  /** Path of the part, as in `Origin.path` and `Diagnostic.subject`. */
  path: string;
  /** Name shown in the list: the network, port usage or switch rule, or the label of a setting. */
  name: string;
}

/** Labels of the lists of settings, in the order of the Template list. */
export const SETTINGS: ReadonlyArray<{ path: string; label: string; decided: string }> = [
  { path: 'radius_config', label: 'RADIUS', decided: 'Each RADIUS server is listed once, with the port and the timeout of the first file that names it. Its key is replaced by to_be_replaced.' },
  { path: 'switch_mgmt', label: 'Management', decided: 'Each TACACS+ server is listed once, its key replaced by to_be_replaced. The login banner is the one of the first file that has one.' },
  { path: 'ntp_servers', label: 'NTP servers', decided: 'Each server is listed once, in the order of the files.' },
  { path: 'dns_servers', label: 'DNS servers', decided: 'Each server is listed once, in the order of the files.' },
  { path: 'dns_suffix', label: 'DNS suffixes', decided: 'Each suffix is listed once, in the order of the files.' },
  { path: 'remote_syslog', label: 'Syslog', decided: 'Each server is listed once, and receives every facility and severity.' },
  { path: 'snmp_config', label: 'SNMP', decided: 'A template has one SNMP configuration: what several files define under the same name comes from the first one. Location, contact and description are written only when the files agree.' },
  { path: 'dhcp_snooping', label: 'DHCP snooping', decided: 'A VLAN that one switch snoops is snooped on every switch of the template.' },
];

export function partOf(path: string): PartRef | undefined {
  if (path.startsWith('networks.')) return { kind: 'network', path, name: path.slice('networks.'.length) };
  if (path.startsWith('port_usages.')) return { kind: 'usage', path, name: path.slice('port_usages.'.length) };
  if (path.startsWith('switch_matching.rules.')) return { kind: 'rule', path, name: path.slice('switch_matching.rules.'.length) };
  const setting = SETTINGS.find((entry) => entry.path === path);
  return setting ? { kind: 'setting', path, name: setting.label } : undefined;
}

/** The value of a part in the template, as it is exported. */
export function valueOf(conversion: Conversion, part: PartRef): unknown {
  const template = conversion.template as unknown as Record<string, unknown>;
  switch (part.kind) {
    case 'network':
      return conversion.template.networks[part.name];
    case 'usage':
      return conversion.template.port_usages[part.name];
    case 'rule':
      return conversion.template.switch_matching.rules.find((rule) => rule.name === part.name);
    case 'setting':
      return template[part.path];
  }
}

export interface NavItem extends PartRef {
  /** A few words next to the name: "VLAN 10", "846 ports". */
  detail: string;
}

export interface NavSection {
  id: 'networks' | 'usages' | 'rules' | 'settings';
  title: string;
  items: NavItem[];
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

/** The sections of the Template list. */
export function navSections(conversion: Conversion): NavSection[] {
  const template = conversion.template;
  const portsOf = (usage: string): number => conversion.ports.filter((port) => port.usage === usage).length;
  const networks: NavItem[] = Object.entries(template.networks).map(([name, network]) => ({ kind: 'network', path: `networks.${name}`, name, detail: `VLAN ${network.vlan_id}` }));
  const usages: NavItem[] = Object.keys(template.port_usages).map((name) => ({ kind: 'usage', path: `port_usages.${name}`, name, detail: plural(portsOf(name), 'port') }));
  const rules: NavItem[] = template.switch_matching.rules.map((rule) => ({ kind: 'rule', path: `switch_matching.rules.${rule.name}`, name: rule.name, detail: plural(Object.keys(rule.port_config).length, 'port') }));
  const present = new Set(conversion.origins.map((origin) => origin.path));
  const settings: NavItem[] = SETTINGS.filter((entry) => present.has(entry.path)).map((entry) => ({ kind: 'setting', path: entry.path, name: entry.label, detail: '' }));
  return [
    { id: 'networks', title: 'Networks', items: networks },
    { id: 'usages', title: 'Port profiles', items: usages },
    { id: 'rules', title: 'Switch rules', items: rules },
    { id: 'settings', title: 'Settings', items: settings },
  ];
}

export function originOf(conversion: Conversion, path: string): Origin | undefined {
  return conversion.origins.find((origin) => origin.path === path);
}

/** "Used by 846 ports on 29 switches", "VLAN 10, 10.1.10.0/24", "From 3 files". */
export function summaryOf(conversion: Conversion, part: PartRef): string {
  const origin = originOf(conversion, part.path);
  const files = origin?.sources.length ?? 0;
  switch (part.kind) {
    case 'network': {
      const network = conversion.template.networks[part.name];
      const subnet = network?.subnet ? `, subnet ${network.subnet}` : '';
      return `VLAN ${network?.vlan_id ?? '?'}${subnet}. Found in ${plural(files, 'file')}.`;
    }
    case 'usage': {
      const ports = conversion.ports.filter((port) => port.usage === part.name);
      const switches = new Set(ports.map((port) => port.hostname)).size;
      return `Used by ${plural(ports.length, 'port')} on ${plural(switches, 'switch', 'switches')}.`;
    }
    case 'rule': {
      const rule = conversion.template.switch_matching.rules.find((candidate) => candidate.name === part.name);
      return `Gives their port profile to ${plural(Object.keys(rule?.port_config ?? {}).length, 'port')}. From ${plural(files, 'file')}.`;
    }
    case 'setting':
      return `From ${plural(files, 'file')}.`;
  }
}

/** The messages about a part of the template. */
export function messagesAbout(conversion: Conversion, path: string): Diagnostic[] {
  return conversion.diagnostics.filter((diagnostic) => diagnostic.subject === path);
}

/* ------------------------------------------------------------------ files */

export const VENDOR_LABEL: Record<FileReport['format'], string> = { Cisco: 'Cisco', Juniper: 'Junos', Aruba: 'Aruba CX', Unknown: 'Not read' };

/** Messages of a file that the user has to look at. */
export function toCheckIn(conversion: Conversion, file: string): number {
  return conversion.diagnostics.filter((diagnostic) => diagnostic.file === file && messageKind(diagnostic) === 'check').length;
}

/** What a line of a file became, when it is known. */
export type LineLink =
  | { kind: 'port'; port: ConvertedPort; portKey: string }
  | { kind: 'part'; path: string };

/**
 * What each converted line of a file became, by line number: the port it configures, or
 * the network or the list of settings it feeds.
 */
export function lineLinks(conversion: Conversion, file: string): Map<number, LineLink> {
  const links = new Map<number, LineLink>();
  // Lists of settings first: a line that is also the line of a port or a VLAN belongs to it
  for (const origin of conversion.origins) {
    const part = partOf(origin.path);
    if (part?.kind !== 'setting' && part?.kind !== 'network') continue;
    for (const source of origin.sources) if (source.file === file) for (const line of source.lines) links.set(line, { kind: 'part', path: origin.path });
  }
  for (const port of conversion.ports) {
    if (port.file !== file) continue;
    const portKey = port.portConfig;
    for (const line of port.lineNumbers) if (!links.has(line) || links.get(line)?.kind === 'part') links.set(line, { kind: 'port', port, portKey });
  }
  return links;
}

/** A run of lines of a file that have the same outcome and became the same thing. */
export interface Segment {
  /** First line of the run (1-based). */
  first: number;
  lines: Array<{ number: number; text: string; outcome: LineOutcome }>;
  /** The outcome of the run: the one of its first line that is not blank. */
  outcome: Exclude<LineOutcome, 'none'>;
  link?: LineLink;
}

function linkKey(link: LineLink | undefined): string {
  if (!link) return '';
  return link.kind === 'port' ? `port ${link.port.name}` : `part ${link.path}`;
}

/** The lines of a file cut into runs. Blank lines and comments join the run before them. */
export function segmentsOf(text: string, outcomes: LineOutcome[], links: Map<number, LineLink>): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | undefined;
  let currentKey = '';
  text.split('\n').forEach((raw, index) => {
    const number = index + 1;
    const outcome = outcomes[index] ?? 'none';
    const line = { number, text: raw.replace(/\r$/, ''), outcome };
    if (outcome === 'none') {
      if (current) current.lines.push(line);
      return;
    }
    const link = outcome === 'converted' ? links.get(number) : undefined;
    const key = `${outcome} ${linkKey(link)}`;
    if (!current || key !== currentKey) {
      current = { first: number, lines: [], outcome, link };
      currentKey = key;
      segments.push(current);
    }
    current.lines.push(line);
  });
  // Blank lines at the end of a run say nothing
  for (const segment of segments) while (segment.lines.length > 1 && segment.lines[segment.lines.length - 1].outcome === 'none') segment.lines.pop();
  return segments;
}

/* ------------------------------------------------------------------- logs */

export type LogFilter = 'all' | MessageKind;

export const LOG_FILTERS: ReadonlyArray<{ id: LogFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'check', label: 'To check' },
  { id: 'not-converted', label: 'Not converted' },
  { id: 'not-read', label: 'File not read' },
  { id: 'decision', label: 'Decisions' },
];

export const KIND_LABEL: Record<MessageKind, string> = { check: 'To check', 'not-converted': 'Not converted', 'not-read': 'File not read', decision: 'Decision' };

export function countByKind(diagnostics: Diagnostic[]): Record<LogFilter, number> {
  const counts: Record<LogFilter, number> = { all: diagnostics.length, check: 0, 'not-converted': 0, 'not-read': 0, decision: 0 };
  for (const diagnostic of diagnostics) counts[messageKind(diagnostic)] += 1;
  return counts;
}

/** The logs as CSV, for a spreadsheet. */
export function logsCsv(diagnostics: Diagnostic[]): string {
  const cell = (text: string): string => `"${text.replace(/"/g, '""')}"`;
  const rows = diagnostics.map((diagnostic) => [KIND_LABEL[messageKind(diagnostic)], diagnostic.severity, diagnostic.file, (diagnostic.lines ?? []).join(' '), diagnostic.message, diagnostic.subject ?? ''].map(cell).join(','));
  return ['kind,severity,file,lines,message,template part', ...rows].join('\r\n') + '\r\n';
}
