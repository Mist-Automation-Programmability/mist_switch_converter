/**
 * The vendor-neutral model.
 *
 * An extractor (one per vendor, in `extractors/`) reads a configuration file and
 * fills a `Device`. The template builder (`template/`) turns devices into a Mist
 * template. Nothing in this file knows a vendor's syntax or a Mist field name.
 *
 * VLANs are always referred to by id. Their names are chosen once, for all the
 * files, when the template is built.
 */

/* ------------------------------------------------------------------ input */

export interface SourceFile {
  name: string;
  text: string;
}

export type Vendor = 'cisco-ios' | 'junos';

/* ----------------------------------------------------------------- device */

export interface Device {
  file: string;
  vendor: Vendor;
  /** Undefined when the file does not name the device. */
  hostname?: string;
  /** Every VLAN the file declares or uses, in the order the file mentions them. */
  vlans: Vlan[];
  /** Interfaces of the file, in the order the file mentions them. */
  ports: Port[];
  system: System;
}

export interface Vlan {
  id: number;
  /** Name given by the VLAN database of the device (VLAN table, "vlan" block, "set vlans"). */
  name?: string;
  /** Description of the layer 3 interface of the VLAN. Used as a name when no file declares one. */
  alias?: string;
  /** Subnets of the layer 3 interface of the VLAN, primary address first. */
  subnets: string[];
  /** True when the VLAN is in the VLAN database of the device, false when a port only refers to it. */
  declared: boolean;
  dhcpSnooping: boolean;
}

export type PortKind =
  | 'physical'
  | 'lag' // Port-channel, ae
  | 'svi' // Vlan10, irb, vlan
  | 'management'
  | 'loopback'
  | 'internal' // ports without a connector, such as AppGigabitEthernet
  | 'other'; // tunnels, sub-interfaces...

export type PortMode = 'access' | 'trunk' | 'routed';

export type Speed = 'auto' | '10m' | '100m' | '1g' | '2.5g' | '5g' | '10g' | '25g' | '40g' | '100g';
export type Duplex = 'auto' | 'half' | 'full';

export interface Port {
  /** Name as the source writes it, in its long form: GigabitEthernet1/0/1, ge-0/0/1, ae0. */
  name: string;
  kind: PortKind;
  /**
   * Name of the port at the same position on a Juniper switch: ge-0/0/0 for GigabitEthernet1/0/1.
   * Undefined when the position cannot be translated. Each vendor has its own numbering, so the
   * extractor works it out.
   */
  junosName?: string;
  description?: string;
  disabled: boolean;
  mode: PortMode;
  /** Untagged VLAN of an access port. */
  accessVlan?: number;
  /** Untagged VLAN of a trunk. */
  nativeVlan?: number;
  /** Tagged VLANs of a trunk. */
  allowedVlans: number[] | 'all';
  voiceVlan?: number;
  speed: Speed;
  duplex: Duplex;
  /** False when auto-negotiation is turned off. */
  autoneg: boolean;
  mtu?: number;
  /** False when power over Ethernet is turned off. */
  poe: boolean;
  qos: boolean;
  /** Spanning tree edge port (PortFast). */
  stpEdge: boolean;
  /** 0 when the number of MAC addresses is not limited. */
  macLimit: number;
  /** Learned MAC addresses are kept (sticky MAC, persistent learning). */
  persistMac: boolean;
  auth: PortAuth;
  /** Undefined when the port has no storm control. */
  stormControl?: StormControl;
  /**
   * With DHCP snooping: true when the port may face a DHCP server, false when it may not.
   * Undefined when the source says nothing: a trunk is then trusted and an access port is not.
   */
  dhcpTrusted?: boolean;
  /** Set on a physical port that is a member of a link aggregation. */
  lag?: LagMembership;
  /** On a link aggregation: false when it is static, without LACP. */
  lacp?: boolean;
  /** On a link aggregation: its number on a Juniper switch, 0 for ae0. */
  aeIndex?: number;
  /** Names of the interface ranges or groups that configure this port, for the name of its port usage. */
  groups: string[];
  /** The lines of the source that configure this port, as written. */
  lines: string[];
}

