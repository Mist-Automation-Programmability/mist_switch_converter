import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { IoS, IosFile } from "./ios/ios";
import { MistTemplate } from "./ios/mist_template";
import { JsonToHtml } from "./common/functions/json-to-html"
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { LogMessage, Logger } from "./services/logger";
import { MatListOption, MatSelectionListChange } from '@angular/material/list';
import { IosParser } from './ios/ios_parser';

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
  ios_files: IosFile[] = [];
  ios_files_selected: IosFile[] = [];
  mist_config: MistTemplate|undefined = undefined;
  mist_config_html: string = "";
  ios_parser: IoS = new IoS(this._logger);
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
    // this._logger.logs.subscribe(l => {
    //   this.log_messages.push(l);
    // })
    this._http.get<any>("/api/disclaimer").subscribe({
      next: data => {
        if (data.disclaimer) this.disclaimer = data.disclaimer;
        if (data.github_url) this.github_url = data.github_url;
        if (data.docker_url) this.docker_url = data.docker_url;
      }
    })
  }

  onFilechange(event: any) {
    if (event?.target?.files) {
      for (var index in Object(event.target.files)) {
        var done = 0;
        var file = event.target.files[index];
        if (file.type == "text/plain" || (typeof(file.name)=="string" && file.name.match(/\.cfg$|\.config$|\.txt$/))) {
          this.readfile(event.target.files[index]).then((res) => {
            this.addIosFile(res);
            done += 1;
            if (done == event.target.files.length) this.processFiles();
          })
        }
      }
    }
  }

  selectedFile(event: MatSelectionListChange) {    
    event.options.forEach((selection: MatListOption) => {
      var file = selection.value;
      var selected = selection.selected;
      var index = this.ios_files_selected.indexOf(file);
      if (selected && index < 0) this.ios_files_selected.push(file);
      else if (!selected && index > -1) {
        this.ios_files_selected.splice(index, 1);
      }
    })
  }

  deleteFiles(): void {
    if (this.ios_files_selected.length > 0) {
      this.ios_files_selected.forEach((file: IosFile) => {
        var index = this.ios_files.indexOf(file);
        if (index > -1) {
          this.ios_files.splice(index, 1);
        }
      })
      this.ios_files_selected = [];
      this.reinitMistTemplate();
      this.processFiles();
    }
  }

  reinitMistTemplate(){
    this.mist_config_html = "";
    this.mist_config = undefined;
    this.ios_parser = new IoS(this._logger);
  }

  processFiles(): void {
    this.ios_parser.convert(this.ios_files).then((config: MistTemplate) => {
      this.mist_config = config;
      this.display();
      this.log_messages = this._logger.getall().filter(e => e.level != "debug");
    })
  }

  display() {
    this.mist_config_html = this.json_to_html.transform(this.mist_config);
  }

  readfile(file: File): Promise<IosFile> {
    return new Promise((resolve) => {
      if (file) {
        var reader = new FileReader();
        reader.readAsText(file, "UTF-8");
        reader.onload = function (e) {
          const ios_file: IosFile = {
            name: file.name,
            config: (reader.result as string)?.split('\n')
          };
          resolve(ios_file)
        }
        reader.onerror = function (evt) {
          console.log("error reading file " + file.name);
        }
      }
    })
  }

  addIosFile(file: IosFile) {
    const index = this.ios_files.findIndex(f => f.name == file.name);
    if (index > -1) this.ios_files[index] = file;
    else this.ios_files.push(file);
  }
  deleteIosFile(filename: string) {
    const index = this.ios_files.findIndex(f => f.name == filename);
    if (index > -1) this.ios_files.splice(index, 1);
  }

  save() {
    var a = document.createElement('a');
    var file = new Blob([JSON.stringify(this.mist_config, undefined, 4)], { type: "text/plain" });
    a.href = URL.createObjectURL(file);
    a.download = this.mist_config?.name.replace(" ", "_") + ".json";
    a.click();
  }

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