import { ProfileConfigurationElement, VlansElements } from "./mist_template"
import { Logger } from "../services/logger";
import { ConfigData, ConfigFile } from "./parser_main";

interface InterfaceRangesElement {
    [key: string]: {
        ports: InterfaceRangePortElement[],
        profile: ProfileConfigurationElement
    }
}

interface InterfaceRangePortElement {
    int_type: string,
    fpc_min: number,
    fpc_max: number,
    pic_min: number,
    pic_max: number,
    port_min: number,
    port_max: number,
}

interface JunosProfileElement {
    desc: string,
    profile: ProfileConfigurationElement
}

interface JunosInterfaceElements {
    [key: string]: JunosProfileElement
}


export class JuniperParser {

    interface_ranges: InterfaceRangesElement = {};

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
            var has_vlan_list: boolean = false;
            config_file.config.forEach((line: string) => {
                if (line.startsWith("set vlans")) {
                    vlan.push(line);
                    has_vlan_list = true;
                };
            })
            if (has_vlan_list) {
                this._juniper_logger.info("VLAN database extracted from " + config_file.name + ", processing it")
                this.parse_vlans(vlan).then((res) => {
                    resolve(res)
                });
            } else {
                this._juniper_logger.warning("No VLAN database found in the file");
                resolve(false);
            }
        })
    }
    
    private parse_vlans(vlan_conf: string[]): Promise<boolean> {
        return new Promise((resolve) => {
            var deteted_vlans: number = 0;
            var new_vlans: number = 0;
            const re_vlan: RegExp = /set vlans (?<vlan_name>[^ ]+) vlan-id (?<vlan_id>[0-9]+)/guis;
            if (vlan_conf.length > 0) {
                vlan_conf.forEach((line: string) => {
                    var test = line.match(re_vlan);
                    if (test) {
                        var regex_result = re_vlan.exec(line);
                        if (regex_result?.groups?.["vlan_id"] && regex_result?.groups?.["vlan_name"]) {
                            var vlan_id = regex_result.groups?.["vlan_id"];
                            var vlan_name = regex_result.groups?.["vlan_name"].toLowerCase().replace(/[ &:-]+/g, "_");
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
                this._juniper_logger.info(deteted_vlans + " VLANs detected. " + new_vlans + " new VLAN(s) learned");
                resolve(true);
            } else {
                this._juniper_logger.warning("No VLANs detected");
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
            this.interface_ranges = {};
            var config: string[] = [];
            config_file.config.forEach((line: string) => {
                if (line.startsWith("set")) config.push(line)
            })
            this._juniper_logger.info("Configuration extracted from " + config_file.name + ", processing it")
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
                else if (line.startsWith("set system login message")) this.config_data.banner = line.replace("set system login message", "").trim().replace(/^"|"$/g, "").replace(/\\n/g, "\\\\n");
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
            this._juniper_logger.info("DHCP Snooping: Adding VLAN " + vlan_id);
            this.config_data.dhcp_snooping_vlans.push(vlan_id);
        }
    }

    private parse_dhcp_snooping(dhcp_snooping_lines: string[]) {
        const regex_vlan_def = /^set vlans (?<vlan_name>[^ ]+) vlan-id (?<vlan_id>\d+)$/
        const regex_snooping = /^set vlans (?<vlan_name>[^ ]+) forwarding-options dhcp-security$/
        var vlans: VlansElements = {}
        dhcp_snooping_lines.forEach((line: string) => {
            var vlan_def = regex_vlan_def.exec(line.replace(/\r/, ""));
            var snoop_def = regex_snooping.exec(line.replace(/\r/, ""));
            if (vlan_def) {
                var vlan_id = vlan_def.groups?.["vlan_id"];
                var vlan_name = vlan_def.groups?.["vlan_name"].toLowerCase().replace(/[ &:-]+/g, "_");
                if (vlan_name && vlan_id) vlans[vlan_name] = [vlan_id];
            } else if (snoop_def) {
                var vlan_name = snoop_def.groups?.["vlan_name"].toLowerCase().replace(/[ &:-]+/g, "_");
                if (vlan_name) this.add_dhcp_snooping_vlan(vlans[vlan_name][0]);
            }
        })
    }

    /************************* SYSLOG *************************/
    private add_syslog(syslog_ip: string, syslog_proto: string, syslog_port: string): void {
        var new_syslog: string = JSON.stringify({
            "host": syslog_ip, "protocol": syslog_proto, "port": syslog_port, "contents": [
                {
                    "facility": "any",
                    "severity": "any"
                }
            ]
        })
        if (!this.config_data.syslog.includes(new_syslog)) {
            this._juniper_logger.info("SYSLOG servers: Adding " + syslog_ip + " " + syslog_proto + ":" + syslog_port);
            this.config_data.syslog.push(new_syslog);
        }
    }

    private parse_syslog(syslog_lines: string[]): void {
        var syslog_ip: string = ""
        var syslog_port: string = "514"
        var syslog_proto: string = "udp"
        syslog_lines.forEach((line: string, index: number) => {
            var syslog_config: string[] = line.replace("set system syslog host", "").trim().split(" ");
            if (syslog_ip && syslog_ip != syslog_config[0]) this.add_syslog(syslog_ip, syslog_proto, syslog_port);
            if (!syslog_ip || syslog_ip != syslog_config[0]) syslog_ip = syslog_config[0];
            if (syslog_config[1] == "port") syslog_port = syslog_config[2];
            if (index == syslog_lines.length - 1) this.add_syslog(syslog_ip, syslog_proto, syslog_port);
        })
    }

    /************************* DOMAIN/DNS/NTP *************************/
    private parse_domain(domain_line: string) {
        var new_domain: string = domain_line.replace("set system domain-search", "").trim().split(" ")[0];
        if (!this.config_data.domain.includes(new_domain)) {
            this._juniper_logger.info("DNS DOMAINs: Adding " + new_domain);
            this.config_data.domain.push(new_domain);
        }
    }

    private parse_dns(dns_line: string) {
        var new_dns: string = dns_line.replace("set system name-server", "").trim().split(" ")[0];
        if (!this.config_data.dns.includes(new_dns)) {
            this._juniper_logger.info("DNS servers: Adding " + new_dns);
            this.config_data.dns.push(new_dns);
        }
    }

    private parse_ntp(ntp_line: string) {
        var new_ntp: string = ntp_line.replace("set system ntp server", "").trim().split(" ")[0];
        if (!this.config_data.ntp.includes(new_ntp)) {
            this._juniper_logger.info("NTP servers: Adding " + new_ntp);
            this.config_data.ntp.push(new_ntp);
        }
    }

    /************************* TACACS *************************/
    private add_tacacs_auth(tacacs_ip: string, tacacs_port: string) {
        var tmp = JSON.stringify({
            "host": tacacs_ip,
            "port": tacacs_port,
            "secret": "to_be_replaced",
            "timeout": 10
        })
        if (!this.config_data.tacacs_auth.includes(tmp)) {
            this._juniper_logger.info("TACACS+ Auth servers: Adding " + tacacs_ip + ":" + tacacs_port);
            this.config_data.tacacs_auth.push(tmp);
        }
    }

    private async parse_tacacs_auth(tacas_lines: string[]) {
        var tacacs_ip: string = "";
        var tacacs_port: string = "";
        tacas_lines.forEach((line: string, index: number) => {
            var tacacs_config: string[] = line.replace("set system tacplus-server ", "").trim().split(" ");
            if (tacacs_ip && tacacs_ip != tacacs_config[0]) this.add_tacacs_auth(tacacs_ip, tacacs_port);
            if (!tacacs_ip || tacacs_ip != tacacs_config[0]) tacacs_ip = tacacs_config[0];
            if (tacacs_config[1] == "port") tacacs_port = tacacs_config[2];
            if (index == tacas_lines.length - 1) this.add_tacacs_auth(tacacs_ip, tacacs_port);
        })
    }

    private add_tacacs_acct(tacacs_ip: string, tacacs_port: string) {
        var tmp = JSON.stringify({
            "host": tacacs_ip,
            "port": tacacs_port,
            "secret": "to_be_replaced",
            "timeout": 10
        })
        if (!this.config_data.tacacs_acct.includes(tmp)) {
            this._juniper_logger.info("TACACS+ Acct servers: Adding " + tacacs_ip + ":" + tacacs_port);
            this.config_data.tacacs_acct.push(tmp);
        }
    }

    private parse_tacacs_acct(tacas_lines: string[]): void {
        var tacacs_ip: string = "";
        var tacacs_port: string = "";
        tacas_lines.forEach((line: string, index: number) => {
            var tacacs_config: string[] = line.replace("set system accounting destination tacplus server ", "").trim().split(" ");
            if (tacacs_ip && tacacs_ip != tacacs_config[0]) this.add_tacacs_acct(tacacs_ip, tacacs_port);
            if (!tacacs_ip || tacacs_ip != tacacs_config[0]) tacacs_ip = tacacs_config[0];
            if (tacacs_config[1] == "port") tacacs_port = tacacs_config[2];
            if (index == tacas_lines.length - 1) this.add_tacacs_acct(tacacs_ip, tacacs_port);
        })
    }

    /************************* RADIUS *************************/
    private add_radius(radius_ip: string, radius_auth_port: string, radius_acct_port: string, radius_coa_port: string, radius_timeout: number) {
        if (radius_auth_port) {
            var tmp = JSON.stringify({
                "host": radius_ip,
                "port": radius_auth_port,
                "secret": "to_be_replaced",
                "timeout": radius_timeout
            })
            if (!this.config_data.radius_auth.includes(tmp)) {
                this._juniper_logger.info("RADIUS Auth servers: Adding " + radius_ip + ":" + radius_auth_port);
                this.config_data.radius_auth.push(tmp);
            }
        }
        if (radius_acct_port) {
            var tmp = JSON.stringify({
                "host": radius_ip,
                "port": radius_acct_port,
                "secret": "to_be_replaced",
                "timeout": radius_timeout
            })
            if (!this.config_data.radius_acct.includes(tmp)) {
                this._juniper_logger.info("RADIUS Acct servers: Adding " + radius_ip + ":" + radius_acct_port);
                this.config_data.radius_acct.push(tmp);
            }
            if (radius_coa_port) this.config_data.radius_coa = {
                "coa_enabled": true,
                "coa_port": radius_coa_port
            }
        }
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
    private add_interface_range(ir_name: string, ports: InterfaceRangePortElement): void {
        if (ir_name in this.interface_ranges) {
            this.interface_ranges[ir_name].ports.push(ports)
        } else {
            this.interface_ranges[ir_name] = {
                ports: [ports],
                profile: this.default_inteface()
            }
        }
    }

    private get_interface_range(ir_name: string): ProfileConfigurationElement {
        return this.interface_ranges[ir_name].profile;
    }
    
    private async parse_interface_ranges(interface_range_lines: string[]) {
        const re_interface_member: RegExp = /^set interfaces interface-range (?<name>[^ ]+) member "?(?<type>[a-z]+)-\[?(?<fpc>[0-9-]+)\]?\/\[?(?<pic>[0-9-]+)\]?\/\[?(?<port>[0-9-]+)\]?"?$/;
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
                    var ports: InterfaceRangePortElement = {
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
                    this._juniper_logger.warning("Unable to parse " + line)
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
                    var ports: InterfaceRangePortElement = {
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
                    this._juniper_logger.warning("Unable to parse " + line)
                }
            } else {
                var data = line.replace("set interfaces interface-range ", "").trim();
                var port = data.split(" ")[0].trim().split(".")[0];
                var entry = this.get_interface_range(port);
                this.parse_config_test(port, entry, data);
            }
        })
    }

    private find_interface_ranges(interface_name: string): [string[], ProfileConfigurationElement] | [string[], undefined] {
        const re_interface_range: RegExp = /^(?<type>[a-z]+)-\[?(?<fpc>[0-9-]+)\]?\/\[?(?<pic>[0-9-]+)\]?\/\[?(?<port>[0-9-]+)\]?"?$/;
        const data = re_interface_range.exec(interface_name);
        var assigned_ir_names: string[] = []
        var assigned_ir_profiles: ProfileConfigurationElement[] = []
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
                        assigned_ir_profiles.push(this.interface_ranges[ir_name].profile);
                    }
                }
            }
            if (assigned_ir_names.length == 1) return [assigned_ir_names, assigned_ir_profiles[0]];
            if (assigned_ir_names.length > 1) {
                var profile: ProfileConfigurationElement = this.default_inteface();
                for (var i = 0; i < assigned_ir_profiles.length; i++) {
                    profile = this.merge_profiles(assigned_ir_profiles[i], profile);
                }
                return [assigned_ir_names, profile];
            }
        }
        return [[], undefined]
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
    private get_inteface_from_junos_interfaces(port: string, junos_interfaces: JunosInterfaceElements,): ProfileConfigurationElement {
        var entry = junos_interfaces[port]?.profile;
        if (!entry) {
            if (port in this.interface_ranges) var entry = this.interface_ranges[port].profile;
            else {
                var tmp = { desc: "", profile: this.default_inteface() }
                junos_interfaces[port] = tmp;
                var entry = tmp.profile;
            }
        }
        return entry;
    }

    private parse_description(desc_line: string, port: string, junos_interfaces: JunosInterfaceElements): void {
        if (port in junos_interfaces) var entry = junos_interfaces[port];
        else {
            var entry = { desc: "", profile: this.default_inteface() }
            junos_interfaces[port] = entry;
        }
        entry.desc = desc_line.replace(port + " description", "").replace(/\"/g, "").trim();;
    }

    private parse_interface_dot1x(dot1x_lines: string[], junos_interfaces: JunosInterfaceElements): void {
        dot1x_lines.forEach((line: string) => {
            var data = line.replace("set protocols dot1x authenticator interface ", " ").trim();
            var port = data.split(" ")[0].trim();
            var entry = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);

            entry.port_auth = "dot1x";
            if (data.trim().startsWith(port + " mac-radius authentication-protocol ")) entry.enable_mac_auth = true;
            else if (data.trim().startsWith(port + " mac-radius restrict")) entry.mac_auth_only = true;
            else if (data.trim().startsWith(port + " guest-vlan ")) entry.guest_network = data.replace(port + " guest-vlan ", "").trim();
            else if (data.trim().startsWith(port + " server-fail use-cache")) entry.bypass_auth_when_server_down = true;
        })
    }

    private parse_interface_qos(qos_lines: string[], junos_interfaces: JunosInterfaceElements) {
        qos_lines.forEach((line: string) => {
            var data = line.replace("set class-of-service interfaces ", " ").trim();
            var port = data.split(" ")[0].trim();
            var entry = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
            entry.enable_qos = true;
        })
    }

    private parse_interface_poe(poe_lines: string[], junos_interfaces: JunosInterfaceElements) {
        poe_lines.forEach((line: string) => {
            var data = line.replace("set poe interface ", " ").trim();
            var port = data.split(" ")[0].trim();
            var config = data.split(" ")[1];
            if (config && config.trim() == "disable") {
                var entry = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
                entry.poe_disabled = true;
            }
        })
    }

    private parse_interface_rstp(rstp_lines: string[], junos_interfaces: JunosInterfaceElements) {
        rstp_lines.forEach((line: string) => {
            var data = line.replace("set protocols rstp interface ", " ").trim();
            var port = data.split(" ")[0].trim();
            var config = data.split(" ")[1];
            if (config && config.trim() == "edge") {
                var entry = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
                entry.stp_edge = true;
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
                var port = data.split(" ")[0].trim();
                var config = data.split(" ")[1].trim();
                var entry = this.get_inteface_from_junos_interfaces(port.split(".")[0], junos_interfaces);
                if (config == "interface-mac-limit") {
                    var mac_limit: number = Number(data.replace(port + " interface-mac-limit ", "").trim());
                    if (mac_limit) entry.mac_limit = mac_limit;
                }
                else if (config_type == "voip" && config == "vlan") entry.voip_network = data.replace(port + " vlan ", "").trim();
            }
        })
    }

    private parse_config_test(name: string, entry: ProfileConfigurationElement, data: string) {
        if (data.trim().startsWith(name + " disabled ")) entry.disabled = true;
        else if (data.trim().startsWith(name + " mtu ")) entry.mtu = data.replace(name + " mtu ", "").trim();
        else if (data.trim().startsWith(name + " speed ")) {
            entry.speed = data.replace(name + " speed ", "").trim();
        }
        else if (data.trim().startsWith(name + " link-mode ")) entry.duplex = data.replace(name + " link-mode ", "").split("-")[0].trim();
        else if (data.trim().startsWith(name + " ether-options no-auto-negotiation")) entry.disable_autoneg = true;
        else if (data.trim().startsWith(name + " native-vlan-id ")) entry.port_network = this.get_vlan(data.replace(name + " native-vlan-id ", "").trim());
        else if (data.trim().includes(" family ethernet-switching vlan members ")) {
            var vlan = data.split("members")[1].trim();
            if (vlan == "all") entry.all_networks = true;
            else entry.networks!.push(vlan);
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
                var entry = this.get_inteface_from_junos_interfaces(port, junos_interfaces);
                if (data.trim().startsWith(port + " description ")) this.parse_description(data, port, junos_interfaces);
                else this.parse_config_test(port, entry, data);
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
            this._juniper_logger.info(message);

            if (interface_data.speed != "auto" && interface_data.duplex != "auto") {
                this._juniper_logger.info("Interface " + interface_name + ": \"speed\" and/or \"duplex\". Disabling auto_neg");
            }


            if (interface_data.port_auth == "dot1x") {
                message = "Interface " + interface_name + ": dot1x enabled";
                if (interface_data.mac_auth_only) message += " with MAC Auth only";
                else if (interface_data.enable_mac_auth) message += " with MAC Auth";
                this._juniper_logger.info(message);
            }

        }

        this.add_profile(junos_interfaces);
    }

    private get_vlan(vlan_id: string) {
        if (vlan_id) {
            try {
                if (this.config_data.vlans.hasOwnProperty(vlan_id)) return this.config_data.vlans[vlan_id][0];
                else {
                    this._juniper_logger.error("unable to find vlan name for vlan_id " + vlan_id);
                    console.error(vlan_id);
                    console.error(this.config_data.vlans);
                }
            } catch {
                this._juniper_logger.error("error when trying to get vlan name for vlan_id " + vlan_id);
                console.error(vlan_id);
                console.error(this.config_data.vlans);
            }
        }
        return undefined;
    }



    private save_interface(interface_name: string, interface_config: ProfileConfigurationElement, description: string | undefined, range_names: string[]) {
        var str_profile_configuration = JSON.stringify(interface_config);
        var index = this.config_data.port_profile_configs.indexOf(str_profile_configuration);
        if (index < 0) {
            this.config_data.port_profile_configs.push(str_profile_configuration);
            if (description) this.config_data.port_descriptions.push([description]);
            else this.config_data.port_descriptions.push([]);

            this.config_data.interface_names.push([interface_name]);
            this.config_data.interface_range_names.push(range_names);
            this._juniper_logger.info("New interface profile added");
        } else {
            if (description && !this.config_data.port_descriptions[index].includes(description)) this.config_data.port_descriptions[index].push(description);
            range_names.forEach((range_name: string) => {
                if (!this.config_data.interface_range_names[index].includes(range_name)) this.config_data.interface_range_names[index].push(range_name);
            })
            this.config_data.interface_names[index].push(interface_name);
        }
    }

    private check_vlan(vlan_string: string): string {
        try {
            var vlan_id: number = Number(vlan_string);
            if (vlan_id > 0) var vlan_name = this.get_vlan(vlan_id.toString());
            if (vlan_name) return vlan_name
        } catch {
            return vlan_string;
        }
        return vlan_string;
    }

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


    private add_profile(junos_interfaces: JunosInterfaceElements) {
        for (var interface_name in junos_interfaces) {
            var range_names: string[] = [];
            var range_profile: ProfileConfigurationElement | undefined;
            [range_names, range_profile] = this.find_interface_ranges(interface_name);

            if (range_names && range_profile) {
                var interface_config: ProfileConfigurationElement = this.merge_profiles(junos_interfaces[interface_name].profile, range_profile);
            }
            else {
                var interface_config: ProfileConfigurationElement = junos_interfaces[interface_name].profile;
            }
            this.save_interface(interface_name, interface_config, junos_interfaces[interface_name].desc, range_names)
        }
    }

}