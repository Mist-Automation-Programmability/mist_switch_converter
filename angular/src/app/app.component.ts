import { Component, ElementRef, OnInit, Inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { JsonToHtml } from "./common/function/json-to-html"
import { MatDialog, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatListOption, MatSelectionListChange } from '@angular/material/list';
import { ViewChild } from '@angular/core';
import { Conversion, ConvertedPort, Diagnostic, FileReport, convert } from './converters/convert';
import { linesText } from './converters/report';

/**
 * A file of the list: its text, which stays in the browser, and what the converter
 * says about it.
 */
export interface ConfigFile {
  name: string,
  text: string,
  /** Set by each conversion. */
  report?: FileReport
}

/** Name of the template until the user types another one. */
const DEFAULT_TEMPLATE_NAME = "template_name";

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
  /** Number of files that are being read from the disk. */
  reading: number = 0;
  /** The result of the conversion of `config_files`, undefined when there is no file. */
  conversion: Conversion | undefined;
  template_name: string = DEFAULT_TEMPLATE_NAME;
  mist_config_html: string = "";
  json_to_html = new JsonToHtml();

  show_file_warning: boolean = false;
  /** "2 errors, 5 warnings", or "" when the conversion has nothing to report. */
  problem_summary: string = "";

  constructor(
    public _dialog: MatDialog,
    private _http: HttpClient
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
   * Keep the files whose type is "text/plain" or whose extension is .cfg, .config, .txt, read them and add them to the config_files list
   * Once all files are read, call the function to process them
   * @param event
   */
  onFilechange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input?.files ?? []).filter(file => file.type == "text/plain" || /\.cfg$|\.config$|\.txt$/.test(file.name));
    this.reading += files.length;
    Promise.all(files.map(file => this.readfile(file))).then((config_files) => {
      config_files.forEach(config_file => {
        if (config_file) this.addConfigFile(config_file);
      })
      this.reading -= files.length;
      // lets the user select the same files again
      this.drop_element.nativeElement.value = "";
      if (files.length > 0) this.processFiles();
    })
  }

  /**
   * Function to add a ConfigFile to the list. If the file is already in the list, replace it
   * @param file ConfigFile
   */
  addConfigFile(file: ConfigFile): void {
    const index = this.config_files.findIndex(f => f.name == file.name);
    if (index < 0) this.config_files.push(file);
    else this.config_files[index] = file;
  }

  /**
   * Function to read the dropped/selected file. The file is read by the browser and
   * is not sent anywhere.
   * @param file
   * @returns Promise of the file, or of undefined when the browser cannot read it
   */
  readfile(file: File): Promise<ConfigFile | undefined> {
    return file.text()
      .then((text): ConfigFile => ({ name: file.name, text: text }))
      .catch(() => {
        console.log("error reading file " + file.name);
        return undefined;
      });
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
      this.processFiles();
    }
  }

  /**
   * What the list shows next to a file: "error" when it is not converted, "warning"
   * when it is converted without its VLAN list, "success" otherwise.
   */
  statusOf(file: ConfigFile): "error" | "warning" | "success" | undefined {
    if (!file.report) return undefined;
    if (!file.report.converted) return "error";
    if (!file.report.hasVlans) return "warning";
    return "success";
  }

  /********************************************************
   * TEMPLATE MANAGEMENT
   *******************************************************/

  /**
   * CORE function to process the files: converts all of them into one template.
   * The conversion runs here, in the browser (see converters/convert.ts).
   * Called when a file is added/removed
   * @returns void
   */
  processFiles(): void {
    if (this.config_files.length == 0) {
      this.conversion = undefined;
      this.mist_config_html = "";
      this.show_file_warning = false;
      this.problem_summary = "";
      return;
    }
    const conversion = convert(this.config_files.map(file => ({ name: file.name, text: file.text })));
    conversion.template.name = this.template_name;
    conversion.files.forEach((report, index) => this.config_files[index].report = report);
    this.conversion = conversion;
    this.show_file_warning = conversion.files.some(report => !report.converted || !report.hasVlans);
    this.problem_summary = this.summarize(conversion.diagnostics);
    this.display();
  }

  /**
   * "2 errors, 5 warnings": what the details have to say, in a few words
   */
  private summarize(diagnostics: Diagnostic[]): string {
    const count = (severity: string, word: string): string => {
      const number = diagnostics.filter(diagnostic => diagnostic.severity == severity).length;
      return number == 0 ? "" : number + " " + word + (number > 1 ? "s" : "");
    }
    return [count("error", "error"), count("warning", "warning")].filter(text => text != "").join(", ");
  }

  /**
   * Function triggered when the name of the template is changed
   */
  renameTemplate(): void {
    if (!this.conversion) return;
    this.conversion.template.name = this.template_name;
    this.display();
  }

  /**
   * Generate the HTML version of the Mist template
   */
  display() {
    if (!this.conversion) return;
    this.mist_config_html = this.json_to_html.transform(this.conversion.template, 2).replace(/\n/g, "\\n");
  }

  /********************************************************
   * EXPORT
   *******************************************************/
  /**
   * Function to export/download the mist template.
   */
  save() {
    if (!this.conversion) return;
    var a = document.createElement('a');
    var file = new Blob([JSON.stringify(this.conversion.template, undefined, 4)], { type: "text/plain" });
    a.href = URL.createObjectURL(file);
    a.download = this.conversion.template.name.replace(/ /g, "_") + ".json";
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
    if (!this.conversion) return;
    this._dialog.open(DetailsDialog, {
      data: {
        conversion: this.conversion
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
  /** Every converted port, in the order of the files */
  interfaces: ConvertedPort[] = [];
  displayed_interfaces: ConvertedPort[] = [];
  details_switches: string[]=[];
  details_selected_switch:string="";
  details_interfaces:string[]=[];
  details_selected_interface:string="";
  details_interface_data:string="";
  details_interface_template:string="";
  details_interface_template_name:string="";
  log_messages: Diagnostic[] = [];
  log_messages_displayed: Diagnostic[] = [];
  log_columns: string[] = ['level', 'file', 'lines', 'message'];
  log_levels: string[] = ['Error', 'Warning', 'Info'];
  log_levels_selected: string[]=['error', 'warning'];
  lines_text = linesText;
  constructor(
    public _dialogRef: MatDialogRef<DetailsDialog>,
    @Inject(MAT_DIALOG_DATA) public data: {conversion: Conversion}
  ) {
    this.log_messages = this.data.conversion.diagnostics;
    this.filter_log_messages();
    this.interfaces = this.data.conversion.ports;
    this.displayed_interfaces = this.interfaces;
    this.interfaces.forEach((interface_data:ConvertedPort)=>{
      if (!this.details_switches.includes(interface_data.hostname)) this.details_switches.push(interface_data.hostname);
    })
    this.details_switches.sort();
    if (this.interfaces.length > 0) {
      this.details_selected_switch = this.interfaces[0].hostname;
      this.details_update_interfaces();
    }
  }

  filter_log_messages():void{
    this.log_messages_displayed = this.log_messages.filter(message => this.log_levels_selected.includes(message.severity));
  }

  view_interface_details(hostname:string, interface_name:string):void{
    this.details_selected_switch = hostname;
    this.details_update_interfaces();
    this.details_selected_interface = interface_name;
    this.details_update_data();
    this.selectedIndex=1;
  }

  /** The interfaces of the selected switch, in the order of its file. The first one is selected. */
  details_update_interfaces():void{
    this.details_interfaces = this.interfaces.filter(i => i.hostname == this.details_selected_switch).map(i => i.name);
    this.details_selected_interface = this.details_interfaces[0] ?? "";
    this.details_update_data();
  }

  details_update_data():void{
    this.details_interface_data = "";
    this.details_interface_template = "";
    this.details_interface_template_name = "";
    const interface_data = this.interfaces.find(i => i.hostname == this.details_selected_switch && i.name == this.details_selected_interface);
    if (!interface_data) return;
    this.details_interface_data = interface_data.lines.join("\n");
    this.details_interface_template_name = interface_data.usage;
    this.details_interface_template = this.json_to_html.transform(this.data.conversion.template.port_usages[interface_data.usage]);
  }

  download_list() {
    var csv_data: string = "#switch_name, interface_name, profile_name\r\n";
    this.interfaces.forEach((interface_data: ConvertedPort) => {
      csv_data += interface_data.hostname + "," + interface_data.name + "," + interface_data.usage + "\r\n";
    })
    this.download(csv_data, "interfaces.csv");
  }

  download_logs() {
    var csv_data: string = "#severity, filename, lines, message\r\n";
    this.log_messages.forEach((message: Diagnostic) => {
      csv_data += message.severity + "," + message.file + ",\"" + (message.lines ?? []).join(" ") + "\",\"" + message.message.replace(/"/g, "'") + "\"\r\n";
    })
    this.download(csv_data, "logs.csv");
  }

  private download(text: string, filename: string): void {
    var a = document.createElement('a');
    var file = new Blob([text], { type: "text/plain" });
    a.href = URL.createObjectURL(file);
    a.download = filename;
    a.click();
  }

  applyFilter(event: Event) {
    const filterValues = (event.target as HTMLInputElement).value.toLowerCase().split(" ").map(value => value.trim());
    this.displayed_interfaces = this.interfaces.filter((interface_data: ConvertedPort) => {
      const searched = [interface_data.hostname, interface_data.name, interface_data.usage].map(text => text.toLowerCase());
      return filterValues.every(value => searched.some(text => text.includes(value)));
    })
  }
}
