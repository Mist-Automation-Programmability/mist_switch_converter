import { Component } from '@angular/core';
import { IoS, IosFile } from "./ios/ios";
import { MistTemplate } from "./ios/mist_template";
import { JsonToHtml } from "./common/functions/json-to-html"
import { MatDialog, MatDialogRef } from '@angular/material/dialog';


@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent {
  title = 'switch_config_converter';

  ios_parser: IoS = new IoS()
  ios_files: IosFile[] = [];
  mist_config!: MistTemplate;
  mist_config_html: string = "";
  json_to_html = new JsonToHtml();
  constructor(public _dialog: MatDialog) { }

  onFilechange(event: any) {
    if (event?.target?.files) {
      for (var index in Object(event.target.files)) {
        var done = 0;
        if (event.target.files[index].type == "text/plain") {
          this.readfile(event.target.files[index]).then((res) => {
            this.addIosFile(res);
            done += 1;
            if (done == event.target.files.length) {
              this.ios_parser.convert(this.ios_files).then((config: MistTemplate) => {
                this.mist_config = config;
                this.display();
              })
            }
          })
        }
      }
    }
  }

  display() {
    this.mist_config_html = this.json_to_html.transform(this.mist_config);
    console.log(this.mist_config_html)
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
    a.download = this.mist_config.name.replace(" ", "_") + ".json";
    a.click();
  }

  openInfo(): void {
    this._dialog.open(InfoDialog, {});
  }
}

@Component({
  selector: 'info',
  templateUrl: 'info.html',
})
export class InfoDialog {
  constructor(
    public _dialogRef: MatDialogRef<InfoDialog>
  ) { }

  close(): void {
    this._dialogRef.close();
  }
}