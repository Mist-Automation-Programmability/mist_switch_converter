import { Logger } from "../services/logger";
import { VlansElements, TermsElements, MistTemplateElement, ProfileConfigurationElement, SwitchMatchingRuleElement, SwitchMatchingRulePortConfigElement } from "./mist_template"
import { v4 as uuidv4 } from 'uuid';

export interface ParsedInterfaceData {
    file: string,
    hostname: string,
    interface_name: string,
    profile_id: string,
    profile_name: string,
    config_type: string,
    config_blocks: string[],
    description: string,
}

export interface ParsedProfileData {
    uuid: string,
    generated_name: string,
    descriptions: string[],
    interface_names: string[],
    interface_ranges: string[],
    config: ProfileConfigurationElement,
    config_string: string
}


export interface ParcedLagInterfacesData {
    [key: string]: {                    // file name
        [key: string]: {                // key is lag interface name,
            index: number,
            interfaces: string[],
        }
    }
}
export interface ParcedLagMembersData {
    [key: string]: string[],           // key is lag interface name, value is list of interfaces part of any lag
}

export class ConfigData {

    mist_template: MistTemplateElement;
    vlan_prefix = "vlan";
    syslog: string[] = [];
    radius_auth: string[] = [];
    radius_acct: string[] = [];
    radius_coa = {
        "coa_enabled": false,
        "coa_port": 3799
    }
    tacacs_auth: string[] = [];
    tacacs_acct: string[] = [];
    ntp: string[] = [];
    dns: string[] = [];
    domain: string[] = [];
    vlans: VlansElements = {};
    generated_vlan_names_used: string[] = [];
    cli_banner = "";
    dhcp_snooping_vlans: string[] = [];
    generated_profile_names_used: string[] = [];
    interfaces: ParsedInterfaceData[] = [];
    lag_interfaces: ParcedLagInterfacesData = {};
    lag_members: ParcedLagMembersData = {};
    profiles: ParsedProfileData[] = [];

    constructor(
        private _config_logger: Logger) {
        this.mist_template = {
            name: "template_name",
            ntp_servers: this.ntp,
            dns_servers: this.dns,
            dns_suffix: this.domain,
            networks: {},
            port_usages: {},
            radius_config: {
                acct_interim_interval: 0,
                acct_servers: [],
                auth_servers: [],
                auth_servers_retries: 3,
                auth_servers_timeout: 5,
                coa_enabled: false,
                coa_port: 3799
            },
            switch_mgmt: {
                cli_banner: undefined,
                tacacs: {
                    enabled: false,
                    tacplus_servers: [],
                    acct_servers: []
                }
            },
            additional_config_cmds: [],
            dhcp_snooping: {
                enabled: false,
                networks: []
            },
            remote_syslog: {
                enabled: false,
                servers: []
            },
            switch_matching: {
                enabled: false,
                rules: []
            }
        }
    };

    /************************* SUBNET ************************/
    private address_to_number(addr: string): number {
        return addr.split(".").reduce((acc, cur, i) => acc += (Number(cur) << ((3 - i) * 8)), 0)
    }

    private mask_to_number(mask: string): number {
        return (0xffffffff << (32 - Number(mask))) & 0xffffffff;
    }
    private number_to_addr(num: number): string {
        return `${(num >> 24) & 0xff}.${(num >> 16) & 0xff}.${(num >> 8) & 0xff}.${num & 0xff}`
    }
    calculate_cidr(cidr: string): string | null {
        var address, mask;
        var subnet_number;
        if (cidr.includes("/")) {
            [address, mask] = cidr.trim().split("/");
        } else if (cidr.trim().includes(" ")) {
            [address, mask] = cidr.trim().split(" ");
            mask = ((mask.split('.').map(Number)
                .map(part => (part >>> 0).toString(2))
                .join('')).split('1').length - 1).toString();
        } else {
            return null
        }
        subnet_number = this.address_to_number(address) & this.mask_to_number(mask);
        return this.number_to_addr(subnet_number) + "/" + mask;
    }

    /************************* VLANS *************************/
    add_vlan(vlan: string | undefined = undefined, vlans: string[] | undefined = undefined) {
        if (vlan && !this.vlans.hasOwnProperty(vlan)) this.vlans[vlan] = { "names": [this.vlan_prefix + vlan], "subnets": [] };
        if (vlans) vlans.forEach(vlan => {
            if (vlan && !this.vlans.hasOwnProperty(vlan)) this.vlans[vlan] = { "names": [this.vlan_prefix + vlan], "subnets": [] };
        })
    }

