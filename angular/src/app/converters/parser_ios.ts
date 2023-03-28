import { ProfileConfigurationElement } from "./mist_template"
import { Logger } from "../services/logger";
import { ConfigFile } from "./parser_main";
import { ConfigData } from "./parser_config";


export class IosParser {

    vlan_ids_to_exclude: string[];
    filename: string = "";
    hostname: string = "";

    constructor(
        private _ios_logger: Logger,
        private config_data: ConfigData
    ) {
        this.vlan_ids_to_exclude = ["1002", "1003", "1004", "1005"];
    }

    /*****************************************************************************
     * VLANS
     ****************************************************************************/
    // VLAN ENTRY
    process_vlans(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            var vlan: string[] = [];
            var current: string | undefined = undefined;
            var has_vlan_list: boolean = false;
            config_file.config.forEach((line: string) => {
                if (current == "vlan") {
                    if (line.match(/^\d/)) vlan.push(line);
                    else if (line.match(/^\w/)) {
                        current = undefined;
                    }
                } else if (line.includes("VLAN Name")) {
                    current = "vlan";
                    has_vlan_list = true;
                };
            })
            if (has_vlan_list) {
                this._ios_logger.info("VLAN database extracted from " + config_file.name + ", processing it", config_file.name)
                this.parse_vlans(vlan, config_file.name).then((res) => {
                    resolve(res)
                });
            } else {
                this._ios_logger.warning("No VLAN database found in the file", config_file.name);
                resolve(false);
            }
        })
    }

    private parse_vlans(vlan_conf: string[], filename: string): Promise<boolean> {
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
                            vlan_name = vlan_name.toLowerCase().replace(/[ &:-]+/g, "_");
                            deteted_vlans += 1;
                            if (this.config_data.vlans.hasOwnProperty(vlan_id)) {
                                if (!this.config_data.vlans[vlan_id].includes(vlan_name)) this.config_data.vlans[vlan_id].push(vlan_name);
                            } else {
                                new_vlans += 1;
                                this.config_data.vlans[vlan_id] = [vlan_name];
                            }
                        }
                    }
                })
                this._ios_logger.info(deteted_vlans + " VLANs detected. " + new_vlans + " new VLAN(s) learned", filename);
                resolve(true);
            } else {
                this._ios_logger.warning("No VLANs detected", filename);
                resolve(false);
            }
        })
    }


    /*****************************************************************************
     * CONFIG
     ****************************************************************************/
    // CONFIG ENTRY
    process_config(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            this.filename = config_file.name;
            this.hostname = "";
            var config: string[] = [];
            var end_keyword: boolean = false;
            var current: string | undefined = undefined;
            config_file.config.forEach((line: string) => {
                if (current == "config") {
                    if (line == "end") end_keyword = true;
                    if (end_keyword && line.length == 0) current = undefined;
                    else config.push(line)
                } else if (line.startsWith("Current configuration")) {
                    current = "config";
                }
            })
            this._ios_logger.info("Configuration extracted from " + config_file.name + ", processing it", this.filename)
            this.parse_config(config).then((res) => resolve(res));
        })
    }

    private parse_config(config: string[]): Promise<boolean> {
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
                            this.config_data.banner = config_block.join("\\n").replace(/\r/g, "");
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
                else if (line.startsWith("banner motd ")) config_type = "banner";
                else if (line.startsWith("hostname ")) this.hostname = line.replace("hostname ", "").trim();
            })
            resolve(true);
        })
    }

    private parse_dhcp_snooping(dhcp_snooping_line: string) {
        var new_vlans = dhcp_snooping_line.replace("ip dhcp snooping vlan", "").trim().split(",");
        new_vlans.forEach(new_entry => {
            if (new_entry.includes("-")) {
                var start: number = +new_entry.split("-")[0];
                var stop: number = +new_entry.split("-")[1];
                for (var vlan_id: number = start; vlan_id <= stop; vlan_id++) this.config_data.add_dhcp_snooping_vlan(vlan_id.toString(), this.filename);
            } else this.config_data.add_dhcp_snooping_vlan(new_entry, this.filename);
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
        this.config_data.add_syslog(syslog_ip, syslog_proto, syslog_port, this.filename);
    }

    private parse_domain(domain_line: string) {
        var new_domain: string = domain_line.replace("ip domain name", "").trim().split(" ")[0];
        this.config_data.add_domain(new_domain, this.filename)
    }

    private parse_dns(dns_line: string) {
        var new_dns: string = dns_line.replace("ip name-server", "").trim().split(" ")[0];
        this.config_data.add_dns(new_dns, this.filename);
    }

    private parse_ntp(ntp_line: string) {
        var new_ntp: string = ntp_line.replace("ntp server", "").trim().split(" ")[0];
        this.config_data.add_ntp(new_ntp, this.filename);
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

                this.config_data.add_tacacs_auth(tacacs_ip, tacacs_port, this.filename);
                this.config_data.add_tacacs_acct(tacacs_ip, tacacs_port, this.filename);
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
                if (auth_port_index > -1) this.config_data.add_radius_auth(radius_ip, config[auth_port_index + 1], 5, this.filename);
                if (acct_port_index > -1) this.config_data.add_radius_acct(radius_ip, config[acct_port_index + 1], 5, this.filename);
            }
        })
    }

    private default_inteface(): ProfileConfigurationElement {
        return {
            all_networks: false,
            disable_autoneg: false,
            disabled: false,
            duplex: "auto",
            speed: "auto",
            enable_mac_auth: false,
            enable_qos: false,
            mac_auth_only: false,
            mac_limit: 0,
            mode: "access",
            mtu: undefined,
            networks: [],
            poe_disabled: false,
            port_auth: undefined,
            rejected_network: undefined,
            stp_edge: false,
            voip_network: undefined,
            port_network: undefined,
            persist_mac: false,
            guest_network: undefined,
            bypass_auth_when_server_down: false
        }
    }

    private parse_interface(interface_config: string[]) {
        var interface_name: string = "undefined";
        var interface_blocks: string[] = [];

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
        var interface_description: string = "";

        var profile_configuration: ProfileConfigurationElement = this.default_inteface();

        interface_config.forEach(line => {
            interface_blocks.push(line);
            if (line.trim().startsWith("interface")) interface_name = line.replace("interface", "").trim()
            else if (line.trim().startsWith("description")) interface_description = line.replace("description", "").trim().toString();
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
        if (interface_name != "undefined" && !interface_name.toLowerCase().startsWith("vlan") && !interface_name.toLowerCase().startsWith("gid") && !interface_name.toLowerCase().startsWith("bluetooth")) {
            if (speed != "auto" && duplex != "auto") {
                disable_autoneg = true;
                this._ios_logger.info("Interface " + interface_name + ": \"speed\" and/or \"duplex\". Disabling auto_neg", this.filename);
            }

            if (enable_mac_auth && port_auth == undefined) {
                port_auth = "dot1x";
                mac_auth_only = true;
                this._ios_logger.info("Interface " + interface_name + ": \"mab\" configured without \"dot1x pae authenticator\". Enabling \"mac_auth_only\"", this.filename);
            }

            if (mode == "access") {
                if (vlan_access != undefined) this.config_data.add_vlan(vlan_access);
                else vlan_access = "1";
                var port_network = this.config_data.get_vlan(vlan_access, this.filename);
                profile_configuration.mode = "access";
                profile_configuration.port_network = port_network;
                this._ios_logger.info("Interface " + interface_name + ": \"switchport mode access\" and \"switchport access vlan " + vlan_access + "\"", this.filename);
            }
            else {
                this.config_data.add_vlan(vlan_trunk_native, vlan_trunk_allowed);
                var all_networks = false;
                var port_network = this.config_data.get_vlan(vlan_trunk_native, this.filename);
                var networks: string[] = [];

                vlan_trunk_allowed.forEach((vlan_id: string) => {
                    var network = this.config_data.get_vlan(vlan_id, this.filename);
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
                this._ios_logger.info(message, this.filename);

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
            this.add_profile(interface_name, interface_blocks, interface_description, profile_configuration);
        }
    }


    private add_profile(interface_name: string, interface_blocks: string[], interface_description: string, interface_config: ProfileConfigurationElement) {
        var uuid = this.config_data.add_profile(interface_config, interface_name, interface_description, [], this.filename);
        this.config_data.add_interface(this.filename, this.hostname, interface_name, uuid, "Cisco", interface_blocks);
    }

}