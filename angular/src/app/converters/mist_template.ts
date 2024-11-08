export interface MistTemplateElement {
    name: string,
    ntp_servers: object,
    dns_servers: string[],
    dns_suffix: string[],
    networks: {
        [key: string]: {
            vlan_id: string | number
            subnet: string | null
        }
    },
    port_usages: {
        [key: string]: ProfileConfigurationElement
    },
    radius_config: {
        acct_interim_interval: number,
        acct_servers: object[],
        auth_servers: object[],
        auth_servers_retries: number,
        auth_servers_timeout: number,
        coa_enabled: boolean,
        coa_port: number
    },
    switch_mgmt: {
        cli_banner: string | undefined,
        tacacs: {
            enabled: boolean,
            tacplus_servers: object[],
            acct_servers: object[]
        },
    },
    additional_config_cmds: string[],
    dhcp_snooping: {
        enabled: boolean,
        networks: string[]
    },
    remote_syslog: {
        enabled: boolean,
        servers: object[]
    },
    switch_matching: {
        enabled: boolean,
        rules: SwitchMatchingRuleElement[]
    }
}

export interface SwitchMatchingRuleElement {
    name: string,
    port_config: {
        [key: string]: SwitchMatchingRulePortConfigElement
    },
    additional_properties?: { [key: string]: string };
}

export interface SwitchMatchingRulePortConfigElement {
    ae_disable_lacp: boolean | undefined,
    ae_idx: number | undefined,
    ae_lacp_slow: boolean | undefined,
    aggregated: boolean | undefined,
    description: string | undefined,
    usage: string,
}

export interface ProfileConfigurationElement {
    all_networks: boolean,
    disable_autoneg: boolean,
    disabled: boolean,
    duplex: string | undefined,
    speed: string | undefined,
    enable_mac_auth: boolean,
    enable_qos: boolean,
    mac_auth_only: boolean,
    mac_limit: number | undefined,
    guest_network: string | undefined,
    mode: string | undefined,
    mtu: string | undefined,
    poe_disabled: boolean,
    port_auth: string | undefined,
    stp_edge: boolean,
    networks: string[] | undefined,
    rejected_network: string | undefined,
    port_network: string | undefined,
    voip_network: string | undefined,
    persist_mac: boolean,
    bypass_auth_when_server_down: boolean,
}

export interface VlansElements {
    [key: string]: {
        names: string[],
        subnets: string[]
    }
}

export interface TermsElements {
    [key: string]: number
}

export interface SyslogElement {
    ip: string,
    protocol: string,
    port: string
}

export interface TacacsElement {
    host: string,
    port: string,
    secret: string,
    timeout: number
}

export interface VlanMapping {
    [key: string]: string
}