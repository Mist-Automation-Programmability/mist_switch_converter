import { Component, ElementRef, OnInit, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ConfigParser, ConfigFile } from "./converters/parser_main";
import { JsonToHtml } from "./common/function/json-to-html"
import { MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { LogMessage, Logger } from "./services/logger";
import { MatListOption, MatSelectionListChange } from '@angular/material/list';
import { ViewChild } from '@angular/core';
import { ConfigData, ParsedInterfaceData, ParsedProfileData } from './converters/parser_config';


@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  title = 'switch migration';
  @ViewChild('dropsRef')
  drop_element: ElementRef;

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
  show_file_warning:boolean=false;

  constructor(
    public _dialog: MatDialog,
    private _http: HttpClient,
    private _logger: Logger
  ) { }

  /********************************************************
   * INIT
   *******************************************************/
  /**
   * Just used to retrieve the message from the main page
   */
  ngOnInit(): void {
    this._http.get<any>("/api/disclaimer").subscribe({
      next: data => {
        if (data.disclaimer) this.disclaimer = data.disclaimer;
        if (data.github_url) this.github_url = data.github_url;
        if (data.docker_url) this.docker_url = data.docker_url;
      }
    })
  }

  /********************************************************
   * FILES PROCESSING
   *******************************************************/
  /**
   * Function triggered when file(s) are dropped/selected
   * Check if the file is "test/plain" type or if its extension is .cfg, .config, .txt, then read it and add it to the config_files list
   * Once all files are read, call the function to process them
   * @param event 
   */
  onFilechange(event: any): void {
    if (event?.target?.files) {
      for (var index in Object(event.target.files)) {
        var done = 0;
        var file = event.target.files[index];
        if (file.type == "text/plain" || (typeof (file.name) == "string" && file.name.match(/\.cfg$|\.config$|\.txt$/))) {
          this.readfile(event.target.files[index]).then((config_file) => {
            this.addConfigFile(config_file);
            done += 1;
            if (done == event.target.files.length) {
              this.drop_element.nativeElement.value = "";
              this.reinitMistTemplate();
              this.processFiles();
            }
          })
        }
      }
    }
  }

  /**
   * Function to add a ConfigFile to the list. If the file is already in the list, drop it
   * @param file ConfigFile
   */
  addConfigFile(file: ConfigFile): void {
    const index = this.config_files.findIndex(f => f.name == file.name);
    if (index < 0) this.config_files.push(file);
    else this.config_files[index] = file;
  }

  /**
   * Function to read the dropped/selected file and add it to the config_files list
   * @param file 
   * @returns Promise 
   */
  readfile(file: File): Promise<ConfigFile> {
    return new Promise((resolve) => {
      if (file) {
        var reader = new FileReader();
        reader.readAsText(file, "UTF-8");
        reader.onload = function (e) {
          const config_file: ConfigFile = {
            name: file.name,
            config: (reader.result as string)?.split('\n'),
            format: "Unknown",
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

  /********************************************************
   * SELECT AND DELETE FILES
   *******************************************************/
  /**
   * Function to keep track of selected files from the list
   * @param event 
   */
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

  /**
   * Function to remove the files selected on the list
   */
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

  /********************************************************
   * TEMPLATE MANAGEMENT 
   *******************************************************/

  /**
   * function to clear the configuration and the logs. Called when a file is added/remove
   */
  reinitMistTemplate() {
    this.mist_config_html = "";
    this.config_parser = new ConfigParser(this._logger);
  }

  /**
   * CORE function to process the files. 
   * @returns void
   */
  processFiles(): void {
    this.detect_source().then(() => {
      this.parse_vlans().then(() => {
        this.parse_config().then(() => {
          this.config_parser.generate();
          this.log_messages = this._logger.getall().filter(e => e.level != "debug");
          this.display();
          this.config_files.forEach((file:ConfigFile)=>{
            console.log(file)
            if (!file.success_config || !file.success_vlan) this.show_file_warning = true;
          })
        });
      });
    });
  }

  /**
   * loop over each file and call the function to identify the file type (Cisco, Juniper, ...)
   * @returns Promise
   */
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

  /**
   * loop over each file and call the function to parse the VLANS
   * @returns Promise
   */
  parse_vlans(): Promise<null> {
    return new Promise((resolve) => {
      var i = 0;
      this._logger.info("Reading VLANs from config files started");
      this.config_files.forEach((file: ConfigFile) => {
        this.config_parser.read_vlans(file).then((success) => {
          if (!success && file.format == "Cisco") file.error_message = "Unable to parse the VLAN database";
          else if (!success) file.error_message = "Unable to retrieve the VLAN list";
          i += 1;
          if (i == this.config_files.length) resolve(null);
        })
      })
    })
  }

  /**
   * loop over each file and call the function to parse the configuration
   * @returns Promise
   */
  parse_config(): Promise<null> {
    return new Promise((resolve) => {
      var i = 0;
      this._logger.info("Reading configuration from config files started");
      this.config_files.forEach((file: ConfigFile) => {
        this.config_parser.read_config(file).then((success) => {
          if (!success && file.error_message == "Unknown error") file.error_message = "Unable to parse the configuration"
          file.success_config = success;
          i += 1;
          if (i == this.config_files.length) resolve(null);
        })
      })
    })
  }

  /**
   * Generate the HTML version of the Mist template
   */
  display() {
    this.mist_config_html = this.json_to_html.transform(this.config_parser.config_data.mist_template, 2).replace(/\n/g, "\\n");
  }

  /********************************************************
   * EXPORT
   *******************************************************/
  /**
   * Function to export/download the mist template.
   */
  save() {
    var a = document.createElement('a');
    var file = new Blob([JSON.stringify(this.config_parser.config_data.mist_template, undefined, 4)], { type: "text/plain" });
    a.href = URL.createObjectURL(file);
    a.download = this.config_parser.config_data.mist_template?.name.replace(" ", "_") + ".json";
    a.click();
  }

  /********************************************************
   * INFOS AND LOGS
   *******************************************************/
  openInfo(): void {
    this._dialog.open(InfoDialog, {
      height: '45em',
      width: '80em'
    });
  }

  openDetails(): void {
    this._dialog.open(DetailsDialog, {
      data: {
        config_data: this.config_parser.config_data,
        log_messages: this.log_messages
      },
      height: '90vh',
      maxHeight: '90vh',
      width: '90vw',
      maxWidth: '100em',
    })
  }

}

/****************************************************************************************************************
 * HELP DIALOG
 ***************************************************************************************************************/
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


/****************************************************************************************************************
 * RESULT DIALOG
 ***************************************************************************************************************/
@Component({
  selector: 'result',
  templateUrl: 'result.html',
  styleUrls: ['./app.component.scss']
})
export class DetailsDialog {

  json_to_html = new JsonToHtml();
  selectedIndex:number|null;
  displayed_columns: string[] = ["switch", "interface", "profile", "action"];
  displayed_interfaces: ParsedInterfaceData[] = [];
  details_switches: string[]=[];
  details_selected_switch:string;
  details_interfaces:string[]=[];
  details_selected_interface:string;
  details_interface_data:string="";
  details_interface_template:string="";
  details_interface_template_name:string="";
  log_messages: LogMessage[] = [];
  log_columns: string[] = ['level', 'file', 'message'];

  constructor(
    public _dialogRef: MatDialogRef<DetailsDialog>,
    @Inject(MAT_DIALOG_DATA) public data: {config_data:ConfigData, log_messages: LogMessage[]}
  ) {
    this.log_messages = this.data.log_messages;
    this.displayed_interfaces = this.data.config_data.interfaces;
    this.data.config_data.interfaces.forEach((interface_data:ParsedInterfaceData)=>{
      if (!this.details_switches.includes(interface_data.hostname)) this.details_switches.push(interface_data.hostname);
    })
    this.details_switches.sort();
    this.details_selected_switch = this.displayed_interfaces[0].hostname;
    this.details_update_interfaces();
    this.details_selected_interface = this.displayed_interfaces[0].interface_name;
    this.details_update_data();
  }

  view_interface_details(hostname:string, interface_name:string):void{
    this.details_selected_switch = hostname;
    this.details_selected_interface = interface_name;
    this.details_update_data();
    this.selectedIndex=1;
  }

  details_update_interfaces():void{
    this.details_interfaces = []
    this.details_selected_interface = "None";
    this.data.config_data.interfaces.filter(i => i.hostname == this.details_selected_switch).forEach((interface_data:ParsedInterfaceData)=>{
      this.details_interfaces.push(interface_data.interface_name);
    })
    this.details_interfaces.sort();
    this.details_selected_interface = this.details_interfaces[0];
  }

  details_update_data():void{
    this.details_interface_data = "";
    this.details_interface_template = "";
    const interface_data = this.data.config_data.interfaces.filter(i => i.hostname == this.details_selected_switch && i.interface_name == this.details_selected_interface)[0];
    this.details_interface_data = interface_data.config_blocks.join("\r").replace(/\r\r/g, "\r");
    const template_data = this.data.config_data.profiles.filter(p => p.uuid == interface_data.profile_id)[0]
    this.details_interface_template_name = template_data.generated_name;
    this.details_interface_template = this.json_to_html.transform(template_data.config);
  }

  download_list() {
    var csv_data: string = "#switch_name, interface_name, profile_name\r";
    this.data.config_data.interfaces.forEach((interface_data: ParsedInterfaceData) => {
      csv_data += interface_data.hostname + "," + interface_data.interface_name + "," + interface_data.profile_name + "\r";
    })
    var a = document.createElement('a');
    var file = new Blob([csv_data], { type: "text/plain" });
    a.href = URL.createObjectURL(file);
    a.download = "interfaces.csv";
    a.click();
  }
  download_logs() {
    var csv_data: string = "#severity, filename, message\r";
    this.log_messages.forEach((message: LogMessage) => {
      csv_data += message.level + "," + message.file + ",\"" + message.message.replace(/"/g, "'") + "\"\r";
    })
    var a = document.createElement('a');
    var file = new Blob([csv_data], { type: "text/plain" });
    a.href = URL.createObjectURL(file);
    a.download = "logs.csv"; 
    a.click();
  }

  applyFilter(event: Event) {
    const filterValues = (event.target as HTMLInputElement).value.toLowerCase().split(" ");
    this.displayed_interfaces = [];
    this.data.config_data.interfaces.forEach((interface_data: ParsedInterfaceData) => {
      var keepit: boolean = true;
      filterValues.forEach((value: string) => {
        const filterValue = value.trim();
        if (
          !interface_data.hostname.includes(filterValue) &&
          !interface_data.interface_name.includes(filterValue) &&
          !interface_data.profile_name.includes(filterValue)
        ) keepit = false;
      })
      if (keepit) this.displayed_interfaces.push(interface_data);
    })
  }
}