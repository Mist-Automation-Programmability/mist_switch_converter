/**
 * Template builder: turns the devices read from the files into one Mist template.
 *
 * Nothing here knows a vendor's syntax. Whatever the vendor of a device, its VLANs
 * become networks, its ports get port usages, and the device gets a switch rule that
 * gives each port its usage.
 */
import { Device, Port } from '../model';
import { Report } from '../report';
import { emptyTemplate, MistPortConfig, MistSwitchRule, MistTemplate, SECRET_PLACEHOLDER } from './mist';
import { buildSnmp } from './snmp';
import { buildNetworks, Networks } from './networks';
import { Origin, OriginSource } from './origin';
import { PortUsages, portUsageOf } from './port_usages';

/** A port of a source file and what the template gives it. */
export interface ConvertedPort {
  file: string;
  /** Name of the switch rule of the device. */
  hostname: string;
  /** Name of the interface in the source file. */
  name: string;
  /** Name of the port on a Juniper switch. Undefined for a link aggregation. */
  junosName?: string;
  /** Name of its port usage. */
  usage: string;
  description: string;
  /** The lines of the source file that configure the port. */
  lines: string[];
  /** The numbers of those lines (1-based). */
  lineNumbers: number[];
}

export interface BuiltTemplate {
  template: MistTemplate;
  ports: ConvertedPort[];
  /**
   * Where the parts of the template come from. The parts that are lists of settings
   * (servers, SNMP) only name their files here: their lines are found by the conversion.
   */
  origins: Origin[];
}

/** The name of a file without its directory and its extension. */
function baseName(file: string): string {
  const name = file.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]+$/, '');
  return name || file;
}

interface Rule {
  rule: MistSwitchRule;
  /** Ports that the rule configures, to keep each port once. */
  taken: Map<string, string>;
}

