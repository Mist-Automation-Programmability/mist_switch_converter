import { Logger } from "../services/logger";
import { VlansElements, TermsElements, MistTemplateElement, ProfileConfigurationElement, SyslogElement, TacacsElement } from "./mist_template"
import { v4 as uuidv4 } from 'uuid';

export interface ParsedInterfaceData {
    file: string,
    hostname: string,
    interface_name: string,
    profile_id: string,
    profile_name: string,
    config_type: string,
    config_blocks: string[]
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
    banner = "";
    dhcp_snooping_vlans: string[] = [];
    generated_profile_names_used: string[] = [];
    interfaces: ParsedInterfaceData[] = [];
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
            }
        }
    };

    /************************* VLANS *************************/
    add_vlan(vlan: string | undefined = undefined, vlans: string[] | undefined = undefined) {
        if (vlan && !this.vlans.hasOwnProperty(vlan)) this.vlans[vlan] = [this.vlan_prefix + vlan];
        if (vlans) vlans.forEach(vlan => {
            if (vlan && !this.vlans.hasOwnProperty(vlan)) this.vlans[vlan] = [this.vlan_prefix + vlan];
        })
    }

    get_vlan(vlan_id: string | undefined, filename: string = "") {
        if (vlan_id != undefined) {
            try {
                if (this.vlans.hasOwnProperty(vlan_id)) return this.vlans[vlan_id][0];
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
    add_interface(file: string, hostname: string, interface_name: string, profile_id: string, config_type: string, config_blocks: string[]): void {
        this.interfaces.push({
            file: file,
            hostname: hostname,
            interface_name: interface_name,
            profile_id: profile_id,
            profile_name: "",
            config_type: config_type,
            config_blocks: config_blocks
        })
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

    /************************* PROFILE NAMES *************************/
    private update_interface_profile_name(uuid: string, name: string) {
        this.interfaces.filter(i => i.profile_id == uuid).forEach((interface_data: ParsedInterfaceData) => {
            interface_data.profile_name = name;
        })
    }

    private generate_unique_name(profile_name:string, profile: ParsedProfileData) {
        var i:number = 0;
        while (this.generated_profile_names_used.includes(profile_name)) {
            profile_name = profile_name.substring(0,27) + "-" + profile.uuid.replace(/-/g,"").substring(0+i,4+i);
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
        })
    }

    async generate_template() {
        for (var vlan_id in this.vlans) {
            if (this.vlans[vlan_id].length > 1) this._config_logger.warning("VLAN " + vlan_id + " has multiple names. Using the first one: \"" + this.vlans[vlan_id][0] + "\"")
            this.mist_template.networks[this.vlans[vlan_id][0]] = { "vlan_id": vlan_id };
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
        if (this.banner.length > 0) {
            var banner_already_configured: boolean = false;
            for (let line of this.banner ! ) {
                if (line.startsWith("set groups banner system login message")) {
                    banner_already_configured = true;
                    break;
                }
            }
            if (!banner_already_configured) {
                this.mist_template.additional_config_cmds.push("set groups banner system login message \"" + this.banner.replace('"', '\\\"').replace("'", '\\\'') + "\"");
                this.mist_template.additional_config_cmds.push("set apply-groups banner");
            }
        }
        if (this.dhcp_snooping_vlans.length > 0) {
            this.mist_template.dhcp_snooping.enabled = true;
            this.dhcp_snooping_vlans.forEach((vlan_id: string) => {
                if (this.vlans.hasOwnProperty(vlan_id)) this.mist_template.dhcp_snooping.networks.push(this.vlans[vlan_id][0]);
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