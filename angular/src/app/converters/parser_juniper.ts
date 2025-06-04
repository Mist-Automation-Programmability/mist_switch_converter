import { ProfileConfigurationElement, VlansElements, VlanMapping } from "./mist_template"
import { Logger } from "../services/logger";
import { ConfigFile } from "./parser_main";
import { ConfigData } from "./parser_config";


interface JunosInterfaceElements {
    [key: string]: {
        desc: string,
        profile: ProfileConfigurationElement,
        blocks: string[]
    }
}

interface JunosDhcpSnoopingVlansElements {
    [key: string]: string[]
}

interface JunosInterfaceRangesElement {
    [key: string]: {
        ports: JunosInterfaceRangePortElement[],
        profile: ProfileConfigurationElement,
        blocks: string[]
    }
}

interface JunosInterfaceRangePortElement {
    int_type: string,
    fpc_min: number,
    fpc_max: number,
    pic_min: number,
    pic_max: number,
    port_min: number,
    port_max: number,
}

export class JuniperParser {

    interface_ranges: JunosInterfaceRangesElement = {};
    filename: string = "";
    hostname: string = "";

    constructor(
        private _juniper_logger: Logger,
        private config_data: ConfigData
    ) {
    }

    /*****************************************************************************
     * VLANS
     ****************************************************************************/
    // VLAN ENTRY
    process_vlans(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            var vlan: string[] = [];
            var vlan_subnet_mapping: VlanMapping = {};
            var has_vlan_list: boolean = false;
            const re_interface_subnet_mapping: RegExp = /set interfaces (?<interface_name>[^ ]+) unit (?<unit_number>[^ ]+) family inet address (?<subnet>[^ ]+)/guis;
            config_file.config.forEach((line: string) => {
                var test = line.match(re_interface_subnet_mapping);
                if (test) {
                    var subnet;
                    var interface_unit;
                    var regex_result = re_interface_subnet_mapping.exec(line);
                    interface_unit = regex_result?.groups?.["interface_name"] + "." + regex_result?.groups?.["unit_number"];
                    if (regex_result?.groups?.["subnet"]) subnet = regex_result?.groups?.["subnet"];
                    if (subnet && interface_unit) {
                        if (vlan_subnet_mapping.hasOwnProperty(interface_unit)) {
                            this._juniper_logger.warning("Multiple subnets found for interface " + interface_unit, config_file.name);
                        } else {
                            vlan_subnet_mapping[interface_unit] = subnet;
                        }
                    }
                }
                if (line.startsWith("set vlans")) {
                    vlan.push(line);
                    has_vlan_list = true;
                };
            })
            if (has_vlan_list) {
                this._juniper_logger.info("VLAN database extracted from " + config_file.name + ", processing it", config_file.name)
                this.parse_vlans(vlan, vlan_subnet_mapping, config_file.name).then((res) => {
                    resolve(res)
                });
            } else {
                this._juniper_logger.warning("No VLAN database found in the file", config_file.name);
                resolve(false);
            }
        })
    }

    private parse_vlans(vlan_conf: string[], vlan_subnet_mapping: VlanMapping, filename: string): Promise<boolean> {
        return new Promise((resolve) => {
            var detected_vlans: number = 0;
            var new_vlans: number = 0;
            var vlan_mapping: VlanMapping = {}
            const re_vlan: RegExp = /set vlans (?<vlan_name>[^ ]+) vlan-id (?<vlan_id>[0-9]+)/guis;
            const re_vlan_interface_mapping: RegExp = /set vlans (?<vlan_name>[^ ]+) l3-interface (?<interface_unit>[^ ]+)/guis;
            if (vlan_conf.length > 0) {
                vlan_conf.forEach((line: string) => {
                    var test_vlan = line.match(re_vlan);
                    var test_mapping = line.match(re_vlan_interface_mapping);
                    if (test_vlan) {
                        var regex_result = re_vlan.exec(line);
                        if (regex_result?.groups?.["vlan_id"] && regex_result?.groups?.["vlan_name"]) {
                            var vlan_id = regex_result.groups?.["vlan_id"];
                            var vlan_name = regex_result.groups?.["vlan_name"].toLowerCase().replace(/[ &:-]+/g, "_");
                            vlan_mapping[vlan_name] = vlan_id;
                            detected_vlans += 1;
                            if (this.config_data.vlans.hasOwnProperty(vlan_id)) {
                                if (!this.config_data.vlans[vlan_id].names.includes(vlan_name)) this.config_data.vlans[vlan_id].names.push(vlan_name);
                            } else {
                                new_vlans += 1;
                                this.config_data.vlans[vlan_id] = { "names": [vlan_name], "subnets": [] };
                            }
                        }
                    } else if (test_mapping) {
                        var regex_result = re_vlan_interface_mapping.exec(line);
                        var subnet_cli: string = "";
                        var vlan_id: string = "";
                        if (regex_result?.groups?.["vlan_name"] && regex_result?.groups?.["interface_unit"]) {
                            var vlan_name = regex_result.groups?.["vlan_name"].toLowerCase().replace(/[ &:-]+/g, "_");
                            var interface_unit = regex_result.groups?.["interface_unit"];
                            if (vlan_mapping.hasOwnProperty(vlan_name)) vlan_id = vlan_mapping[vlan_name];
                            if (vlan_subnet_mapping.hasOwnProperty(interface_unit)) subnet_cli = vlan_subnet_mapping[interface_unit];
                            if (vlan_id && subnet_cli) {
                                const subnet = this.config_data.calculate_cidr(subnet_cli);
                                if (!subnet) {
                                    this._juniper_logger.error("Unable to process subnet from CLI \"" + line +"\" for vlan "+vlan_id)
                                } else if (this.config_data.vlans.hasOwnProperty(vlan_id)) {
                                    if (!this.config_data.vlans[vlan_id].subnets.includes(subnet)) this.config_data.vlans[vlan_id].subnets.push(subnet);
                                } else {
                                    new_vlans += 1;
                                    this.config_data.vlans[vlan_id] = { "names": [], "subnets": [subnet] };
                                }
                            }
                        }
                    }
                })
                this._juniper_logger.info(detected_vlans + " VLANs detected. " + new_vlans + " new VLAN(s) learned", filename);
                resolve(true);
            } else {
                this._juniper_logger.warning("No VLANs detected", filename);
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
            this.interface_ranges = {};
            var config: string[] = [];
            config_file.config.forEach((line: string) => {
                if (line.startsWith("set")) config.push(line)
            })
            this._juniper_logger.info("Configuration extracted from " + config_file.name + ", processing it", this.filename)
            this.parse_config(config).then((res) => resolve(res));
        })
    }


    private parse_config(config: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            var radius_blocks: string[] = [];
            var tacacs_auth_blocks: string[] = [];
            var tacacs_acct_blocks: string[] = [];
            var syslog_blocks: string[] = [];
            var interface_blocks: string[] = [];
            var interface_range_blocks: string[] = [];
            var vlans_blocks: string[] = [];
            var dot1x_blocks: string[] = [];
            var qos_blocks: string[] = [];
            var poe_blocks: string[] = [];
            var rstp_blocks: string[] = [];
            var sw_options_blocks: string[] = [];
            config.forEach((line: string, index: number) => {
                if (line.startsWith("set interfaces interface-range")) interface_range_blocks.push(line);
                else if (line.startsWith("set interfaces ")) interface_blocks.push(line);
                else if (line.startsWith("set protocols dot1x authenticator interface ")) dot1x_blocks.push(line);
                else if (line.startsWith("set class-of-service interfaces ")) qos_blocks.push(line);
                else if (line.startsWith("set poe interface ")) poe_blocks.push(line);
                else if (line.startsWith("set protocols rstp interface ")) rstp_blocks.push(line);
                else if (line.startsWith("set switch-options ")) sw_options_blocks.push(line);
                else if (line.startsWith("set access radius-server ")) radius_blocks.push(line);
                else if (line.startsWith("set vlans ")) vlans_blocks.push(line);
                else if (line.startsWith("set system tacplus-server ")) tacacs_auth_blocks.push(line);
                else if (line.startsWith("set system accounting destination tacplus server ")) tacacs_acct_blocks.push(line);
                else if (line.startsWith("set system syslog host ")) syslog_blocks.push(line);
                else if (line.startsWith("set system name-server ")) this.parse_dns(line);
                else if (line.startsWith("set system domain-search ")) this.parse_domain(line);
                else if (line.startsWith("set system ntp server ")) this.parse_ntp(line);
                else if (line.startsWith("set system login message ")) this.config_data.cli_banner = line.replace("set system login message ", "").trim().replace(/^"|"$/g, "");
                else if (line.startsWith("set system host-name ")) this.hostname = line.replace("set system host-name ", "").trim().replace(/^"|"$/g, "");
            })
            this.parse_radius(radius_blocks);
            this.parse_tacacs_auth(tacacs_auth_blocks);
            this.parse_tacacs_acct(tacacs_acct_blocks);
            this.parse_syslog(syslog_blocks);
            this.parse_dhcp_snooping(vlans_blocks);
            this.parse_interface_ranges(interface_range_blocks);
            this.parse_interface(interface_blocks, dot1x_blocks, qos_blocks, poe_blocks, rstp_blocks, sw_options_blocks);

            resolve(true);
        })
    }

    /************************* DHCP SNOOPING *************************/
    private add_dhcp_snooping_vlan(vlan_id: string) {
        if (!this.config_data.dhcp_snooping_vlans.includes(vlan_id)) {
            this._juniper_logger.info("DHCP Snooping: Adding VLAN " + vlan_id, this.filename);
            this.config_data.dhcp_snooping_vlans.push(vlan_id);
        }
    }

    private parse_dhcp_snooping(dhcp_snooping_lines: string[]) {
        const regex_vlan_def = /^set vlans (?<vlan_name>[^ ]+) vlan-id (?<vlan_id>\d+)$/
        const regex_snooping = /^set vlans (?<vlan_name>[^ ]+) forwarding-options dhcp-security$/
        var vlans: JunosDhcpSnoopingVlansElements = {}
        var dhcp_snooping_vlan_names: string[] = []
        dhcp_snooping_lines.forEach((line: string) => {
            var vlan_def = regex_vlan_def.exec(line.replace(/\r/, ""));
            var snoop_def = regex_snooping.exec(line.replace(/\r/, ""));
            if (vlan_def) {
                var vlan_id = vlan_def.groups?.["vlan_id"];
                var vlan_name = vlan_def.groups?.["vlan_name"].toLowerCase().replace(/[ &:-]+/g, "_");
                if (vlan_name && vlan_id) vlans[vlan_name] = [vlan_id];
            } else if (snoop_def) {
                var vlan_name = snoop_def.groups?.["vlan_name"].toLowerCase().replace(/[ &:-]+/g, "_");
                if (vlan_name) dhcp_snooping_vlan_names.push(vlan_name)
            }
        })
        dhcp_snooping_vlan_names.forEach((vlan_name)=>{
            if (vlans[vlan_name]) this.add_dhcp_snooping_vlan(vlans[vlan_name][0]);
        })
    }

    /************************* SYSLOG *************************/
    private parse_syslog(syslog_lines: string[]): void {
        var syslog_ip: string = ""
        var syslog_port: string = "514"
        var syslog_proto: string = "udp"
        syslog_lines.forEach((line: string, index: number) => {
            var syslog_config: string[] = line.replace("set system syslog host", "").trim().split(" ");
            if (syslog_ip && syslog_ip != syslog_config[0]) this.config_data.add_syslog(syslog_ip, syslog_proto, syslog_port);
            if (!syslog_ip || syslog_ip != syslog_config[0]) syslog_ip = syslog_config[0];
            if (syslog_config[1] == "port") syslog_port = syslog_config[2];
            if (index == syslog_lines.length - 1) this.config_data.add_syslog(syslog_ip, syslog_proto, syslog_port);
        })
    }

    /************************* DOMAIN/DNS/NTP *************************/
    private parse_domain(domain_line: string) {
        var new_domain: string = domain_line.replace("set system domain-search", "").trim().split(" ")[0];
        this.config_data.add_domain(new_domain, this.filename);
    }

    private parse_dns(dns_line: string) {
        var new_dns: string = dns_line.replace("set system name-server", "").trim().split(" ")[0];
        this.config_data.add_dns(new_dns, this.filename);
    }

    private parse_ntp(ntp_line: string) {
        var new_ntp: string = ntp_line.replace("set system ntp server", "").trim().split(" ")[0];
        this.config_data.add_ntp(new_ntp, this.filename);
    }

    /************************* TACACS *************************/
    private async parse_tacacs_auth(tacas_lines: string[]) {
        var tacacs_ip: string = "";
        var tacacs_port: string = "";
        tacas_lines.forEach((line: string, index: number) => {
            var tacacs_config: string[] = line.replace("set system tacplus-server ", "").trim().split(" ");
            if (tacacs_ip && tacacs_ip != tacacs_config[0]) this.config_data.add_tacacs_auth(tacacs_ip, tacacs_port, this.filename);
            if (!tacacs_ip || tacacs_ip != tacacs_config[0]) tacacs_ip = tacacs_config[0];
            if (tacacs_config[1] == "port") tacacs_port = tacacs_config[2];
            if (index == tacas_lines.length - 1) this.config_data.add_tacacs_auth(tacacs_ip, tacacs_port, this.filename);
        })
    }

    private parse_tacacs_acct(tacas_lines: string[]): void {
        var tacacs_ip: string = "";
        var tacacs_port: string = "";
        tacas_lines.forEach((line: string, index: number) => {
            var tacacs_config: string[] = line.replace("set system accounting destination tacplus server ", "").trim().split(" ");
            if (tacacs_ip && tacacs_ip != tacacs_config[0]) this.config_data.add_tacacs_acct(tacacs_ip, tacacs_port, this.filename);
            if (!tacacs_ip || tacacs_ip != tacacs_config[0]) tacacs_ip = tacacs_config[0];
            if (tacacs_config[1] == "port") tacacs_port = tacacs_config[2];
            if (index == tacas_lines.length - 1) this.config_data.add_tacacs_acct(tacacs_ip, tacacs_port, this.filename);
        })
    }

    /************************* RADIUS *************************/
    private add_radius(radius_ip: string, radius_auth_port: string, radius_acct_port: string, radius_coa_port: string, radius_timeout: number) {
        if (radius_auth_port) this.config_data.add_radius_auth(radius_ip, radius_auth_port, radius_timeout, this.filename);
        if (radius_acct_port) this.config_data.add_radius_acct(radius_ip, radius_acct_port, radius_timeout, this.filename);
        if (radius_coa_port) this.config_data.add_radius_coa(radius_coa_port, this.filename);
    }

    private async parse_radius(radius_lines: string[]): Promise<void> {
        return new Promise((resolve) => {
            var radius_ip: string = "";
            var radius_auth_port: string = "";
            var radius_acct_port: string = "";
            var radius_coa_port: string = "";
            var radius_timeout: number = 5;
            var radius_retry: string = "";
            radius_lines.forEach((line: string, index: number) => {
                var radius_config: string[] = line.replace("set access radius-server ", "").trim().split(" ");
                if (radius_ip && radius_ip != radius_config[0]) this.add_radius(radius_ip, radius_auth_port, radius_acct_port, radius_coa_port, radius_timeout);
                if (!radius_ip || radius_ip != radius_config[0]) radius_ip = radius_config[0];
                if (radius_config[1] == "port") radius_auth_port = radius_config[2];
                if (radius_config[1] == "accounting-port") radius_acct_port = radius_config[2];
                if (radius_config[1] == "dynamic-request-port") radius_coa_port = radius_config[2];
                if (radius_config[1] == "timeout" && Number(radius_config[2])) radius_timeout = Number(radius_config[2]);
                if (radius_config[1] == "retry") radius_retry = radius_config[2];
                if (index == radius_lines.length - 1) this.add_radius(radius_ip, radius_auth_port, radius_acct_port, radius_coa_port, radius_timeout);
            })
            resolve();
        })
    }


    /************************* INTERFACE *************************/
    private parse_interface_ranges_num(range: string): [number, number] {
        if (range.includes("-")) {
            var min = Number(range.split("-")[0]);
            var max = Number(range.split("-")[1]);
        } else {
            var min = Number(range);
            var max = Number(range);
        }
        return [min, max];
    }

    /************************* INTERFACE RANGES *************************/
    private add_interface_range(ir_name: string, ports: JunosInterfaceRangePortElement): void {
        if (ir_name in this.interface_ranges) {
            this.interface_ranges[ir_name].ports.push(ports)
        } else {
            this.interface_ranges[ir_name] = {
                ports: [ports],
                profile: this.default_inteface(),
                blocks: []
            }
        }
    }

    private get_interface_range(ir_name: string): ProfileConfigurationElement {
        return this.interface_ranges[ir_name].profile;
    }

    private async parse_interface_ranges(interface_range_lines: string[]) {
        const re_interface_member: RegExp = /^set interfaces interface-range (?<name>[^ ]+) member "?(?<type>[a-z]+)-\[?(?<fpc>[0-9-]+)\]?\/\[?(?<pic>[0-9-]+)\]?\/\[?(?<port>[0-9-]+)\]?"?/;
        const re_interface_member_range: RegExp = /^set interfaces interface-range (?<name>[^ ]+) member-range (?<type>[a-z]+)-(?<fpc_min>[0-9-]+)\/(?<pic_min>[0-9-]+)\/(?<port_min>[0-9-]+) to ([a-z]+)-(?<fpc_max>[0-9-]+)\/(?<pic_max>[0-9-]+)\/(?<port_max>[0-9-]+)/
        interface_range_lines.forEach((line: string) => {
            if (line.match(re_interface_member)) {
                var ir_data = re_interface_member.exec(line.replace("\r", ""))
                var ir_name = ir_data?.groups?.["name"];
                var ir_type = ir_data?.groups?.["type"];
                var ir_fpc = ir_data?.groups?.["fpc"];
                var ir_pic = ir_data?.groups?.["pic"];
                var ir_port = ir_data?.groups?.["port"];
                if (ir_name && ir_type && ir_fpc && ir_pic && ir_port) {
                    var [fpc_min, fpc_max] = this.parse_interface_ranges_num(ir_fpc);
                    var [pic_min, pic_max] = this.parse_interface_ranges_num(ir_pic);
                    var [port_min, port_max] = this.parse_interface_ranges_num(ir_port);
                    var ports: JunosInterfaceRangePortElement = {
                        fpc_min: fpc_min,
                        fpc_max: fpc_max,
                        pic_min: pic_min,
                        pic_max: pic_max,
                        port_min: port_min,
                        port_max: port_max,
                        int_type: ir_type
                    };
                    this.add_interface_range(ir_name, ports);
                } else {
                    this._juniper_logger.warning("Unable to parse " + line, this.filename)
                }
            } else if (line.match(re_interface_member_range)) {
                var ir_data = re_interface_member_range.exec(line.replace("\r", ""))
                var ir_name = ir_data?.groups?.["name"];
                var ir_type = ir_data?.groups?.["type"];
                var ir_fpc_min = Number(ir_data?.groups?.["fpc_min"]);
                var ir_fpc_max = Number(ir_data?.groups?.["fpc_max"]);
                var ir_pic_min = Number(ir_data?.groups?.["pic_min"]);
                var ir_pic_max = Number(ir_data?.groups?.["pic_max"]);
                var ir_port_min = Number(ir_data?.groups?.["port_min"]);
                var ir_port_max = Number(ir_data?.groups?.["port_max"]);
                if (ir_name && ir_type &&
                    ir_fpc_min >= 0 && ir_fpc_max >= 0 &&
                    ir_pic_min >= 0 && ir_pic_max >= 0 &&
                    ir_port_min >= 0 && ir_port_max >= 0
                ) {
                    var ports: JunosInterfaceRangePortElement = {
                        int_type: ir_type,
                        fpc_min: ir_fpc_min,
                        fpc_max: ir_fpc_max,
                        pic_min: ir_pic_min,
                        pic_max: ir_pic_max,
                        port_min: ir_port_min,
                        port_max: ir_port_max
                    };
                    this.add_interface_range(ir_name, ports);
                } else {
                    this._juniper_logger.warning("Unable to parse " + line, this.filename)
                }
            } else {
                var data = line.replace("set interfaces interface-range ", "").trim();
                var port = data.split(" ")[0].trim().split(".")[0];
                var entry = this.get_interface_range(port);
                this.parse_config_profile(port, entry, data);
            }
        })
    }

    private find_interface_ranges(interface_name: string): [string[], string[], ProfileConfigurationElement] | [string[], string[], undefined] {
        const re_interface_range: RegExp = /^(?<type>[a-z]+)-\[?(?<fpc>[0-9-]+)\]?\/\[?(?<pic>[0-9-]+)\]?\/\[?(?<port>[0-9-]+)\]?"?$/;
        const data = re_interface_range.exec(interface_name);
        var assigned_ir_names: string[] = [];
        var assigned_ir_blocks: string[] = [];
        var assigned_ir_profiles: ProfileConfigurationElement[] = [];
        if (data) {
            for (var ir_name in this.interface_ranges) {
                var ir_ports = this.interface_ranges[ir_name].ports;
                if (ir_ports) {
                    var ir = ir_ports.find(ir =>
                        data.groups?.["type"] == ir.int_type &&
                        Number(data.groups?.["fpc"]) >= ir.fpc_min && Number(data.groups?.["fpc"]) <= ir.fpc_max &&
                        Number(data.groups?.["pic"]) >= ir.pic_min && Number(data.groups?.["pic"]) <= ir.pic_max &&
                        Number(data.groups?.["port"]) >= ir.port_min && Number(data.groups?.["port"]) <= ir.port_max
                    )
                    if (ir && !assigned_ir_names.includes(ir_name)) {
                        assigned_ir_names.push(ir_name);
                        assigned_ir_blocks = assigned_ir_blocks.concat(this.interface_ranges[ir_name].blocks);
                        assigned_ir_profiles.push(this.interface_ranges[ir_name].profile);
                    }
                }
            }
            if (assigned_ir_names.length == 1) return [assigned_ir_names, assigned_ir_blocks, assigned_ir_profiles[0]];
            if (assigned_ir_names.length > 1) {
                var profile: ProfileConfigurationElement = this.default_inteface();
                for (var i = 0; i < assigned_ir_profiles.length; i++) {
                    profile = this.merge_profiles(assigned_ir_profiles[i], profile);
                }
                return [assigned_ir_names, assigned_ir_blocks, profile];
            }
        }
        return [[], [], undefined]
    }

    /************************* JUNIPER PARSER COMMON  *************************/
    // Just a function to generate the default interface values
    private merge_profiles(source_profile: ProfileConfigurationElement, dest_profile: ProfileConfigurationElement): ProfileConfigurationElement {
        const default_profile: ProfileConfigurationElement = this.default_inteface();
        if (source_profile.all_networks != default_profile.all_networks) dest_profile.all_networks = source_profile.all_networks;
        if (source_profile.disable_autoneg != default_profile.disable_autoneg) dest_profile.disable_autoneg = source_profile.disable_autoneg;
        if (source_profile.disabled != default_profile.disabled) dest_profile.disabled = source_profile.disabled;
        if (source_profile.duplex != default_profile.duplex) dest_profile.duplex = source_profile.duplex;
        if (source_profile.speed != default_profile.speed) dest_profile.speed = source_profile.speed;
        if (source_profile.enable_mac_auth != default_profile.enable_mac_auth) dest_profile.enable_mac_auth = source_profile.enable_mac_auth;
        if (source_profile.enable_qos != default_profile.enable_qos) dest_profile.enable_qos = source_profile.enable_qos;
        if (source_profile.mac_auth_only != default_profile.mac_auth_only) dest_profile.mac_auth_only = source_profile.mac_auth_only;
        if (source_profile.mac_limit != default_profile.mac_limit) dest_profile.mac_limit = source_profile.mac_limit;
        if (source_profile.mode != default_profile.mode) dest_profile.mode = source_profile.mode;
        if (source_profile.mtu != default_profile.mtu) dest_profile.mtu = source_profile.mtu;
        if (source_profile.networks != default_profile.networks) dest_profile.networks = source_profile.networks;
        if (source_profile.poe_disabled != default_profile.poe_disabled) dest_profile.poe_disabled = source_profile.poe_disabled;
        if (source_profile.port_auth != default_profile.port_auth) dest_profile.port_auth = source_profile.port_auth;
        if (source_profile.rejected_network != default_profile.rejected_network) dest_profile.rejected_network = source_profile.rejected_network;
        if (source_profile.stp_edge != default_profile.stp_edge) dest_profile.stp_edge = source_profile.stp_edge;
        if (source_profile.voip_network != default_profile.voip_network) dest_profile.voip_network = source_profile.voip_network;
        if (source_profile.port_network != default_profile.port_network) dest_profile.port_network = source_profile.port_network;
        if (source_profile.persist_mac != default_profile.persist_mac) dest_profile.persist_mac = source_profile.persist_mac;
        if (source_profile.guest_network != default_profile.guest_network) dest_profile.guest_network = source_profile.guest_network;
        if (source_profile.bypass_auth_when_server_down != default_profile.bypass_auth_when_server_down) dest_profile.bypass_auth_when_server_down = source_profile.bypass_auth_when_server_down;
        return dest_profile
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

    // Function to find or create entry for a specific port
    private get_inteface_from_junos_interfaces(port: string, junos_interfaces: JunosInterfaceElements,): [ProfileConfigurationElement, string[]] {
        var profile = junos_interfaces[port]?.profile;
        var blocks = junos_interfaces[port]?.blocks;
        if (!profile) {
            if (port in this.interface_ranges) {
                profile = this.interface_ranges[port].profile;
                blocks = this.interface_ranges[port].blocks;
            }
            else {
                var tmp = { desc: "", profile: this.default_inteface(), blocks: [] }
                junos_interfaces[port] = tmp;
                profile = tmp.profile;
                blocks = tmp.blocks;
            }
        }
        return [profile, blocks];
    }

    /************************* INTERFACE *************************/
    private parse_description(desc_line: string, port: string, junos_interfaces: JunosInterfaceElements): void {
        if (port in junos_interfaces) var entry = junos_interfaces[port];
        else {
            entry = { desc: "", profile: this.default_inteface(), blocks: [] }
            junos_interfaces[port] = entry;
        }
        entry.desc = desc_line.replace(port + " description ", "").replace(/\"/g, "").trim();;
    }

    private parse_interface_dot1x(dot1x_lines: string[], junos_interfaces: JunosInterfaceElements): void {
        dot1x_lines.forEach((line: string) => {
            var data = line.replace("set protocols dot1x authenticator interface ", " ").trim();
            var port = data.split(" ")[0].trim();
            var profile
            var blocks
            [profile, blocks] = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
            blocks.push(line);

            profile.port_auth = "dot1x";
            if (data.trim().startsWith(port + " mac-radius authentication-protocol ")) profile.enable_mac_auth = true;
            else if (data.trim().startsWith(port + " mac-radius restrict")) profile.mac_auth_only = true;
            else if (data.trim().startsWith(port + " guest-vlan ")) profile.guest_network = data.replace(port + " guest-vlan ", "").trim();
            else if (data.trim().startsWith(port + " server-fail use-cache")) profile.bypass_auth_when_server_down = true;
        })
    }

    private parse_interface_qos(qos_lines: string[], junos_interfaces: JunosInterfaceElements) {
        qos_lines.forEach((line: string) => {
            var data = line.replace("set class-of-service interfaces ", " ").trim();
            var port = data.split(" ")[0].trim();
            var profile
            var blocks
            [profile, blocks] = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
            blocks.push(line);
            profile.enable_qos = true;
        })
    }

    private parse_interface_poe(poe_lines: string[], junos_interfaces: JunosInterfaceElements) {
        poe_lines.forEach((line: string) => {
            var data = line.replace("set poe interface ", " ").trim();
            var port = data.split(" ")[0].trim();
            var config = data.split(" ")[1];
            if (config && config.trim() == "disable") {
                var profile
                var blocks
                [profile, blocks] = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
                blocks.push(line);
                profile.poe_disabled = true;
            }
        })
    }

    private parse_interface_rstp(rstp_lines: string[], junos_interfaces: JunosInterfaceElements) {
        rstp_lines.forEach((line: string) => {
            var data = line.replace("set protocols rstp interface ", " ").trim();
            var port = data.split(" ")[0].trim();
            var config = data.split(" ")[1];
            if (config && config.trim() == "edge") {
                var profile
                var blocks
                [profile, blocks] = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
                blocks.push(line);
                profile.stp_edge = true;
            }
        })
    }

    private parse_interface_sw_options(sw_options_lines: string[], junos_interfaces: JunosInterfaceElements) {
        sw_options_lines.forEach((line: string) => {
            var data: string = "";
            var config_type: string = "";
            if (line.startsWith("set switch-options interface ")) {
                data = line.replace("set switch-options interface ", " ").trim();
            } else if (line.startsWith("set switch-options voip interface ")) {
                data = line.replace("set switch-options voip interface ", " ").trim();
                config_type = "voip";
            }
            if (data) {
                var data_splitted = data.split(" ")
                if (data_splitted.length > 2) {
                    var port = data_splitted[0].trim();
                    var config = data_splitted[1].trim();
                    var profile
                    var blocks
                    [profile, blocks] = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
                    blocks.push(line);
                    if (config == "interface-mac-limit") {
                        var mac_limit: number = Number(data.replace(port + " interface-mac-limit ", "").trim());
                        if (mac_limit) profile.mac_limit = mac_limit;
                    }
                    else if (config_type == "voip" && config == "vlan") profile.voip_network = data.replace(port + " vlan ", "").trim();
                }
            }
        })
    }

    private parse_config_profile(name: string, entry: ProfileConfigurationElement, data: string) {
        if (data.trim().startsWith(name + " disabled ")) entry.disabled = true;
        else if (data.trim().startsWith(name + " mtu ")) entry.mtu = data.replace(name + " mtu ", "").trim();
        else if (data.trim().startsWith(name + " speed ")) entry.speed = data.replace(name + " speed ", "").trim();
        else if (data.trim().startsWith(name + " link-mode ")) entry.duplex = data.replace(name + " link-mode ", "").split("-")[0].trim();
        else if (data.trim().startsWith(name + " ether-options 802.3ad ")) {
            var lag_name = data.replace(name + " ether-options 802.3ad ", "");
            this.config_data.add_lag_interface(this.filename, name, lag_name);
        }
        else if (data.trim().startsWith(name + " ether-options no-auto-negotiation")) entry.disable_autoneg = true;
        else if (data.trim().startsWith(name + " native-vlan-id ")) entry.port_network = this.config_data.get_vlan(data.replace(name + " native-vlan-id ", "").trim(), this.filename);
        else if (data.trim().includes(" family ethernet-switching vlan members ")) {
            var vlan = data.split("members")[1].trim();
            if (vlan == "all") entry.all_networks = true;
            else if (vlan.match(/^[0-9]+$/)) entry.networks!.push(vlan); // in case vlan id is used
            // in case vlan range is defined with integer range 100-110, one-by-one vlan retrive the nam and add it to list entry.networks!.push(new_vlan)
            else if (vlan.match(/^[0-9-]+$/)) {
                const vlan_start: number = Number(vlan.split("-")[0]);
                const vlan_end: number = Number(vlan.split("-")[1]);
                if (vlan_start > 0 && vlan_end > 0) {
                    if (vlan_end - vlan_start > 100) {
                        for (var vlan_id in this.config_data.vlans) {
                            if (Number(vlan_id) >= vlan_start && Number(vlan_id) <= vlan_end) {
                                entry.networks!.push(vlan_id);
                            }
                        }
                    } else {
                        for (var vlan_curr = vlan_start; vlan_curr <= vlan_end; vlan_curr++) {
                            var new_vlan = this.config_data.get_vlan(vlan_curr.toString(), this.filename);
                            if (typeof new_vlan == "string") entry.networks!.push(new_vlan);
                            //else this._juniper_logger.error("Missing VLAN " + new_vlan, this.filename);
                        }
                    }
                } else this._juniper_logger.error("Unable to parse VLANs in " + data, this.filename);
            }
            else { // else vlan name is defined, we need replace "-" with "_" and lowercase to mathc MIST standard
                if (typeof vlan == "string") entry.networks!.push(vlan.toLowerCase().replace(/[ &:-]+/g, "_"));
            }
        }
        else if (data.trim().includes(" family ethernet-switching interface-mode trunk")) entry.mode = "trunk";
    }

    private parse_interface(interface_lines: string[], dot1x_lines: string[], qos_lines: string[], poe_lines: string[], rstp_lines: string[], sw_options_lines: string[]) {
        var junos_interfaces: JunosInterfaceElements = {};
        this.parse_interface_dot1x(dot1x_lines, junos_interfaces);
        this.parse_interface_qos(qos_lines, junos_interfaces);
        this.parse_interface_poe(poe_lines, junos_interfaces);
        this.parse_interface_rstp(rstp_lines, junos_interfaces);
        this.parse_interface_sw_options(sw_options_lines, junos_interfaces);
        interface_lines.forEach((line: string) => {
            var data = line.replace("set interfaces ", "").trim();
            var port = data.split(" ")[0].trim().split(".")[0];

            if (!port.startsWith("irb") && !port.startsWith("me") && !port.startsWith("vme") && !port.startsWith("em") && !port.startsWith("lo")) {
                var profile
                var blocks
                [profile, blocks] = this.get_inteface_from_junos_interfaces(port, junos_interfaces);
                blocks.push(line);
                if (data.trim().startsWith(port + " description ")) this.parse_description(data, port, junos_interfaces);
                else this.parse_config_profile(port, profile, data);
            }
        })

        for (var interface_name in junos_interfaces) {
            var interface_data = junos_interfaces[interface_name].profile;
            this.check_generated_profiles(interface_data);
            var message = "Interface " + interface_name + ": ";
            if (interface_data.mode == "access") message += "\"switchport mode\" access and \"switchport access vlan\" " + interface_data.port_network;
            else {
                message += "\"switchport mode\" trunk with";
                if (interface_data.port_network) message += " \"native vlan\" " + interface_data.port_network + " and";
                if (interface_data.all_networks) message += " ALL networks allowed";
                else message += " \"switchport trunk allowed vlan\" " + interface_data.networks;
            }
            this._juniper_logger.info(message, this.filename);

            if (interface_data.speed != "auto" && interface_data.duplex != "auto") {
                this._juniper_logger.info("Interface " + interface_name + ": \"speed\" and/or \"duplex\". Disabling auto_neg", this.filename);
            }


            if (interface_data.port_auth == "dot1x") {
                message = "Interface " + interface_name + ": dot1x enabled";
                if (interface_data.mac_auth_only) message += " with MAC Auth only";
                else if (interface_data.enable_mac_auth) message += " with MAC Auth";
                this._juniper_logger.info(message, this.filename);
            }

        }

        this.add_profile(junos_interfaces);
    }


    /************************* SAVE DATA *************************/
    private check_generated_profiles(profile: ProfileConfigurationElement): void {
        if (profile.mode == "access" && profile.networks && !profile.port_network) {
            profile.port_network = profile.networks[0];
            profile.networks = [];
        }
        if (profile.port_network) profile.port_network = this.check_vlan(profile.port_network);
        if (profile.guest_network) profile.guest_network = this.check_vlan(profile.guest_network);
        if (profile.rejected_network) profile.rejected_network = this.check_vlan(profile.rejected_network);
        if (profile.voip_network) profile.voip_network = this.check_vlan(profile.voip_network);
        if (profile.networks!.length > 0) {
            var tmp: string[] = [];
            profile.networks!.forEach((vlan: string) => {
                tmp.push(this.check_vlan(vlan));
            })
            profile.networks = tmp;
        }
    }

    private check_vlan(vlan_string: string): string {
        try {
            var vlan_id: number = Number(vlan_string);
            if (vlan_id > 0) var vlan_name = this.config_data.get_vlan(vlan_id.toString(), this.filename);
            if (vlan_name) return vlan_name
        } catch {
            return vlan_string;
        }
        return vlan_string;
    }

    private add_profile(junos_interfaces: JunosInterfaceElements) {
        for (var interface_name in junos_interfaces) {
            var range_names: string[] = [];
            var range_blocks: string[] = [];
            var range_profile: ProfileConfigurationElement | undefined;
            [range_names, range_blocks, range_profile] = this.find_interface_ranges(interface_name);

            if (range_names && range_profile) {
                var interface_config: ProfileConfigurationElement = this.merge_profiles(junos_interfaces[interface_name].profile, range_profile);
                junos_interfaces[interface_name].blocks = junos_interfaces[interface_name].blocks.concat(range_blocks);
            }
            else {
                var interface_config: ProfileConfigurationElement = junos_interfaces[interface_name].profile;
            }

            var uuid = this.config_data.add_profile(interface_config, interface_name, junos_interfaces[interface_name].desc, range_names, this.filename);
            this.config_data.add_interface(this.filename, this.hostname, interface_name, uuid, "Junos", junos_interfaces[interface_name].blocks, junos_interfaces[interface_name].desc);
        }
    }

}