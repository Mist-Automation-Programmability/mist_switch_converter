import { IosParser } from "./ios_parser";
import { Logger } from "../services/logger";
import { VlansInterface, TermsInterface, MistTemplateInterface } from "./mist_template"


export interface ConfigFile {
    name: string,
    config: string[],
    format: string ,
    success_vlan: boolean | undefined,
    success_config: boolean | undefined,
    error_message: string
}

export interface ConfigData {
    vlan_prefix: string;
    syslog: string[];
    radius_auth: string[];
    radius_acct: string[];
    tacacs: string[];
    ntp: string[];
    dns: string[];
    domain: string[];
    vlans: VlansInterface;
    banner: string;
    dhcp_snooping_vlans: string[];
    port_profile_configs: string[];
    port_profile_names: string[];
    all_port_profile_names: string[];
    port_descriptions: string[][];

}

export class ConfigParser {
    ios_config: string[];
    mist_template: MistTemplateInterface;
    config_data: ConfigData = {
        vlan_prefix : "vlan",
        syslog : [],
        radius_auth : [],
        radius_acct : [],
        tacacs : [],
        ntp : [],
        dns : [],
        domain : [],
        vlans : {},
        banner : "",
        dhcp_snooping_vlans : [],
        port_profile_configs : [],
        port_profile_names : [],
        all_port_profile_names : [],
        port_descriptions : [],
    }
    process_done: boolean = false;

