/**
 * The part of the template that a line of settings feeds: "ntp server 10.0.0.1" feeds
 * `ntp_servers`. The page uses it to put a line of a file beside what it became.
 *
 * Ports and VLANs know their own lines (see `Port.lineNumbers` and `Vlan.lines`). The
 * settings of the switch (servers, SNMP, banner) are only lists of values once read, so
 * their lines are found here, by their first keywords. Only lines that a rule converted
 * are given a part: this table says where a converted line goes, not whether it is converted.
 */
import { Vendor } from './model';
import { LineOutcome } from './trace';
import { numberedLines } from './readers/statement';

type Sections = Array<[RegExp, string]>;

const CISCO: Sections = [
  [/^ntp server\b/, 'ntp_servers'],
  [/^ip name-server\b/, 'dns_servers'],
  [/^ip domain[ -](name|list)\b/, 'dns_suffix'],
  [/^(radius server|radius-server|aaa server radius dynamic-author|aaa group server radius)\b/, 'radius_config'],
  [/^(tacacs server|tacacs-server|aaa group server tacacs)/, 'switch_mgmt'],
  [/^banner\b/, 'switch_mgmt'],
  [/^logging\b/, 'remote_syslog'],
  [/^snmp-server\b/, 'snmp_config'],
  [/^ip dhcp snooping\b/, 'dhcp_snooping'],
];

const ARUBA: Sections = [
  [/^ntp server\b/, 'ntp_servers'],
  [/^ip dns server-address\b/, 'dns_servers'],
  [/^ip dns domain-(name|list)\b/, 'dns_suffix'],
  [/^(radius-server|radius dyn-authorization|aaa group server radius)\b/, 'radius_config'],
  [/^(tacacs-server|aaa group server tacacs)\b/, 'switch_mgmt'],
  [/^banner\b/, 'switch_mgmt'],
  [/^logging\b/, 'remote_syslog'],
  [/^(snmp-server|snmpv3)\b/, 'snmp_config'],
  [/^dhcpv4-snooping\b/, 'dhcp_snooping'],
];

const JUNOS: Sections = [
  [/^system ntp server\b/, 'ntp_servers'],
  [/^system name-server\b/, 'dns_servers'],
  [/^system (domain-name|domain-search)\b/, 'dns_suffix'],
  [/^(system radius-server|access radius-server|access profile|system radius-options|protocols dot1x authenticator authentication-profile-name)\b/, 'radius_config'],
  [/^system (tacplus-server|accounting)\b/, 'switch_mgmt'],
  [/^system login (message|announcement)\b/, 'switch_mgmt'],
  [/^system syslog host\b/, 'remote_syslog'],
  [/^snmp\b/, 'snmp_config'],
  [/^(vlans \S+ forwarding-options dhcp-security|ethernet-switching-options secure-access-port vlan \S+ examine-dhcp)\b/, 'dhcp_snooping'],
];

const TABLES: Record<Vendor, Sections> = { 'cisco-ios': CISCO, 'aruba-cx': ARUBA, junos: JUNOS };

/**
 * The part of the template that each converted line of settings feeds, by line number.
 * In an indented file, the lines of a block go where the line that opens it goes.
 */
export function settingSections(vendor: Vendor, text: string, outcomes: LineOutcome[]): Map<number, string> {
  const table = TABLES[vendor];
  const sections = new Map<number, string>();
  let block: string | undefined;
  for (const { text: content, line } of numberedLines(text)) {
    const indented = /^\s/.test(content);
    const command = content
      .trim()
      .toLowerCase()
      .replace(/^(set|deactivate)\s+/, '');
    if (!indented) block = table.find(([pattern]) => pattern.test(command))?.[1];
    if (block !== undefined && outcomes[line - 1] === 'converted') sections.set(line, block);
  }
  return sections;
}
