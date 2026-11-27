/**
 * Tells which kind of configuration a file holds, from its content.
 */
import { Vendor } from './model';

export interface Detection {
  /** Undefined when the file is not a configuration that the converter reads. */
  vendor?: Vendor;
  /** Why the file is not converted, when the reason is known. */
  reason?: string;
}

/** Top-level statements of a Junos configuration. A Cisco route-map also has lines that start with "set". */
const JUNOS_SET = /^set (version|system|chassis|interfaces|vlans|protocols|groups|apply-groups|access|switch-options|ethernet-switching-options|routing-options|routing-instances|forwarding-options|policy-options|class-of-service|firewall|snmp|poe|virtual-chassis|event-options|security|services)\b/;

/** Commands that start a line of a Cisco IOS configuration, in full or as people abbreviate them. */
const CISCO_IOS = /^(!|hostname \S|int(erface)? \S|vlan \d|(no )?(switchport|spanning-tree|ip|aaa|service|logging|ntp|snmp-server|line|enable|username|radius|tacacs|banner|errdisable|vtp|cdp|lldp|shut(down)?)\b|sh(ow)? (run|start)|version \d+\.\d+|Current configuration|Building configuration)/i;
/** The prompt of a Cisco IOS or Aruba AOS-CX terminal: "sw1#", "sw1(config-if)#". */
const TERMINAL_PROMPT = /^[A-Za-z0-9][\w.:/-]*(\([\w-]+\))?[#>]\s*/;

/** The first lines of "show running-config" on Aruba AOS-CX: "!Version ArubaOS-CX FL.10.10.1020", "!Version AOS-CX PL.10.06.0001". */
const ARUBA_CX_HEADER = /^!\s*Version (ArubaOS|AOS)-CX\b/im;
/** Without that header: ports named member/slot/port, with the commands that give them their VLANs. */
const ARUBA_CX_PORT = /^interface \d+\/\d+\/\d+$/;
const ARUBA_CX_PORT_SETTING = /^(vlan (access|trunk) |no routing$)/;

export function detectFormat(text: string): Detection {
  const lines = text.split('\n').map((line) => line.trim());

  // Systems whose configuration looks like Cisco IOS and is not.
  const typed = lines.map((line) => line.replace(TERMINAL_PROMPT, ''));
  if (ARUBA_CX_HEADER.test(text) || (typed.some((line) => ARUBA_CX_PORT.test(line)) && typed.some((line) => ARUBA_CX_PORT_SETTING.test(line)))) {
    return { vendor: 'aruba-cx' };
  }
  if (lines.some((line) => /^(!Command: show running-config|feature [\w-]+$|vdc \S+)/.test(line))) {
    return { reason: 'This is a Cisco NX-OS configuration. Only Cisco IOS and IOS-XE are supported' };
  }

  const junos = lines.filter((line) => JUNOS_SET.test(line)).length;
  const cisco = typed.filter((line) => CISCO_IOS.test(line)).length;
  if (junos > 0 && junos >= cisco) return { vendor: 'junos' };
  if (cisco > 0) return { vendor: 'cisco-ios' };

  // A Junos configuration with braces: "system {", "host-name ex1;"
  if (lines.filter((line) => /^[\w-]+( [\w./-]+)? \{$/.test(line)).length >= 2 && lines.some((line) => line.endsWith(';'))) {
    return { reason: 'This is a Junos configuration with braces. Save it with "show configuration | display set"' };
  }
  return {};
}