    ios_parser = new IosParser(this._logger, this.config_data);
    constructor(
        private _logger: Logger
    ) {
        this.mist_template = {
            name: "template_name",
            ntp_servers: this.config_data.ntp,
            dns_servers: this.config_data.dns,
            dns_suffix: this.config_data.domain,
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
                    tacplus_servers: []
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
    }


    /////////////////////////////////////////////////////////////////

    async generate_profile_names() {
        for (var i = 0; i < this.config_data.port_descriptions.length; i++) {
            if (this.config_data.port_descriptions[i].length == 1) {
                var profile_name = this.config_data.port_descriptions[i][0];
                if (this.config_data.all_port_profile_names.includes(profile_name)) {
                    profile_name = profile_name + "_" + [i];
                }
                const pname = profile_name.toLowerCase().replace(/[ &-:]+/g, "_").substring(0, 31);
                this.config_data.port_profile_names[i] = pname;
            } else {
                this._logger.warning("Mutliple entries found for this profile: " + this.config_data.port_descriptions[i].toString());
                var terms: TermsInterface = {};
                var max_occurence: number = -1;
                var description_terms: string[] = [];
                this.config_data.port_descriptions[i].forEach(description => {
                    description.split(" ").forEach(desc_term => {
                        var term = desc_term.toLowerCase().trim().replace("(", "").replace(")", "");
                        if (!["null", "-", ""].includes(term)) {
                            if (!terms.hasOwnProperty(term)) {
                                terms[term] = 1;
                            } else {
                                terms[term] += 1;
                            }
                            if (terms[term] > max_occurence) max_occurence = terms[term];
                        }
                    })
                })
                for (let [key, value] of Object.entries(terms)) {
                    if (value == max_occurence) {
                        description_terms.push(key);
                    }
                }
                const pname = description_terms.join(" ").replace(/\s+/g, "_").substring(0, 31);
                this._logger.info("Profile name generated: " + pname);
                this.config_data.port_profile_names[i] = pname;
            }
        }
    }

    async generate_template() {
        for (var vlan_id in this.config_data.vlans) {
            if (this.config_data.vlans[vlan_id].length > 1) this._logger.warning("WARNING: VLAN " + vlan_id + " has multiple names. Using the first one...")
            this.mist_template.networks[this.config_data.vlans[vlan_id][0]] = { "vlan_id": vlan_id };
        }
        // this.vlans.forEach((vlan_id:string)=>{
        //     this.mist_template["networks"][vlan_prefix+vlan_id] = {"vlan_id": vlan_id};
        // })
        for (var i: number = 0; i < this.config_data.port_profile_names.length; i++) {
            this.mist_template.port_usages[this.config_data.port_profile_names[i]] = JSON.parse(this.config_data.port_profile_configs[i]);
        }
        this.config_data.radius_auth.forEach((radius_auth: string) => {
            this.mist_template.radius_config.auth_servers.push(JSON.parse(radius_auth));
        })
        this.config_data.radius_acct.forEach((radius_acct: string) => {
            this.mist_template.radius_config.acct_servers.push(JSON.parse(radius_acct));
        })
        if (this.config_data.tacacs.length > 0) {
            this.mist_template.switch_mgmt.tacacs.enabled = true;
            this.config_data.tacacs.forEach((tacplus_server: string) => {
                this.mist_template.switch_mgmt.tacacs.tacplus_servers.push(JSON.parse(tacplus_server))
            })
        }
        if (this.config_data.banner.length > 0) {
            var banner_already_configured: boolean = false;
            for (let line of this.mist_template.additional_config_cmds) {
                if (line.startsWith("set groups banner system login message")) {
                    banner_already_configured = true;
                    break;
                }
            }
            if (!banner_already_configured) {
                this.mist_template.additional_config_cmds.push("set groups banner system login message \"" + this.config_data.banner.replace('"', '\\\"').replace("'", '\\\'') + "\"");
                this.mist_template.additional_config_cmds.push("set apply-groups banner");
            }
        }
        if (this.config_data.dhcp_snooping_vlans.length > 0) {
            this.mist_template.dhcp_snooping.enabled = true;
            this.config_data.dhcp_snooping_vlans.forEach((vlan_id: string) => {
                if (this.config_data.vlans.hasOwnProperty(vlan_id)) this.mist_template.dhcp_snooping.networks.push(this.config_data.vlans[vlan_id][0]);
            })
        }
        if (this.config_data.syslog.length > 0) {
            this.mist_template.remote_syslog.enabled = true;
            this.config_data.syslog.forEach((syslog: string) => {
                this.mist_template.remote_syslog.servers.push(JSON.parse(syslog));
            })
        }
        this.process_done = true;
    }
    /////////////////////////////////////////////////////////////////

    private process_config(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            if (config_file.format == "Cisco") {
                this.ios_parser.process_config(config_file).then((res) => resolve(res));
            }
            else resolve(false);
        })
    }

    private process_vlans(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            if (config_file.format == "Cisco") {
                this.ios_parser.process_vlans(config_file).then((res) => resolve(res));
            }
            else resolve(false);
        })
    }


    private read_vlans_all(config_files: ConfigFile[]): Promise<boolean> {
        this._logger.info("Reading VLANs from config files started");
        return new Promise((resolve) => {
            var i = 0;
            config_files.forEach((config_file: ConfigFile) => {
                this.process_vlans(config_file).then((res) => {
                    if (!res) this._logger.error("Error when reading VLANs list from " + config_file.name)
                    i++;
                    if (i == config_files.length) {
                        resolve(true);
                    }
                });
            })
        })
    }

    private read_config_all(config_files: ConfigFile[]): Promise<boolean> {
        this._logger.info("Reading configuration from config files started");
        return new Promise((resolve) => {
            var i = 0;
            config_files.forEach((config_file: ConfigFile) => {
                this.process_config(config_file).then((res) => {
                    if (!res) this._logger.error("Error when reading configuration list from " + config_file.name)
                    i++;
                    if (i == config_files.length) {
                        resolve(true);
                    }
                });
            })
        })
    }
    private detect_source_all(config_files: ConfigFile[]): Promise<boolean> {
        return new Promise((resolve) => {
            config_files.forEach((file: ConfigFile) => {
                this._logger.info("Detecting type of file for "+file.name);
                file.config.forEach((line: string) => {
                    if (line.startsWith("Current configuration")) file.format = "Cisco";
                    else if (line.startsWith("set version")) file.format = "Juniper";
                })
                this._logger.info(file.name+" is detected as "+ file.format+" type");
            })
            resolve(true)
        })
    }


    detect_source(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            config_file.config.forEach((line: string) => {
                if (line.startsWith("Current configuration")) {
                    config_file.format = "Cisco";
                    resolve(true)
                }
                else if (line.startsWith("set version")) {
                    config_file.format = "Juniper"
                    resolve(true)
                };
            })
            resolve(false);
        })
    }

    read_vlans(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            this.process_vlans(config_file).then((res) => {
                if (!res) this._logger.error("Error when reading VLANs list from " + config_file.name)
                config_file.success_vlan = res;
                resolve(res);
            });
        })
    }

    read_config(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
                this.process_config(config_file).then((res) => {
                    if (!res) this._logger.error("Error when reading configuration list from " + config_file.name)
                    resolve(res);
                });
        })
    }

    auto_convert(config_files: ConfigFile[]): Promise<MistTemplateInterface> {
        return new Promise((resolve) => {
            var i = 0;
            this.detect_source_all(config_files).then((res) => {
                this.read_vlans_all(config_files).then((res) => {
                    this.read_config_all(config_files).then((res) => {
                        this.generate_profile_names();
                        this.generate_template();
                        resolve(this.mist_template)
                    })
                })
            })
        })
    }

}