    get_vlan(vlan_id: string | undefined, filename: string = "") {
        if (vlan_id != undefined) {
            try {
                if (this.vlans.hasOwnProperty(vlan_id)) return this.vlans[vlan_id].names[0];
                // else {
                //     this._config_logger.error("unable to find vlan name for vlan_id " + vlan_id, filename);
                //     console.error(this.vlans);
                // }
            } catch {
                this._config_logger.error("error when trying to get vlan name for vlan_id " + vlan_id, filename);
                console.error(this.vlans);
            }
        }
        return undefined;
    }

    add_dhcp_snooping_vlan(vlan_id: string, filename: string = "") {
        if (!this.dhcp_snooping_vlans.includes(vlan_id)) {
            this._config_logger.info("DHCP Snooping: Adding VLAN " + vlan_id, filename);
            this.dhcp_snooping_vlans.push(vlan_id);
        }
    }

    /************************* SYSLOG *************************/
    add_syslog(syslog_ip: string, syslog_proto: string, syslog_port: string, filename: string = "") {
        var new_syslog: string = JSON.stringify({
            "host": syslog_ip, "protocol": syslog_proto, "port": syslog_port, "contents": [
                {
                    "facility": "any",
                    "severity": "any"
                }
            ]
        })
        if (!this.syslog.includes(new_syslog)) {
            this._config_logger.info("SYSLOG servers: Adding " + syslog_ip + " " + syslog_proto + ":" + syslog_port, filename);
            this.syslog.push(new_syslog);
        }
    }

    /************************* DOMAIN/DNS/NTP *************************/
    add_domain(new_domain: string, filename: string = "") {
        if (!this.domain.includes(new_domain)) {
            this._config_logger.info("DNS DOMAINs: Adding " + new_domain, filename);
            this.domain.push(new_domain);
        }
    }

    add_dns(new_dns: string, filename: string = "") {
        if (!this.dns.includes(new_dns)) {
            this._config_logger.info("NTP servers: Adding " + new_dns, filename);
            this.dns.push(new_dns);
        }
    }

    add_ntp(new_ntp: string, filename: string = "") {
        if (!this.ntp.includes(new_ntp)) {
            this._config_logger.info("NTP servers: Adding " + new_ntp, filename);
            this.ntp.push(new_ntp);
        }
    }

    /************************* TACACS *************************/
    add_tacacs_auth(tacacs_ip: string, tacacs_port: string, filename: string = "") {
        var tmp = JSON.stringify({
            "host": tacacs_ip,
            "port": tacacs_port,
            // deepcode ignore HardcodedNonCryptoSecret: not a real secret...
            "secret": "to_be_replaced",
            "timeout": 10
        })
        if (!this.tacacs_auth.includes(tmp)) {
            this._config_logger.info("TACACS+ Auth servers: Adding " + tacacs_ip + ":" + tacacs_port, filename);
            this.tacacs_auth.push(tmp);
        }
    }
    add_tacacs_acct(tacacs_ip: string, tacacs_port: string, filename: string = "") {
        var tmp = JSON.stringify({
            "host": tacacs_ip,
            "port": tacacs_port,
            // deepcode ignore HardcodedNonCryptoSecret: not a real secret...
            "secret": "to_be_replaced",
            "timeout": 10
        })
        if (!this.tacacs_acct.includes(tmp)) {
            this._config_logger.info("TACACS+ Acct servers: Adding " + tacacs_ip + ":" + tacacs_port, filename);
            this.tacacs_acct.push(tmp);
        }
    }

    /************************* RADIUS *************************/
    add_radius_auth(radius_ip: string, radius_port: string, radius_timeout: number = 5, filename: string = "") {
        var tmp = JSON.stringify({
            "port": radius_port,
            "host": radius_ip,
            // deepcode ignore HardcodedNonCryptoSecret: not a real secret...
            "secret": "to_be_replaced",
            "timeout": radius_timeout
        })
        if (!this.radius_auth.includes(tmp)) {
            this._config_logger.info("RADIUS Auth servers: Adding " + radius_ip + ":" + radius_port, filename);
            this.radius_auth.push(tmp);
        }
    }

    add_radius_acct(radius_ip: string, radius_port: string, radius_timeout: number = 5, filename: string = "") {
        var tmp = JSON.stringify({
            "port": radius_port,
            "host": radius_ip,
            // deepcode ignore HardcodedNonCryptoSecret: not a real secret...
            "secret": "to_be_replaced",
            "timeout": radius_timeout
        })
        if (!this.radius_auth.includes(tmp)) {
            this._config_logger.info("RADIUS Acct servers: Adding " + radius_ip + ":" + radius_port, filename);
            this.radius_auth.push(tmp);
        }
    }

