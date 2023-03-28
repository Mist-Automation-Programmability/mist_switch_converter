import { IosParser } from "./parser_ios";
import { JuniperParser } from "./parser_juniper";
import { ConfigData } from "./parser_config";
import { Logger } from "../services/logger";
import { MistTemplateElement } from "./mist_template"

export interface ConfigFile {
    name: string,
    config: string[],
    format: string,
    success_vlan: boolean | undefined,
    success_config: boolean | undefined,
    error_message: string
}


export class ConfigParser {
    config_data = new ConfigData(this._logger);
    process_done: boolean = false;

    parser_ios = new IosParser(this._logger, this.config_data);
    parser_juniper = new JuniperParser(this._logger, this.config_data);

    constructor(
        private _logger: Logger
    ) {

    }


    /////////////////////////////////////////////////////////////////

    private process_config(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            if (config_file.format == "Cisco") {
                this.parser_ios.process_config(config_file).then((res) => resolve(res));
            } else if (config_file.format == "Juniper") {
                this.parser_juniper.process_config(config_file).then((res) => resolve(res))
            }
            else resolve(false);
        })
    }

    private process_vlans(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            if (config_file.format == "Cisco") {
                this.parser_ios.process_vlans(config_file).then((res) => resolve(res));
            } else if (config_file.format == "Juniper") {
                this.parser_juniper.process_vlans(config_file).then((res) => resolve(res))
            }
            else resolve(false);
        })
    }

    detect_source(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            config_file.config.forEach((line: string) => {
                if (line.startsWith("!")) {
                    config_file.format = "Cisco";
                    resolve(true)
                }
                else if (line.startsWith("set")) {
                    config_file.format = "Juniper"
                    resolve(true)
                };
            })
            resolve(false);
        })
    }

    read_vlans(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            if (config_file.format == "Unknown") {
                this._logger.error("Unable to determinate the type of file. Please check the format of the file " + config_file.name);
                config_file.error_message = "Unable to determinate the type of file. check validate the format of the file " + config_file.name;
                resolve(false);
            } else this.process_vlans(config_file).then((res) => {
                if (!res) this._logger.error("Error when reading VLANs list from " + config_file.name)
                config_file.success_vlan = res;
                resolve(res);
            });
        })
    }

    read_config(config_file: ConfigFile): Promise<boolean> {
        return new Promise((resolve) => {
            if (config_file.format == "Unknown") {
                this._logger.error("Unable to determinate the type of file. Please check the format of the file " + config_file.name);
                config_file.error_message = "Unable to determinate the type of file. check validate the format of the file " + config_file.name;
                resolve(false);
            } else this.process_config(config_file).then((res) => {
                if (!res) {
                    this._logger.error("Error when reading configuration from " + config_file.name);
                    config_file.error_message = "Error when reading configuration from " + config_file.name;
                }
                resolve(res);
            });
        })
    }


    //////////////////:

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
                    if (!res) this._logger.error("Error when reading configuration from " + config_file.name)
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
                this._logger.info("Detecting type of file for " + file.name);
                file.config.forEach((line: string) => {
                    if (line.startsWith("Current configuration")) file.format = "Cisco";
                    else if (line.startsWith("set version")) file.format = "Juniper";
                })
                this._logger.info(file.name + " is detected as " + file.format + " type");
            })
            resolve(true)
        })
    }

    generate() {
        this.config_data.generate_profile_names();
        this.config_data.generate_template();
        this.process_done = true;
    }

    auto_convert(config_files: ConfigFile[]): Promise<MistTemplateElement> {
        return new Promise((resolve) => {
            var i = 0;
            this.detect_source_all(config_files).then((res) => {
                this.read_vlans_all(config_files).then((res) => {
                    this.read_config_all(config_files).then((res) => {
                        this.config_data.generate_profile_names();
                        this.config_data.generate_template();
                        this.process_done = true;
                        resolve(this.config_data.mist_template)
                    })
                })
            })
        })
    }

}