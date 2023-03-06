"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const path = require('path');
const readline = require('readline');
const ios_parser_1 = require("./ios_parser");
function process_config(folder, filename) {
    return new Promise((resolve) => {
        const readInterface = readline.createInterface({
            input: fs.createReadStream(path.join(folder, filename))
        });
        var config = [];
        var end_keyword = false;
        var current = undefined;
        readInterface.on('line', (line) => {
            if (current == "config") {
                if (line == "end")
                    end_keyword = true;
                if (end_keyword && line.length == 0)
                    current = undefined;
                else
                    config.push(line);
            }
            else if (line.startsWith("Current configuration")) {
                current = "config";
            }
        }).on("close", () => {
            mist_config.parse_config(config).then((res) => resolve(res));
        });
    });
}
function process_vlans(folder, filename) {
    return new Promise((resolve) => {
        const readInterface = readline.createInterface({
            input: fs.createReadStream(path.join(folder, filename))
        });
        var vlan = [];
        var current = undefined;
        var has_vlan_list = false;
        readInterface.on('line', (line) => {
            if (current == "vlan") {
                if (line.match(/^\d/))
                    vlan.push(line);
                else if (line.match(/^\w/)) {
                    current = undefined;
                }
            }
            else if (line.includes("VLAN Name")) {
                current = "vlan";
                has_vlan_list = true;
            }
            ;
        }).on("close", () => {
            mist_config.parse_vlans(vlan).then((res) => resolve(res));
        });
    });
}
function show_result() {
    console.log("--------------------------------------");
    console.log("--------------------------------SYSLOG");
    console.log(mist_config.syslog);
    console.log("--------------------------------------");
    console.log("---------------------------RADIUS AUTH");
    console.log(mist_config.radius_auth);
    console.log("--------------------------------------");
    console.log("---------------------------RADIUS ACCT");
    console.log(mist_config.radius_acct);
    console.log("--------------------------------------");
    console.log("--------------------------------TACACS");
    console.log(mist_config.tacacs);
    console.log("--------------------------------------");
    console.log("-----------------------------------NTP");
    console.log(mist_config.ntp);
    console.log("--------------------------------------");
    console.log("-----------------------------------DNS");
    console.log(mist_config.dns);
    console.log("--------------------------------------");
    console.log("--------------------------------DOMAIN");
    console.log(mist_config.domain);
    console.log("--------------------------------------");
    console.log("--------------------------------BANNER");
    console.log(mist_config.banner);
    console.log("--------------------------------------");
    console.log("----------------------------------VLANS");
    console.log(mist_config.vlans);
    console.log("--------------------------------------");
    console.log("------------------------------PROFILES");
    for (var i = 0; i < mist_config.ios_descriptions.length; i++) {
        console.log("--------------------------------------");
        console.log("profile name       : " + mist_config.port_profile_names[i]);
        console.log();
        console.log("ios descriptions   : " + mist_config.ios_descriptions[i].join(", "));
        console.log();
        console.log("ios config         : \r\n" + mist_config.ios_config[i]);
        console.log();
        console.log("profile config     : \r\n" + JSON.stringify(JSON.parse(mist_config.port_profile_configs[i]), undefined, 4));
        console.log();
    }
}
function read_vlans(folder, files) {
    return new Promise((resolve) => {
        var i = 0;
        files.forEach((filename) => {
            console.log(filename);
            process_vlans(folder, filename).then((res) => {
                if (!res)
                    console.error("Error when reading VLANs list from " + filename);
                i++;
                if (i == files.length) {
                    resolve(true);
                }
            });
        });
    });
}
function read_config(folder, files) {
    return new Promise((resolve) => {
        var i = 0;
        files.forEach((filename) => {
            console.log(filename);
            process_config(folder, filename).then((res) => {
                if (!res)
                    console.error("Error when reading VLANs list from " + filename);
                i++;
                if (i == files.length) {
                    resolve(true);
                }
            });
        });
    });
}
function start(folder, out_file) {
    var files = fs.readdirSync(folder);
    var i = 0;
    read_vlans(folder, files).then((res) => {
        read_config(folder, files).then((res) => {
            mist_config.generate_profile_names();
            mist_config.generate_template();
            show_result();
            fs.writeFile(out_file, JSON.stringify(mist_config.mist_template), (err) => {
                if (err)
                    console.error(err);
                else
                    console.log("Template saved in " + out_file);
            });
        });
    });
}
function usage() {
    console.log('' +
        'Script to convert Cisco IOS Configuration into a Mist Switch Template\r\n' +
        '\r\n' +
        'Parameters:\r\n' +
        '----------\r\n' +
        '--folder=          relative or absolute path to folder where the cisco configuration files are locater\r\n' +
        '--out=             name of the file where the Mist Switch Template will be saved. This file will be placed in the folder defined above\r\n');
}
/*******************************************************
 * ENTRY POINT
 */
const mist_config = new ios_parser_1.IosParser();
var config_folder = undefined;
var out_file = "template.json";
var show_usage = false;
process.argv.forEach((value) => {
    var param_key = value.split("=")[0];
    var param_val = value.split("=")[1];
    switch (param_key) {
        case "--folder":
            config_folder = path.resolve(param_val);
            break;
        case "--out":
            out_file = param_val;
            break;
        case "-h":
            usage();
            show_usage = true;
            break;
    }
});
if (config_folder)
    start(config_folder, out_file);
else if (!show_usage) {
    console.error("Please use the `--folder=` option to define the folder where the config files are located.");
    console.log();
    usage();
}
//# sourceMappingURL=ios.js.map