    add_radius_coa(radius_coa_port: string, filename: string = "") {
        const port: number = Number(radius_coa_port);
        if (port && port > 0) {
            this.radius_coa = {
                "coa_enabled": true,
                "coa_port": port
            }
            this._config_logger.info("RADIUS CoA enabled on port " + port, filename);
        }
    }

    /************************* INTERFACES *************************/
    add_interface(file: string, hostname: string, interface_name: string, profile_id: string, config_type: string, config_blocks: string[], description: string): void {
        this.interfaces.push({
            file: file,
            hostname: hostname,
            interface_name: interface_name,
            profile_id: profile_id,
            profile_name: "",
            config_type: config_type,
            config_blocks: config_blocks,
            description: description
        })
    }

    add_lag_interface(file: string, lag_interface: string, lag_name: string) {
        if (!this.lag_interfaces.hasOwnProperty(file)) this.lag_interfaces[file] = {};
        if (!this.lag_interfaces[file].hasOwnProperty(lag_name)) {
            this.lag_interfaces[file][lag_name] = {
                index: Object.keys(this.lag_interfaces[file]).length,
                interfaces: []
            };
        }
        this.lag_interfaces[file][lag_name].interfaces.push(lag_interface)
        if (!this.lag_members.hasOwnProperty(file)) this.lag_members[file] = [];
        this.lag_members[file].push(lag_interface);
    }

    /************************* PORT PROFILE *************************/
    add_profile(interface_config: ProfileConfigurationElement, interface_name: string, description: string, interface_ranges: string[], filename: string = ""): string {
        var interface_config_string = JSON.stringify(interface_config);
        var profile = this.profiles.find(p => p.config_string == interface_config_string);
        if (profile) {
            profile.interface_names.push(interface_name);
            if (description && !profile.descriptions.includes(description)) profile.descriptions.push(description);
            interface_ranges.forEach((range_name: string) => {
                if (!profile?.interface_ranges.includes(range_name)) profile?.interface_ranges.push(range_name);
            })
            return profile.uuid;
        } else {
            var uuid: string = uuidv4();
            var new_profile: ParsedProfileData = {
                uuid: uuid,
                generated_name: "",
                descriptions: [description],
                interface_names: [interface_name],
                interface_ranges: interface_ranges,
                config: interface_config,
                config_string: interface_config_string
            }
            this._config_logger.info("New port profile added " + uuid, filename);
            this.profiles.push(new_profile)
            return uuid
        }
    }

    cisco_split(i: string): string {
        var j: string[] = i.split("/");
        var fpc: number = 0;
        var pic: number = 0;
        var port: number = 0;
        if (j.length == 3) {
            fpc = Number(j[0]) - 1;
            pic = Number(j[1]);
            port = Number(j[2]) - 1;
        } else if (j.length == 2) {
            fpc = Number(j[0]);
            port = Number(j[1]) - 1;
        } else {
            port = Number(j[0]) - 1;
        }
        return fpc + "/" + pic + "/" + port;
    }
    inteface_name_converter(interface_name: string): string {
        var junos_interface_array: string[] = [];
        interface_name.split(",").forEach((iname: string) => {
            if (iname.startsWith("FastEthernet")) {
                junos_interface_array.push('fe-' + this.cisco_split(iname.replace("FastEthernet", "")));
            } else if (iname.startsWith("GigabitEthernet")) {
                junos_interface_array.push('ge-' + this.cisco_split(iname.replace("GigabitEthernet", "")));
            } else if (iname.startsWith("TenGigabitEthernet")) {
                junos_interface_array.push('mge-' + this.cisco_split(iname.replace("TenGigabitEthernet", "")));
            } else if (iname.startsWith("TwentyFiveGigE")) {
                junos_interface_array.push('et-' + this.cisco_split(iname.replace("TwentyFiveGigE", "")));
            } else if (iname.startsWith("FortyGigabitEthernet")) {
                junos_interface_array.push('et-' + this.cisco_split(iname.replace("FortyGigabitEthernet", "")));
            } else if (iname.startsWith("AppGigabitEthernet")) {
                junos_interface_array.push('ge-' + this.cisco_split(iname.replace("AppGigabitEthernet", "")));
            } else {
                junos_interface_array.push(iname);
            }
        })
        return junos_interface_array.join(",");
    }