/** Storm control: the traffic that floods a VLAN is limited to a share of the bandwidth of the port. */
export interface StormControl {
  /** The limit, in percent of the bandwidth of the port. */
  percentage: number;
  /** The kinds of traffic that are limited. */
  broadcast: boolean;
  multicast: boolean;
  /** False when multicast is limited, except the groups that hosts have joined. */
  registeredMulticast: boolean;
  unknownUnicast: boolean;
  /** The port is shut down when the limit is passed. */
  shutdown: boolean;
}

export interface PortAuth {
  dot1x: boolean;
  macAuth: boolean;
  /** MAC authentication without 802.1X. */
  macAuthOnly: boolean;
  multipleSupplicants: boolean;
  /** Seconds between two authentications of a client. */
  reauthInterval?: number;
  /** VLAN of clients that do not answer 802.1X. */
  guestVlan?: number;
  /** VLAN of clients that arrive while no RADIUS server answers. */
  serverFailVlan?: number;
  /** VLAN of clients that the RADIUS server rejects. */
  serverRejectVlan?: number;
  /** Clients that were authenticated before stay connected while no RADIUS server answers. */
  bypassWhenServerDown: boolean;
  /** Every client is let in while no RADIUS server answers. */
  permitWhenServerDown: boolean;
}

export interface LagMembership {
  /** Name of the aggregated interface: Port-channel1, ae0. */
  name: string;
  /** False for a static aggregation ("mode on"). */
  lacp: boolean;
}

/* ----------------------------------------------------------------- system */

export interface System {
  dnsServers: string[];
  dnsSuffixes: string[];
  ntpServers: string[];
  syslogServers: SyslogServer[];
  banner?: string;
  radius: {
    auth: RadiusServer[];
    acct: RadiusServer[];
    /** Port for RADIUS change of authorization, when the device accepts it. */
    coaPort?: number;
  };
  tacacs: {
    auth: TacacsServer[];
    acct: TacacsServer[];
  };
}

export interface SyslogServer {
  host: string;
  protocol: string;
  port: number;
}

export interface RadiusServer {
  host: string;
  port: number;
  /** Seconds. */
  timeout: number;
}

export interface TacacsServer {
  host: string;
  port: number;
}

/* ------------------------------------------------------------ diagnostics */

export type Severity = 'info' | 'warning' | 'error';

/** One thing the user is told about the conversion. */
export interface Diagnostic {
  severity: Severity;
  /** Kind of message, stable across wordings: for tests and filters. */
  code: string;
  message: string;
  /** Name of the source file, or '' when the message is about the whole conversion. */
  file: string;
  /** Lines of the source file the message is about (1-based). */
  lines?: number[];
}

/* ---------------------------------------------------------------- helpers */

export function newDevice(file: string, vendor: Vendor): Device {
  return {
    file,
    vendor,
    vlans: [],
    ports: [],
    system: {
      dnsServers: [],
      dnsSuffixes: [],
      ntpServers: [],
      syslogServers: [],
      radius: { auth: [], acct: [] },
      tacacs: { auth: [], acct: [] },
    },
  };
}

/** A port with the settings of an interface that has no configuration. */
export function newPort(name: string, kind: PortKind): Port {
  return {
    name,
    kind,
    disabled: false,
    mode: 'access',
    allowedVlans: [],
    speed: 'auto',
    duplex: 'auto',
    autoneg: true,
    poe: true,
    qos: false,
    stpEdge: false,
    macLimit: 0,
    persistMac: false,
    auth: {
      dot1x: false,
      macAuth: false,
      macAuthOnly: false,
      multipleSupplicants: false,
      bypassWhenServerDown: false,
      permitWhenServerDown: false,
    },
    groups: [],
    lines: [],
  };
}

/** Adds a value to a list unless it is already there. */
export function addOnce<T>(list: T[], value: T, same: (a: T, b: T) => boolean = (a, b) => a === b): void {
  if (!list.some((existing) => same(existing, value))) list.push(value);
}
