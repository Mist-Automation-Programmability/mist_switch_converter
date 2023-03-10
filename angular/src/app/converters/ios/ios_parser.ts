import { Vlans, Terms, ProfileConfiguration, MistTemplate } from "../mist_template"
import { Logger } from "./../../services/logger";



export class IosParser {
    vlan_prefix: string;
    syslog: string[];
    radius_auth: string[];
    radius_acct: string[];
    tacacs: string[];
    ntp: string[];
    dns: string[];
    domain: string[];
    vlans: Vlans;
    banner: string;
    dhcp_snooping_vlans: string[];
    port_profile_configs: string[];
    port_profile_names: string[];
    all_port_profile_names: string[];
    ios_descriptions: string[][];
    ios_config: string[];
    vlan_ids_to_exclude: string[];
    mist_template: MistTemplate;

    constructor(
        private _logger: Logger
    ) {
        this.vlan_prefix = "vlan";
        this.syslog = [];
        this.radius_auth = [];
        this.radius_acct = [];
        this.tacacs = [];
        this.ntp = [];
        this.dns = [];
        this.domain = [];
        this.vlans = {};
        this.banner = "";
        this.dhcp_snooping_vlans = [];
        this.port_profile_configs = [];
        this.port_profile_names = [];
        this.all_port_profile_names = [];
        this.ios_descriptions = [];
        this.ios_config = [];
        this.vlan_ids_to_exclude = ["1002", "1003", "1004", "1005"];
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

    parse_config(config: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            var config_block: string[] = [];
            var config_type: string | undefined = undefined;
            config.forEach((line: string) => {
                if (config_type == "banner" && !line.startsWith("^C")) {
                    config_block.push(line);
                } else if (config_type && line.startsWith(" ")) {
                    config_block.push(line);
                } else if (config_type) {
                    switch (config_type) {
                        case "radius":
                            this.parse_radius(config_block);
                            break;
                        case "tacacs":
                            this.parse_tacacs(config_block);
                            break;
                        case "port_profiles":
                            this.parse_interface(config_block);
                            break;
                        case "banner":
                            this.banner = config_block.join("\\n").replace(/\r/g, "");
                            break;
                    }
                    config_block = [];
                    config_type = undefined;
                }

                if (line.startsWith("interface ")) {
                    config_type = "port_profiles";
                    config_block.push(line);
                }
                else if (line.startsWith("radius server ")) config_type = "radius";
                else if (line.startsWith("tacacs server ")) config_type = "tacacs";
                else if (line.startsWith("ip name-server ")) this.parse_dns(line);
                else if (line.startsWith("ip domain name ")) this.parse_domain(line);
                else if (line.startsWith("ntp server ")) this.parse_ntp(line);
                else if (line.startsWith("logging host ")) this.parse_syslog(line);
                else if (line.startsWith("ip dhcp snooping ")) this.parse_dhcp_snooping(line);
                else if (line.startsWith("banner motd")) config_type = "banner"
            })
            resolve(true);
        })
    }

    parse_vlans(vlan_conf: string[]): Promise<boolean> {
        var deteted_vlans: number = 0;
        var new_vlans: number = 0;
        return new Promise((resolve) => {
            if (vlan_conf.length > 0) {
                vlan_conf.forEach((line: string) => {
                    if (line.match(/^\d/)) {
                        var splitted_line = line.split(/\s+/);
                        var vlan_id = splitted_line[0];
                        var vlan_name = splitted_line[1];
                        if (!this.vlan_ids_to_exclude.includes(vlan_id)) {
                            deteted_vlans += 1;
                            if (this.vlans.hasOwnProperty(vlan_id)) {
                                if (!this.vlans[vlan_id].includes(vlan_name.toLocaleLowerCase())) this.vlans[vlan_id].push(vlan_name.toLowerCase());
                            } else {
                                new_vlans += 1;
                                this.vlans[vlan_id] = [vlan_name.toLowerCase().replace(/[ &-:]+/g, "_")];
                            }
                        }
                    }
                })
                this._logger.info(deteted_vlans + " VLANs detected. " + new_vlans + " new VLAN(s) learned");
                resolve(true);
            } else {
                this._logger.warning("No VLANs detected");
                resolve(false);
            }
        })
    }

    private add_dhcp_snooping_vlan(vlan_id: string) {
        if (!this.dhcp_snooping_vlans.includes(vlan_id)) {
            this._logger.info("DHCP Snooping: Adding VLAN " + vlan_id);
            this.dhcp_snooping_vlans.push(vlan_id);
        }
    }

    private parse_dhcp_snooping(dhcp_snooping_line: string) {
        var new_vlans = dhcp_snooping_line.replace("ip dhcp snooping vlan", "").trim().split(",");
        new_vlans.forEach(new_entry => {
            if (new_entry.includes("-")) {
                var start: number = +new_entry.split("-")[0];
                var stop: number = +new_entry.split("-")[1];
                for (var vlan_id: number = start; vlan_id <= stop; vlan_id++) this.add_dhcp_snooping_vlan(vlan_id.toString());
            } else this.add_dhcp_snooping_vlan(new_entry);
        })
    }

    private parse_syslog(syslog_line: string) {
        var config: string[] = syslog_line.replace("logging host", "").trim().split(" ");
        var syslog_ip: string = config[0];
        var syslog_proto: string = "udp";
        var syslog_port: string = "514";
        var transport_index: number = config.indexOf("transport");
        var port_index: number = config.indexOf("port");
        if (transport_index > -1) syslog_proto = config[transport_index + 1];
        if (port_index > -1) syslog_port = config[port_index + 1];
        var new_syslog: string = JSON.stringify({
            "host": syslog_ip, "protocol": syslog_proto, "port": syslog_port, "contents": [
                {
                    "facility": "any",
                    "severity": "any"
                }
            ]
        })
        if (!this.syslog.includes(new_syslog)) {
            this._logger.info("SYSLOG servers: Adding " + syslog_ip + " " + syslog_proto + ":" + syslog_port);
            this.syslog.push(new_syslog);
        }
    }

    private parse_domain(domain_line: string) {
        var new_domain: string = domain_line.replace("ip domain name", "").trim().split(" ")[0];
        if (!this.domain.includes(new_domain)) {
            this._logger.info("DNS DOMAINs: Adding " + new_domain);
            this.domain.push(new_domain);
        }
    }

    private parse_dns(dns_line: string) {
        var new_dns: string = dns_line.replace("ip name-server", "").trim().split(" ")[0];
        if (!this.dns.includes(new_dns)) {
            this._logger.info("DNS servers: Adding " + new_dns);
            this.dns.push(new_dns);
        }
    }

    private parse_ntp(ntp_line: string) {
        var new_ntp: string = ntp_line.replace("ntp server", "").trim().split(" ")[0];
        if (!this.ntp.includes(new_ntp)) {
            this._logger.info("NTP servers: Adding " + new_ntp);
            this.ntp.push(new_ntp);
        }
    }

    private parse_tacacs(tacas_config: string[]) {
        tacas_config.forEach(line => {
            if (line.trim().startsWith("address ipv4")) {
                var config = line.replace("address ipv4", '').trim().split(" ");
                var tacacs_ip = config[0].trim();
                var tacacs_port = "49";
                var port_index = config.indexOf("port");
                if (port_index > -1) {
                    tacacs_port = config[port_index + 1];
                }
                var tmp = JSON.stringify({
                    "host": tacacs_ip,
                    "port": tacacs_port,
                    "secret": "to_be_replaced",
                    "timeout": 10
                })
                if (!this.tacacs.includes(tmp)) {
                    this._logger.info("TACACS+ servers: Adding " + tacacs_ip + ":" + tacacs_port);
                    this.tacacs.push(tmp);
                }
            }
        })
    }

    private parse_radius(radius_config: string[]) {
        radius_config.forEach(line => {
            if (line.trim().startsWith("address ipv4")) {
                var config = line.replace("address ipv4", '').trim().split(" ");
                var radius_ip = config[0].trim();
                var auth_port_index = config.indexOf("auth-port");
                var acct_port_index = config.indexOf("acct-port");
                if (auth_port_index > -1) {
                    var tmp = JSON.stringify({
                        "port": config[auth_port_index + 1],
                        "host": radius_ip,
                        "secret": "to_be_replaced"
                    })
                    if (!this.radius_auth.includes(tmp)) {
                        this._logger.info("RADIUS Auth servers: Adding " + radius_ip + ":" + config[auth_port_index + 1]);
                        this.radius_auth.push(tmp);
                    }
                }
                if (acct_port_index > -1) {
                    var tmp = JSON.stringify({
                        "port": config[acct_port_index + 1],
                        "host": radius_ip,
                        "secret": "to_be_replaced"
                    })
                    if (!this.radius_acct.includes(tmp)) {
                        this._logger.info("RADIUS Acct servers: Adding " + radius_ip + ":" + config[auth_port_index + 1]);
                        this.radius_acct.push(tmp);
                    }
                }
            }
        })
    }


    private parse_interface(interface_config: string[]) {
        var interface_name: string | undefined = undefined;

        var vlan_access: string | undefined = undefined;
        var vlan_trunk_native: string | undefined = undefined;
        var vlan_trunk_allowed: string[] = [];
        var all_networks: boolean = false;
        var networks: string[] = [];
        var voip_network: string | undefined = undefined;

        var disable_autoneg: boolean = false;
        var disabled: boolean = false;
        var duplex: string = "auto";
        var speed: string = "auto";
        var enable_mac_auth: boolean = false;
        var enable_qos: boolean = false;
        var mac_auth_only: boolean = false;
        var mac_limit: number = 0;
        var mode: string = "access";
        var mtu: number | undefined = undefined;
        var persist_mac: boolean = false;
        var poe_disabled: boolean = false;
        var port_auth: string | undefined = undefined;
        var rejected_network: string | undefined = undefined;
        var stp_edge: boolean = true;
        var profile_name: string = "";

        var profile_configuration: ProfileConfiguration = {
            all_networks: false,
            disable_autoneg: false,
            disabled: false,
            duplex: undefined,
            speed: undefined,
            enable_mac_auth: false,
            enable_qos: false,
            mac_auth_only: false,
            mac_limit: undefined,
            mode: undefined,
            mtu: undefined,
            networks: undefined,
            poe_disabled: false,
            port_auth: undefined,
            rejected_network: undefined,
            stp_edge: false,
            voip_network: undefined,
            port_network: undefined,
            persist_mac: false
        }



        interface_config.forEach(line => {
            if (line.trim().startsWith("interface")) interface_name = line.replace("interface", "").trim()
            else if (line.trim().startsWith("description")) profile_name = line.replace("description", "").trim().toString();
            else if (line.trim().startsWith("switchport mode")) mode = line.replace("switchport mode", "").trim();
            else if (line.trim().startsWith("switchport access vlan")) vlan_access = line.replace("switchport access vlan", "").trim();
            else if (line.trim().startsWith("switchport voice vlan")) voip_network = line.replace("switchport voice vlan", "").trim();
            else if (line.trim().startsWith("switchport trunk native vlan")) vlan_trunk_native = line.replace("switchport trunk native vlan", "").trim();
            else if (line.trim().startsWith("switchport trunk allowed vlan")) vlan_trunk_allowed = line.replace("switchport trunk allowed vlan", "").trim().split(",");
            else if (line.trim().startsWith("dot1x pae authenticator")) port_auth = "dot1x";
            else if (line.trim().startsWith("mab")) enable_mac_auth = true;
            else if (line.trim().startsWith("spanning-tree portfast")) stp_edge = true;
            else if (line.trim().startsWith("spanning-tree bpduguard enable")) stp_edge = true;
            else if (line.trim().startsWith("auto qos")) enable_qos = true;
            else if (line.trim().startsWith("shutdown")) disabled = true;
            else if (line.trim().startsWith("power inline never")) poe_disabled = true;
            else if (line.trim().startsWith("duplex")) {
                duplex = line.replace("duplex", "").trim();
            } else if (line.trim().startsWith("speed")) {
                speed = line.replace("speed", "").trim();
                switch (speed) {
                    case "10":
                        speed = "10m";
                        break;
                    case "100":
                        speed = "100m";
                        break;
                    case "1000":
                        speed = "1g";
                        break;
                    case "2500":
                        speed = "2.5g";
                        break;
                    case "5000":
                        speed = "5g";
                        break;
                    case "10000":
                        speed = "10g";
                        break;
                    default:
                        speed = "auto";
                        disable_autoneg = false;
                        break;
                }
            }
        })

        if (speed != "auto" && duplex != "auto") {
            disable_autoneg = true;
            this._logger.info("Interface " + interface_name + ": \"speed\" and/or \"duplex\". Disabling auto_neg");
        }

        if (enable_mac_auth && port_auth == undefined) {
            port_auth = "dot1x";
            mac_auth_only = true;
            this._logger.info("Interface " + interface_name + ": \"mab\" configured without \"dot1x pae authenticator\". Enabling \"mac_auth_only\"");
        }

        if (mode == "access") {
            if (vlan_access != undefined) this.add_vlan(vlan_access);
            else vlan_access = "1";
            var port_network = this.get_vlan(vlan_access);
            profile_configuration.mode = "access";
            profile_configuration.port_network = port_network;
            this._logger.info("Interface " + interface_name + ": \"switchport mode access\" and \"switchport access vlan " + vlan_access + "\"");
        }
        else {
            this.add_vlan(vlan_trunk_native, vlan_trunk_allowed);
            var all_networks = false;
            var port_network = this.get_vlan(vlan_trunk_native);
            var networks: string[] = [];

            vlan_trunk_allowed.forEach((vlan_id: string) => {
                var network = this.get_vlan(vlan_id);
                if (network) networks.push(network);
            })

            if (vlan_trunk_allowed.length == 0) all_networks = true;

            profile_configuration.mode = "trunk";
            profile_configuration.port_network = port_network;
            profile_configuration.networks = networks;
            profile_configuration.all_networks = all_networks;

            var message = "Interface " + interface_name + ": \"switchport mode trunk\" with";
            if (vlan_trunk_native) message += " \"switchport trunk native vlan " + vlan_trunk_native + "\" and";
            if (vlan_trunk_allowed.length == 0) message += " ALL networks allowed";
            else message += " \"switchport trunk allowed vlan " + vlan_trunk_allowed + "\"";
            this._logger.info(message);

        }


        profile_configuration.all_networks = all_networks;
        profile_configuration.disable_autoneg = disable_autoneg;
        profile_configuration.disabled = disabled;
        profile_configuration.duplex = duplex;
        profile_configuration.speed = speed;
        profile_configuration.enable_mac_auth = enable_mac_auth;
        profile_configuration.enable_qos = enable_qos;
        profile_configuration.mac_auth_only = mac_auth_only;
        profile_configuration.mac_limit = mac_limit;
        profile_configuration.mode = mode;
        profile_configuration.mtu = mtu;
        profile_configuration.networks = networks;
        profile_configuration.poe_disabled = poe_disabled;
        profile_configuration.port_auth = port_auth;
        profile_configuration.rejected_network = rejected_network;
        profile_configuration.stp_edge = stp_edge;
        profile_configuration.voip_network = voip_network;
        profile_configuration.persist_mac = persist_mac;

        if (!interface_name) interface_name = "unknown interface";
        this.add_profile(interface_name, profile_name, profile_configuration, interface_config);
    }

    private add_vlan(vlan: string | undefined = undefined, vlans: string[] | undefined = undefined) {
        if (vlan && !this.vlans.hasOwnProperty(vlan)) {
            this.vlans[vlan] = [this.vlan_prefix + vlan];
        }
        if (vlans) vlans.forEach(vlan => {
            if (vlan && !this.vlans.hasOwnProperty(vlan)) {
                this.vlans[vlan] = [this.vlan_prefix + vlan];
            }
        })
    }

    private get_vlan(vlan_id: string | undefined) {
        if (vlan_id != undefined) {
            try {
                if (this.vlans.hasOwnProperty(vlan_id)) return this.vlans[vlan_id][0];
                else {
                    this._logger.error("unable to find vlan name for vlan_id " + vlan_id);
                    console.error(this.vlans);
                }
            } catch {
                this._logger.error("error when trying to get vlan name for vlan_id " + vlan_id);
                console.error(this.vlans);
            }
        }
        return undefined;
    }

    private add_profile(interface_name: string, profile_name: string, profile_configuration: object, interface_config: string[]) {
        var str_profile_configuration = JSON.stringify(profile_configuration);
        var index = this.port_profile_configs.indexOf(str_profile_configuration);

        if (!profile_name) {
            this._logger.warning("Interface " + interface_name + ": No description detected for this interface");
            profile_name = "unknown";
        }

        if (index < 0) {
            this.ios_config.push(interface_config.join("\r\n"));
            this.port_profile_configs.push(str_profile_configuration);
            this.ios_descriptions.push([profile_name]);
            this._logger.info("New interface profile added");
        } else {
            if (!this.ios_descriptions[index].includes(profile_name)) {
                this.ios_descriptions[index].push(profile_name);
            }
        }
    }

    async generate_profile_names() {
        for (var i = 0; i < this.ios_descriptions.length; i++) {
            if (this.ios_descriptions[i].length == 1) {
                var profile_name = this.ios_descriptions[i][0];
                if (this.all_port_profile_names.includes(profile_name)) {
                    profile_name = profile_name + "_" + [i];
                }
                const pname = profile_name.toLowerCase().replace(/[ &-:]+/g, "_").substring(0, 31);
                this.port_profile_names[i] = pname;
            } else {
                this._logger.warning("Mutliple entries found for this profile: " + this.ios_descriptions[i].toString());
                var terms: Terms = {};
                var max_occurence: number = -1;
                var description_terms: string[] = [];
                this.ios_descriptions[i].forEach(description => {
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
                this.port_profile_names[i] = pname;
            }
        }
    }

    async generate_template() {
        for (var vlan_id in this.vlans) {
            if (this.vlans[vlan_id].length > 1) this._logger.warning("WARNING: VLAN " + vlan_id + " has multiple names. Using the first one...")
            this.mist_template.networks[this.vlans[vlan_id][0]] = { "vlan_id": vlan_id };
        }
        // this.vlans.forEach((vlan_id:string)=>{
        //     this.mist_template["networks"][vlan_prefix+vlan_id] = {"vlan_id": vlan_id};
        // })
        for (var i: number = 0; i < this.port_profile_names.length; i++) {
            this.mist_template.port_usages[this.port_profile_names[i]] = JSON.parse(this.port_profile_configs[i]);
        }
        this.radius_auth.forEach((radius_auth: string) => {
            this.mist_template.radius_config.auth_servers.push(JSON.parse(radius_auth));
        })
        this.radius_acct.forEach((radius_acct: string) => {
            this.mist_template.radius_config.acct_servers.push(JSON.parse(radius_acct));
        })
        if (this.tacacs.length > 0) {
            this.mist_template.switch_mgmt.tacacs.enabled = true;
            this.tacacs.forEach((tacplus_server: string) => {
                this.mist_template.switch_mgmt.tacacs.tacplus_servers.push(JSON.parse(tacplus_server))
            })
        }
        if (this.banner.length > 0) {
            var banner_already_configured: boolean = false;
            for (let line of this.mist_template.additional_config_cmds) {
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