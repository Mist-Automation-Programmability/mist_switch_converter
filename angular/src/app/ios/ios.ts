import { IosParser } from "./ios_parser";
import { MistTemplate } from "./mist_template";
import { Logger } from "./../services/logger";

export interface IosFile {
    name: string,
    config: string[]
}

export class IoS {

    mist_config = new IosParser(this._logger);
    constructor(
        private _logger: Logger
    ) {}

    private process_config(ios_file:IosFile): Promise<boolean> {
        return new Promise((resolve) => {
            var config: string[] = [];
            var end_keyword: boolean = false;
            var current: string | undefined = undefined;
            ios_file.config.forEach((line: string) => {
                if (current == "config") {
                    if (line == "end") end_keyword = true;
                    if (end_keyword && line.length == 0) current = undefined;
                    else config.push(line)
                } else if (line.startsWith("Current configuration")) {
                    current = "config";
                }
            })
            this._logger.info("Configuration extracted from "+ios_file.name+", processing it")
            this.mist_config.parse_config(config).then((res) => resolve(res));
        })
    }

    private process_vlans(ios_file: IosFile): Promise<boolean> {
        return new Promise((resolve) => {
            var vlan: string[] = [];
            var current: string | undefined = undefined;
            var has_vlan_list: boolean = false;
            ios_file.config.forEach((line: string) => {
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
                this._logger.info("VLAN database extracted from "+ios_file.name+", processing it")
                this.mist_config.parse_vlans(vlan).then((res) => resolve(res));
            } else this._logger.warning("No VLAN database found in the file");
        })
    }


    private read_vlans(ios_files: IosFile[]): Promise<boolean> {
        this._logger.info("Reading VLANs from config files started");
        return new Promise((resolve) => {
            var i = 0;
            ios_files.forEach((ios_file: IosFile) => {
                this.process_vlans(ios_file).then((res) => {
                    if (!res) this._logger.error("Error when reading VLANs list from " + ios_file.name)
                    i++;
                    if (i == ios_files.length) {
                        resolve(true);
                    }
                });
            })
        })
    }

    private read_config(ios_files: IosFile[]): Promise<boolean> {
        this._logger.info("Reading configuration from config files started");
        return new Promise((resolve) => {
            var i = 0;
            ios_files.forEach((ios_file: IosFile) => {
                console.log(ios_file.name);
                this.process_config(ios_file).then((res) => {
                    if (!res) this._logger.error("Error when reading configuration list from " + ios_file.name)
                    i++;
                    if (i == ios_files.length) {
                        resolve(true);
                    }
                });
            })
        })
    }

    convert(ios_files: IosFile[]): Promise<MistTemplate> {
        return new Promise((resolve) => {
            var i = 0;
            this.read_vlans(ios_files).then((res) => {
                this.read_config(ios_files).then((res) => {
                    this.mist_config.generate_profile_names();
                    this.mist_config.generate_template();
                    resolve(this.mist_config.mist_template)
                })
            })
        })
    }

}