/**
 * The part of a Mist switch template (network template) that the converter writes.
 * Field names are those of the Mist API.
 */

export interface MistTemplate {
  name: string;
  ntp_servers: string[];
  dns_servers: string[];
  dns_suffix: string[];
  /** Networks (VLANs) by name. */
  networks: Record<string, MistNetwork>;
  /** Port usages (port profiles) by name. */
  port_usages: Record<string, MistPortUsage>;
  radius_config: {
    acct_interim_interval: number;
    acct_servers: MistRadiusServer[];
    auth_servers: MistRadiusServer[];
    auth_servers_retries: number;
    auth_servers_timeout: number;
    coa_enabled: boolean;
    coa_port: number;
  };
  switch_mgmt: {
    cli_banner?: string;
    tacacs: {
      enabled: boolean;
      tacplus_servers: MistTacacsServer[];
      acct_servers: MistTacacsServer[];
    };
  };
  additional_config_cmds: string[];
  dhcp_snooping: {
    enabled: boolean;
    networks: string[];
  };
  remote_syslog: {
    enabled: boolean;
    servers: MistSyslogServer[];
  };
  switch_matching: {
    enabled: boolean;
    rules: MistSwitchRule[];
  };
  /** Present when a source file has SNMP. */
  snmp_config?: MistSnmpConfig;
}

/** SNMP of the switches. Mist describes it as Junos does. */
export interface MistSnmpConfig {
  enabled: boolean;
  contact?: string;
  description?: string;
  location?: string;
  engine_id_type?: 'use_mac_address';
  client_list?: Array<{ client_list_name: string; clients: string[] }>;
  views?: Array<{ view_name: string; oid: string; include: boolean }>;
  v2c_config?: Array<{ community_name: string; authorization: string; client_list_name?: string; view?: string }>;
  trap_groups?: Array<{ group_name: string; version: string; targets: string[]; categories: string[] }>;
  v3_config?: MistSnmpV3Config;
}

export interface MistSnmpV3Config {
  usm?: Array<{ engine_type: 'local_engine' | 'remote_engine'; remote_engine_id?: string; users: MistSnmpUser[] }>;
  vacm?: {
    security_to_group?: { security_model: string; content: Array<{ security_name: string; group: string }> };
    access?: Array<{ group_name: string; prefix_list: MistSnmpAccess[] }>;
  };
  notify?: Array<{ name: string; tag?: string; type: string }>;
  notify_filter?: Array<{ profile_name: string; contents: Array<{ oid: string; include: boolean }> }>;
  target_address?: Array<{ target_address_name: string; address: string; address_mask?: string; port: string; tag_list?: string; target_parameters?: string }>;
  target_parameters?: Array<{ name: string; message_processing_model?: string; security_model?: string; security_level?: string; security_name?: string; notify_filter?: string }>;
}

export interface MistSnmpUser {
  name: string;
  /** "authentication-sha", "authentication-none"... */
  authentication_type: string;
  authentication_password?: string;
  /** "privacy-aes128", "privacy-none"... */
  encryption_type: string;
  encryption_password?: string;
}

export interface MistSnmpAccess {
  type: 'default_context_prefix' | 'context_prefix';
  context_prefix?: string;
  security_model: string;
  security_level: string;
  read_view?: string;
  write_view?: string;
  notify_view?: string;
}

export interface MistNetwork {
  vlan_id: string;
  subnet: string | null;
}

export interface MistStormControl {
  /** True when broadcast is not limited. The same for the three that follow. */
  no_broadcast: boolean;
  no_multicast: boolean;
  no_registered_multicast: boolean;
  no_unknown_unicast: boolean;
  /** Percent of the bandwidth of the port. */
  percentage: number;
  /** The port is shut down when the limit is passed. */
  disable_port?: boolean;
}

export interface MistPortUsage {
  all_networks: boolean;
  disable_autoneg: boolean;
  disabled: boolean;
  duplex: string;
  speed: string;
  enable_mac_auth: boolean;
  enable_qos: boolean;
  mac_auth_only: boolean;
  mac_limit: number;
  mode: 'access' | 'trunk';
  mtu?: number;
  /** Tagged networks of a trunk, by name. */
  networks: string[];
  poe_disabled: boolean;
  port_auth?: 'dot1x';
  stp_edge: boolean;
  voip_network?: string;
  /** Untagged network, by name. */
  port_network?: string;
  persist_mac: boolean;
  guest_network?: string;
  bypass_auth_when_server_down: boolean;
  allow_multiple_supplicants?: boolean;
  /** Seconds. */
  reauth_interval?: number;
  server_fail_network?: string;
  server_reject_network?: string;
  storm_control?: MistStormControl;
  /** With DHCP snooping: whether a DHCP server may answer on the port. Absent: yes on a trunk, no on an access port. */
  allow_dhcpd?: boolean;
  bypass_auth_when_server_down_for_unknown_client?: boolean;
}

export interface MistRadiusServer {
  port: string;
  host: string;
  secret: string;
  timeout: number;
}

export interface MistTacacsServer {
  host: string;
  port: string;
  secret: string;
  timeout: number;
}

export interface MistSyslogServer {
  host: string;
  protocol: string;
  port: string;
  contents: Array<{ facility: string; severity: string }>;
}

export interface MistPortConfig {
  /** On a link aggregation without LACP. */
  ae_disable_lacp?: boolean;
  ae_idx?: number;
  aggregated?: boolean;
  description?: string;
  /** Name of a port usage. */
  usage: string;
}

/**
 * A rule gives its port configuration to the switches whose name starts with the
 * hostname of the source device: `"match_name[0:5]": "sw-01"`.
 */
export type MistSwitchRule = {
  name: string;
  /** Ports by Junos name. A link aggregation is under the names of its ports, joined by a comma. */
  port_config: Record<string, MistPortConfig>;
} & { [match: `match_name[${string}]`]: string };

/** Secrets are never copied from the source files. This is what the template has in their place. */
export const SECRET_PLACEHOLDER = 'to_be_replaced';

export function emptyTemplate(): MistTemplate {
  return {
    name: 'template_name',
    ntp_servers: [],
    dns_servers: [],
    dns_suffix: [],
    networks: {},
    port_usages: {},
    radius_config: {
      acct_interim_interval: 0,
      acct_servers: [],
      auth_servers: [],
      auth_servers_retries: 3,
      auth_servers_timeout: 5,
      coa_enabled: false,
      coa_port: 3799,
    },
    switch_mgmt: {
      tacacs: {
        enabled: false,
        tacplus_servers: [],
        acct_servers: [],
      },
    },
    additional_config_cmds: [],
    dhcp_snooping: {
      enabled: false,
      networks: [],
    },
    remote_syslog: {
      enabled: false,
      servers: [],
    },
    switch_matching: {
      enabled: false,
      rules: [],
    },
  };
}
