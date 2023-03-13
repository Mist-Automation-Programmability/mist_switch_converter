import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ConfigParser, ConfigFile } from "./converters/config_parser";
import { JsonToHtml } from "./common/function/json-to-html"
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { LogMessage, Logger } from "./services/logger";
import { MatListOption, MatSelectionListChange } from '@angular/material/list';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  title = 'switch migration';

  github_url!: string;
  docker_url!: string;
  disclaimer!: string;

  dragover: boolean = false;

  config_files: ConfigFile[] = [];
  config_files_selected: ConfigFile[] = [];
  mist_config_html: string = "";
  config_parser: ConfigParser = new ConfigParser(this._logger);
  json_to_html = new JsonToHtml();

  log_messages: LogMessage[] = [];
  show_logs: boolean = false;
  log_columns: string[] = ['level', 'message'];


  constructor(
    public _dialog: MatDialog,
    private _http: HttpClient,
    private _logger: Logger
  ) { }

  //// INIT ////
  ngOnInit(): void {
    this._http.get<any>("/api/disclaimer").subscribe({
      next: data => {
        if (data.disclaimer) this.disclaimer = data.disclaimer;
        if (data.github_url) this.github_url = data.github_url;
        if (data.docker_url) this.docker_url = data.docker_url;
      }
    })
  }

  //// FILES MANAGEMENT ////
  onFilechange(event: any) {
    if (event?.target?.files) {
      for (var index in Object(event.target.files)) {
        var done = 0;
        var file = event.target.files[index];
        if (file.type == "text/plain" || (typeof (file.name) == "string" && file.name.match(/\.cfg$|\.config$|\.txt$/))) {
          this.readfile(event.target.files[index]).then((res) => {
            this.addConfigFile(res);
            done += 1;
            if (done == event.target.files.length) this.processFiles();
          })
        }
      }
    }
  }

  addConfigFile(file: ConfigFile) {
    const index = this.config_files.findIndex(f => f.name == file.name);
    if (index > -1) this.config_files[index] = file;
    else this.config_files.push(file);
  }

  readfile(file: File): Promise<ConfigFile> {
    return new Promise((resolve) => {
      if (file) {
        var reader = new FileReader();
        reader.readAsText(file, "UTF-8");
        reader.onload = function (e) {
          const config_file: ConfigFile = {
            name: file.name,
            config: (reader.result as string)?.split('\n'),
            format: "unknown",
            success_vlan: undefined,
            success_config: undefined,
            error_message: "Unknown error"
          };
          resolve(config_file)
        }
        reader.onerror = function (evt) {
          console.log("error reading file " + file.name);
        }
      }
    })
  }

  // SELECT AND DELETE FILES //
  selectFile(event: MatSelectionListChange) {
    event.options.forEach((selection: MatListOption) => {
      var file = selection.value;
      var selected = selection.selected;
      var index = this.config_files_selected.indexOf(file);
      if (selected && index < 0) this.config_files_selected.push(file);
      else if (!selected && index > -1) {
        this.config_files_selected.splice(index, 1);
      }
    })
  }

  removeConfigFile() {
    if (this.config_files_selected.length > 0) {
      this.config_files_selected.forEach((file: ConfigFile) => {
        var index = this.config_files.indexOf(file);
        if (index > -1) {
          this.config_files.splice(index, 1);
        }
      })
      this.config_files_selected = [];
      this.reinitMistTemplate();
      this.processFiles();
    }
  }

  //// TEMPLATE MANAGEMENT ////
  reinitMistTemplate() {
    this.mist_config_html = "";
    this.config_parser = new ConfigParser(this._logger);
  }

  processFiles(): void {
    this.detect_source().then(() => {
      this.parse_vlans().then(() => {
        this.parse_config().then(() => {
          this.config_parser.generate_profile_names();
          this.config_parser.generate_template();
          this.log_messages = this._logger.getall().filter(e => e.level != "debug");
          this.display();
        });
      });
    });
  }


  detect_source(): Promise<null> {
    return new Promise((resolve) => {
      var i = 0;
      this._logger.info("Detecting file type");
      this.config_files.forEach((file: ConfigFile) => {
        this.config_parser.detect_source(file).then((success) => {
          i += 1;
          if (i == this.config_files.length) resolve(null);
        })
      })
    })
  }

  parse_vlans(): Promise<null> {
    return new Promise((resolve) => {
      var i = 0;
      this._logger.info("Reading VLANs from config files started");
      this.config_files.forEach((file: ConfigFile) => {
        this.config_parser.read_vlans(file).then((success) => {
          if (!success && file.format == "Cisco") file.error_message = "Unable to parse the VLAN database"
          else if (!success) file.error_message = "Unable to retrieve the VLAN list"
          file.success_vlan = success;
          i += 1;
          if (i == this.config_files.length) resolve(null);
        })
      })
    })
  }

  parse_config(): Promise<null> {
    return new Promise((resolve) => {
      var i = 0;
      this._logger.info("Reading configuration from config files started");
      this.config_files.forEach((file: ConfigFile) => {
        this.config_parser.read_config(file).then((success) => {
          if (!success) file.error_message = "Unable to parse the configuration"
          file.success_config = success;
          i += 1;
          if (i == this.config_files.length) resolve(null);
        })
      })
    })
  }

  display() {
    this.mist_config_html = this.json_to_html.transform(this.config_parser.mist_template, 2);
  }



  //// EXPORT ////
  save() {
    var a = document.createElement('a');
    var file = new Blob([JSON.stringify(this.config_parser.mist_template, undefined, 4)], { type: "text/plain" });
    a.href = URL.createObjectURL(file);
    a.download = this.config_parser.mist_template?.name.replace(" ", "_") + ".json";
    a.click();
  }

  //// INFOS ////
  openInfo(): void {
    this._dialog.open(InfoDialog, {});
  }

  toggleLogs(): void {
    this.show_logs = !this.show_logs;
  }
}

@Component({
  selector: 'info',
  templateUrl: 'info.html',
  styleUrls: ['./app.component.scss']
})
export class InfoDialog {
  constructor(
    public _dialogRef: MatDialogRef<InfoDialog>
  ) { }

}