    switch_rule_port_config(interface_name: string, hostname: string, port_config: SwitchMatchingRulePortConfigElement, rules: SwitchMatchingRuleElement[]) {
        var switch_rule: SwitchMatchingRuleElement
        var switch_name = hostname;
        var switch_rule_index = rules.findIndex(i => i.name == switch_name);
        var juno_interface_name = this.inteface_name_converter(interface_name);
        if (switch_rule_index < 0) {
            var match_name = "match_name[0:" + switch_name.length + "]";
            switch_rule = {
                name: switch_name,
                port_config: {
                    [juno_interface_name]: port_config
                },
                [match_name]: switch_name,
            }
            rules.push(switch_rule);
        } else {
            rules[switch_rule_index].port_config[juno_interface_name] = port_config
        }
    }

    private is_in_lag(filename: string, interface_name: string) {
        if (!this.lag_members[filename]) {
            return false;
        } else if (!this.lag_members[filename].includes(interface_name)) {
            return false;
        }
        return true;
    }
    private is_a_lag(filename: string, interface_name: string) {
        if (!this.lag_interfaces[filename]) {
            return false;
        } else if (!this.lag_interfaces[filename].hasOwnProperty(interface_name)) {
            return false;
        }
        return true;
    }
    private is_excluded(interface_name: string) {
        if (interface_name.startsWith("ge-168/5/")) {
            return true;
        } else if (interface_name.startsWith("vlan")) {
            return true;
        }
        return false;
    }

    add_switch_rules() {
        var rules: SwitchMatchingRuleElement[] = [];
        this.interfaces.forEach((interface_data: ParsedInterfaceData) => {
            var interface_name = interface_data.interface_name;
            var interface_description: string | undefined;
            if (interface_data.description != "") interface_description = interface_data.description;
            if (this.is_a_lag(interface_data.file, interface_name)) {
                var ae_index: number = this.lag_interfaces[interface_data.file][interface_name].index;
                if (interface_name.startsWith("ae") && interface_name.length == 3) {
                    try {
                        ae_index = Number(interface_name.replace("ae", ""));
                    } catch {
                        console.log("test");
                    }
                } else if (interface_name.startsWith("Port-channel")) {
                    try {
                        ae_index = Number(interface_name.replace("Port-channel", "")) - 1;
                    } catch {
                        console.log("test");
                    }
                }
                var lag_intefaces: string = this.lag_interfaces[interface_data.file][interface_name].interfaces.join(",");
                var port_config: SwitchMatchingRulePortConfigElement = {
                    ae_disable_lacp: undefined,
                    ae_idx: ae_index,
                    ae_lacp_slow: undefined,
                    aggregated: true,
                    description: interface_description,
                    usage: interface_data.profile_name
                }
                this.switch_rule_port_config(lag_intefaces, interface_data.hostname, port_config, rules);
            } else if (!this.is_excluded(interface_name) && !this.is_in_lag(interface_data.file, interface_name)) {
                var port_config: SwitchMatchingRulePortConfigElement = {
                    ae_disable_lacp: undefined,
                    ae_idx: undefined,
                    ae_lacp_slow: undefined,
                    aggregated: undefined,
                    description: interface_description,
                    usage: interface_data.profile_name
                }
                this.switch_rule_port_config(interface_name, interface_data.hostname, port_config, rules);
            }
        })
        this.mist_template.switch_matching = {
            enabled: true,
            rules: rules
        }
    }

    /************************* PROFILE NAMES *************************/
    private update_interface_profile_name(uuid: string, name: string) {
        this.interfaces.filter(i => i.profile_id == uuid).forEach((interface_data: ParsedInterfaceData) => {
            interface_data.profile_name = name;
        })
    }

    private generate_unique_name(profile_name: string, profile: ParsedProfileData) {
        var i: number = 0;
        while (this.generated_profile_names_used.includes(profile_name)) {
            profile_name = profile_name.substring(0, 27) + "-" + profile.uuid.replace(/-/g, "").substring(0 + i, 4 + i);
        }
        return profile_name;
    }