function buildSwitchRules(devices: Device[], networks: Networks, usages: PortUsages, report: Report): { rules: MistSwitchRule[]; ports: ConvertedPort[]; origins: Origin[] } {
  const rules = new Map<string, Rule>();
  /** Why each switch rule has its name, and the files it comes from. */
  const ruleOrigins = new Map<string, Origin>();
  const ports: ConvertedPort[] = [];
  /** Ports whose usage gets its name once every port is known. */
  const pending: Array<{ usage: { readonly name: string }; apply: (name: string) => void }> = [];

  for (const device of devices) {
    const fileReport = report.forFile(device.file);
    let hostname = device.hostname;
    if (!hostname) {
      hostname = baseName(device.file);
      fileReport.warning('no-hostname', `No hostname in the file: its switch rule is named after the file, "${hostname}"`, undefined, `switch_matching.rules.${hostname}`);
    }
    let origin = ruleOrigins.get(hostname);
    if (!origin) {
      origin = { path: `switch_matching.rules.${hostname}`, sources: [], naming: device.hostname ? `Named after the hostname of ${device.file}. The rule applies to the switches whose name starts with "${hostname}".` : `${device.file} has no hostname: named after the file. The rule applies to the switches whose name starts with "${hostname}".` };
      ruleOrigins.set(hostname, origin);
    }
    const ruleSource: OriginSource = { file: device.file, lines: [], ports: [] };
    origin.sources.push(ruleSource);
    let entry = rules.get(hostname);
    if (entry) {
      fileReport.warning('same-hostname', `Another file has the hostname "${hostname}": the ports of both files are in one switch rule, and a port that both files configure keeps the settings of the first file`, undefined, `switch_matching.rules.${hostname}`);
      origin.naming = `${origin.naming} Several files have this hostname: their ports are in this one rule.`;
    } else {
      entry = { rule: { name: hostname, port_config: {}, [`match_name[0:${hostname.length}]`]: hostname } as MistSwitchRule, taken: new Map() };
      rules.set(hostname, entry);
    }
    const { rule, taken } = entry;

    const record = (port: Port, usage: { readonly name: string }): void => {
      const converted: ConvertedPort = { file: device.file, hostname: rule.name, name: port.name, junosName: port.junosName, usage: '', description: port.description ?? '', lines: port.lines, lineNumbers: port.lineNumbers };
      ports.push(converted);
      ruleSource.ports?.push(port.name);
      ruleSource.lines.push(...port.lineNumbers);
      pending.push({ usage, apply: (name) => (converted.usage = name) });
    };
    /** True when the rule can still configure these ports. */
    const free = (port: Port, names: string[]): boolean => {
      const clash = names.find((name) => taken.has(name));
      if (clash === undefined) return true;
      fileReport.warning('port-twice', `Interface ${port.name}: the port ${clash} already has the settings of ${taken.get(clash)}, left out`);
      fileReport.linesAre(port.lineNumbers, 'not-converted');
      return false;
    };

    for (const port of device.ports) {
      if (port.lag) continue; // configured with its link aggregation, below
      const members = port.kind === 'lag' ? device.ports.filter((member) => member.lag?.name === port.name && member.junosName !== undefined) : [];
      const names = port.kind === 'lag' ? members.map((member) => member.junosName as string) : port.junosName === undefined ? [] : [port.junosName];
      if (names.length === 0) {
        if (port.kind === 'lag') {
          fileReport.warning('lag-without-member', `${port.name} has no member port in the file: not converted`);
          fileReport.linesAre(port.lineNumbers, 'not-converted');
        }
        continue;
      }
      if (!free(port, names)) continue;
      names.forEach((name) => taken.set(name, port.name));

      const usage = usages.add(port, portUsageOf(port, networks.nameOf));
      // The order of the fields is the order of the exported file.
      const config: MistPortConfig = {
        ...(port.kind === 'lag' ? { ...(port.lacp === false ? { ae_disable_lacp: true } : {}), ae_idx: port.aeIndex, aggregated: true } : {}),
        ...(port.description ? { description: port.description } : {}),
        usage: '',
      };
      rule.port_config[names.join(',')] = config;
      pending.push({ usage, apply: (name) => (config.usage = name) });

      record(port, usage);
      members.forEach((member) => record(member, usage));
    }
  }

  usages.assignNames(report);
  pending.forEach(({ usage, apply }) => apply(usage.name));

  // The ports of each port usage, file by file
  const namings = usages.namings();
  const usageOrigins = new Map<string, Origin>();
  for (const port of ports) {
    let origin = usageOrigins.get(port.usage);
    if (!origin) {
      origin = { path: `port_usages.${port.usage}`, sources: [], naming: namings.get(port.usage) };
      usageOrigins.set(port.usage, origin);
    }
    let source = origin.sources.find((candidate) => candidate.file === port.file);
    if (!source) {
      source = { file: port.file, lines: [], ports: [] };
      origin.sources.push(source);
    }
    source.ports?.push(port.name);
    source.lines.push(...port.lineNumbers);
  }
  const origins = [...usageOrigins.values(), ...ruleOrigins.values()];
  for (const origin of origins) for (const source of origin.sources) source.lines = [...new Set(source.lines)].sort((a, b) => a - b);
  return { rules: [...rules.values()].map((entry) => entry.rule), ports, origins };
}

/** The parts of the template that are lists of settings, and the devices that give them something. */
const SYSTEM_PARTS: Array<{ path: string; gives: (device: Device) => boolean }> = [
  { path: 'ntp_servers', gives: (device) => device.system.ntpServers.length > 0 },
  { path: 'dns_servers', gives: (device) => device.system.dnsServers.length > 0 },
  { path: 'dns_suffix', gives: (device) => device.system.dnsSuffixes.length > 0 },
  { path: 'radius_config', gives: (device) => device.system.radius.auth.length + device.system.radius.acct.length > 0 || device.system.radius.coaPort !== undefined },
  { path: 'switch_mgmt', gives: (device) => device.system.tacacs.auth.length + device.system.tacacs.acct.length > 0 || device.system.banner !== undefined },
  { path: 'remote_syslog', gives: (device) => device.system.syslogServers.length > 0 },
  { path: 'snmp_config', gives: (device) => device.system.snmp !== undefined },
  { path: 'dhcp_snooping', gives: (device) => device.vlans.some((vlan) => vlan.dhcpSnooping) },
];

/** Adds the servers of a device to a list of the template, each server once. */
function addServers<S, T>(target: T[], servers: S[], keyOf: (server: S) => string, seen: Set<string>, convert: (server: S) => T): void {
  for (const server of servers) {
    if (seen.has(keyOf(server))) continue;
    seen.add(keyOf(server));
    target.push(convert(server));
  }
}

export function buildTemplate(devices: Device[], report: Report, copyClearTextSecrets = false): BuiltTemplate {
  const template = emptyTemplate();

  const networks = buildNetworks(devices, report);
  template.networks = networks.byName;

  const usages = new PortUsages();
  const { rules, ports, origins: portOrigins } = buildSwitchRules(devices, networks, usages, report);
  template.port_usages = usages.byName();
  template.switch_matching = { enabled: rules.length > 0, rules };

  // Servers and system settings: a template has one list for all its switches.
  const seen = { radiusAuth: new Set<string>(), radiusAcct: new Set<string>(), tacacsAuth: new Set<string>(), tacacsAcct: new Set<string>(), syslog: new Set<string>() };
  const banners: Array<{ file: string; banner: string }> = [];
  for (const device of devices) {
    const system = device.system;
    for (const server of system.ntpServers) if (!template.ntp_servers.includes(server)) template.ntp_servers.push(server);
    for (const server of system.dnsServers) if (!template.dns_servers.includes(server)) template.dns_servers.push(server);
    for (const suffix of system.dnsSuffixes) if (!template.dns_suffix.includes(suffix)) template.dns_suffix.push(suffix);

    // A RADIUS server is listed once, with the port of the first file that names it.
    const radius = template.radius_config;
    addServers(radius.auth_servers, system.radius.auth, (server) => server.host, seen.radiusAuth, (server) => ({ port: String(server.port), host: server.host, secret: SECRET_PLACEHOLDER, timeout: server.timeout }));
    addServers(radius.acct_servers, system.radius.acct, (server) => server.host, seen.radiusAcct, (server) => ({ port: String(server.port), host: server.host, secret: SECRET_PLACEHOLDER, timeout: server.timeout }));
    if (system.radius.coaPort !== undefined && !radius.coa_enabled) {
      radius.coa_enabled = true;
      radius.coa_port = system.radius.coaPort;
    }

    const tacacs = template.switch_mgmt.tacacs;
    const endpoint = (server: { host: string; port: number }): string => `${server.host}:${server.port}`;
    addServers(tacacs.tacplus_servers, system.tacacs.auth, endpoint, seen.tacacsAuth, (server) => ({ host: server.host, port: String(server.port), secret: SECRET_PLACEHOLDER, timeout: 10 }));
    addServers(tacacs.acct_servers, system.tacacs.acct, endpoint, seen.tacacsAcct, (server) => ({ host: server.host, port: String(server.port), secret: SECRET_PLACEHOLDER, timeout: 10 }));
    tacacs.enabled = tacacs.tacplus_servers.length > 0 || tacacs.acct_servers.length > 0;

    addServers(template.remote_syslog.servers, system.syslogServers, endpoint, seen.syslog, (server) => ({ host: server.host, protocol: server.protocol, port: String(server.port), contents: [{ facility: 'any', severity: 'any' }] }));
    template.remote_syslog.enabled = template.remote_syslog.servers.length > 0;

    if (system.banner) banners.push({ file: device.file, banner: system.banner });
  }

  if (banners.length > 0) {
    template.switch_mgmt = { cli_banner: banners[0].banner, tacacs: template.switch_mgmt.tacacs };
    if (banners.some((entry) => entry.banner !== banners[0].banner)) {
      report.info('banners', `The files have different login banners: the template has the banner of ${banners[0].file}`, undefined, 'switch_mgmt');
    }
  }

  const snmp = buildSnmp(devices, report, copyClearTextSecrets);
  if (snmp) template.snmp_config = snmp;

  // DHCP snooping is a setting of the template: a VLAN that one device snoops is snooped everywhere.
  const snooped = new Set(devices.flatMap((device) => device.vlans.filter((vlan) => vlan.dhcpSnooping).map((vlan) => vlan.id)));
  template.dhcp_snooping = { enabled: snooped.size > 0, networks: [...snooped].sort((a, b) => a - b).map(networks.nameOf) };

  const systemOrigins: Origin[] = SYSTEM_PARTS.map(({ path, gives }) => ({ path, sources: devices.filter(gives).map((device) => ({ file: device.file, lines: [] })) })).filter((origin) => origin.sources.length > 0);

  report.flush();
  return { template, ports, origins: [...networks.origins, ...portOrigins, ...systemOrigins] };
}