    async generate_profile_names() {
        this.profiles.forEach((profile: ParsedProfileData) => {
            var profile_name: string = "profile";
            if (profile.interface_ranges.length > 0) profile_name = profile.interface_ranges.join("_");
            else if (profile.descriptions.length == 1 && profile.descriptions[0]) profile_name = profile.descriptions[0];
            else if (profile.descriptions.length > 1) {
                this._config_logger.warning("Mutliple entries found profile " + profile.uuid + ": " + profile.descriptions.toString());
                var terms: TermsElements = {};
                var max_occurence: number = -1;
                var description_terms: string[] = [];
                profile.descriptions.forEach(description => {
                    description.split(/ |_|-|:|,/).forEach(desc_term => {
                        var term = desc_term.toLowerCase().replace(/[ &:\*\"\(\)-]/g, "").trim();
                        if (!["null", "-", ""].includes(term)) {
                            if (!terms.hasOwnProperty(term)) {
                                terms[term] = 1;
                            } else {
                                terms[term] += 1;
                            }
                            // note if the term is present for 
                            if (terms[term] > max_occurence) max_occurence = terms[term];
                        }
                    })
                })
                for (let [key, value] of Object.entries(terms)) {
                    if (value == max_occurence) {
                        description_terms.push(key);
                    }
                }
                profile_name = description_terms.join(" ").replace(/\s+/g, "_").substring(0, 31);
            }

            profile_name = profile_name.toLowerCase().replace(/^\W+/, "").replace(/\W+$/, "").trim().replace(/[ &:\*\"\-,]+/g, "_").substring(0, 31);
            profile_name = this.generate_unique_name(profile_name, profile);
            this._config_logger.info("Profile name \"" + profile_name + "\" assigned to profile " + profile.uuid);
            profile.generated_name = profile_name;
            this.generated_profile_names_used.push(profile_name);
            this.update_interface_profile_name(profile.uuid, profile_name);
            this.add_switch_rules();
        })
    }

    async generate_template() {
        for (var vlan_id in this.vlans) {
            if (this.vlans[vlan_id].names.length == 0) {
                var vlan_name = "vlan" + vlan_id;
                this._config_logger.warning("VLAN " + vlan_id + " has doesn't have name. Generating one: \"" + vlan_name + "\"");
                this.vlans[vlan_id].names.push(vlan_name);
            } else if (this.vlans[vlan_id].names.length > 1) this._config_logger.warning("VLAN " + vlan_id + " has multiple names. Using the first one: \"" + this.vlans[vlan_id].names[0] + "\"")

            if (this.vlans[vlan_id].subnets.length > 1) this._config_logger.warning("VLAN " + vlan_id + " has multiple subnets (" + this.vlans[vlan_id].subnets + "). Using the first one: \"" + this.vlans[vlan_id].subnets[0] + "\"")

            if (this.vlans[vlan_id].subnets.length > 0) {
                this.mist_template.networks[this.vlans[vlan_id].names[0]] = { "vlan_id": vlan_id, "subnet": this.vlans[vlan_id].subnets[0] };
            } else {
                this.mist_template.networks[this.vlans[vlan_id].names[0]] = { "vlan_id": vlan_id, "subnet": null };
            }

        }
        this.profiles.forEach((profile: ParsedProfileData) => {
            this.mist_template.port_usages[profile.generated_name] = profile.config;
        })
        this.radius_auth.forEach((radius_auth: string) => {
            this.mist_template.radius_config.auth_servers.push(JSON.parse(radius_auth));
        })
        this.radius_acct.forEach((radius_acct: string) => {
            this.mist_template.radius_config.acct_servers.push(JSON.parse(radius_acct));
        })
        if (this.tacacs_auth.length > 0) {
            this.mist_template.switch_mgmt.tacacs.enabled = true;
            this.tacacs_auth.forEach((tacplus_server: string) => {
                this.mist_template.switch_mgmt.tacacs.tacplus_servers.push(JSON.parse(tacplus_server))
            })
            this.tacacs_acct.forEach((tacplus_server: string) => {
                this.mist_template.switch_mgmt.tacacs.acct_servers.push(JSON.parse(tacplus_server))
            })
        }
        if (this.cli_banner.length > 0) {
            this.mist_template.switch_mgmt.cli_banner = this.cli_banner.replace('"', '\"').replace("'", '\'').replace(/\\n/g, "\n");
        }
        if (this.dhcp_snooping_vlans.length > 0) {
            this.mist_template.dhcp_snooping.enabled = true;
            this.dhcp_snooping_vlans.forEach((vlan_id: string) => {
                if (this.vlans.hasOwnProperty(vlan_id)) this.mist_template.dhcp_snooping.networks.push(this.vlans[vlan_id].names[0]);
            })
        }
        if (this.syslog.length > 0) {
            this.mist_template.remote_syslog.enabled = true;
            this.syslog.forEach((syslog: string) => {
                this.mist_template.remote_syslog.servers.push(JSON.parse(syslog));
            })
        }
    }
}