import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnInit, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Conversion, convert, FileReport } from './converters/convert';
import { LogFilter, navSections, NavSection, partOf, PartRef, toCheckIn, VENDOR_LABEL, countByKind } from './workbench/view-model';

/**
 * A file of the list: its text, which stays in the browser, and what the converter
 * says about it.
 */
export interface ConfigFile {
  name: string;
  text: string;
  /** Set by each conversion. */
  report?: FileReport;
}

/** What the right pane shows. */
export type Selection =
  | { kind: 'template' }
  | { kind: 'part'; part: PartRef }
  | { kind: 'file'; name: string; line?: number }
  | { kind: 'logs'; filter: LogFilter };

/** Name of the template until the user types another one. */
const DEFAULT_TEMPLATE_NAME = 'template_name';

/** Extensions of the files that are read even when the browser does not say they are text. */
const TEXT_EXTENSIONS = /\.(cfg|conf|config|txt|log|set|run|text)$/i;

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.Default,
  standalone: false,
})
export class AppComponent implements OnInit {
  @ViewChild('fileInput') fileInput: ElementRef<HTMLInputElement>;

  github_url = '';
  docker_url = '';
  disclaimer = '';

  files: ConfigFile[] = [];
  /** Number of files that are being read from the disk. */
  reading = 0;
  /** The result of the conversion of `files`, undefined when there is no file. */
  conversion: Conversion | undefined;
  template_name = DEFAULT_TEMPLATE_NAME;
  /** Copy into the template the secrets that the files have in clear text (SNMP communities). */
  copy_secrets = false;

  selection: Selection = { kind: 'template' };
  sections: NavSection[] = [];
  /** Sections of the Template list that are unfolded. */
  open_sections = new Set<string>(['usages']);
  file_filter = '';
  /** Files are being dragged over the page. */
  dragging = false;
  show_info = false;
  /** Files that were dropped and could not be read: said once, then cleared. */
  skipped: string[] = [];

  readonly vendor_label = VENDOR_LABEL;

  constructor(private _http: HttpClient) {}

  ngOnInit(): void {
    this._http.get<{ disclaimer?: string; github_url?: string; docker_url?: string }>('/api/disclaimer').subscribe({
      next: (data) => {
        this.disclaimer = data.disclaimer ?? '';
        this.github_url = data.github_url ?? '';
        this.docker_url = data.docker_url ?? '';
      },
      error: () => undefined,
    });
  }

  /* ------------------------------------------------------------ adding files */

  @HostListener('window:dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.dragging = true;
  }

  @HostListener('window:dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    // Leaving the window, not moving from one element to another
    if (event.relatedTarget === null) this.dragging = false;
  }

  @HostListener('window:drop', ['$event'])
  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
    this.addFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    this.show_info = false;
  }

  browse(): void {
    this.fileInput.nativeElement.click();
  }

  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(Array.from(input.files ?? []));
    // lets the user select the same files again
    input.value = '';
  }

  /**
   * Reads the files in the browser and converts them with the files already there. A file
   * with the name of a file of the list replaces it. Nothing is sent anywhere.
   */
  addFiles(dropped: File[]): void {
    const readable = dropped.filter((file) => file.type.startsWith('text/') || file.type === '' || TEXT_EXTENSIONS.test(file.name));
    this.skipped = dropped.filter((file) => !readable.includes(file)).map((file) => file.name);
    if (readable.length === 0) return;
    this.reading += readable.length;
    Promise.all(readable.map((file) => file.text().then((text): ConfigFile => ({ name: file.name, text })).catch(() => undefined))).then((read) => {
      this.reading -= readable.length;
      const added = read.filter((file): file is ConfigFile => file !== undefined);
      for (const file of added) {
        const index = this.files.findIndex((existing) => existing.name === file.name);
        if (index < 0) this.files.push(file);
        else this.files[index] = file;
      }
      this.process();
    });
  }

  removeFile(file: ConfigFile): void {
    this.files = this.files.filter((candidate) => candidate !== file);
    if (this.selection.kind === 'file' && this.selection.name === file.name) this.selection = { kind: 'template' };
    this.process();
  }

  removeAll(): void {
    this.files = [];
    this.selection = { kind: 'template' };
    this.process();
  }

  /* -------------------------------------------------------------- conversion */

  /** Converts every file into one template. The conversion runs here, in the browser (see converters/convert.ts). */
  process(): void {
    if (this.files.length === 0) {
      this.conversion = undefined;
      this.sections = [];
      return;
    }
    const conversion = convert(
      this.files.map((file) => ({ name: file.name, text: file.text })),
      { copyClearTextSecrets: this.copy_secrets },
    );
    conversion.template.name = this.template_name;
    conversion.files.forEach((report, index) => (this.files[index].report = report));
    this.conversion = conversion;
    this.sections = navSections(conversion);
    // A part that no longer exists is replaced by the whole template
    if (this.selection.kind === 'part') {
      const path = this.selection.part.path;
      if (!this.sections.some((section) => section.items.some((item) => item.path === path))) this.selection = { kind: 'template' };
    }
  }

  renameTemplate(): void {
    if (this.conversion) this.conversion.template.name = this.template_name;
    // A new object, so that the JSON view draws the new name
    if (this.conversion) this.conversion = { ...this.conversion, template: { ...this.conversion.template } };
  }

  setCopySecrets(value: boolean): void {
    this.copy_secrets = value;
    this.process();
  }

  /* --------------------------------------------------------------- selection */

  select(selection: Selection): void {
    this.selection = selection;
    if (selection.kind === 'part') {
      const section = this.sections.find((candidate) => candidate.items.some((item) => item.path === selection.part.path));
      if (section) this.open_sections.add(section.id);
    }
  }

  selectPath(path: string): void {
    const part = partOf(path);
    if (part) this.select({ kind: 'part', part });
  }

  openFile(target: { name: string; line?: number }): void {
    this.select({ kind: 'file', name: target.name, line: target.line });
  }

  toggleSection(id: string): void {
    if (this.open_sections.has(id)) this.open_sections.delete(id);
    else this.open_sections.add(id);
  }

  isSelectedPath(path: string): boolean {
    return this.selection.kind === 'part' && this.selection.part.path === path;
  }

  isSelectedFile(name: string): boolean {
    return this.selection.kind === 'file' && this.selection.name === name;
  }

  isLogs(filter: LogFilter): boolean {
    return this.selection.kind === 'logs' && this.selection.filter === filter;
  }

  get selected_file(): ConfigFile | undefined {
    const selection = this.selection;
    return selection.kind === 'file' ? this.files.find((file) => file.name === selection.name) : undefined;
  }

  /* ------------------------------------------------------------------ list */

  get shown_files(): ConfigFile[] {
    const words = this.file_filter.toLowerCase().split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) return this.files;
    return this.files.filter((file) => {
      const text = [file.name, file.report?.hostname ?? '', this.vendor_label[file.report?.format ?? 'Unknown']].join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  get not_read(): number {
    return this.files.filter((file) => file.report && !file.report.converted).length;
  }

  toCheck(file: ConfigFile): number {
    return this.conversion ? toCheckIn(this.conversion, file.name) : 0;
  }

  get counts(): Record<LogFilter, number> {
    return countByKind(this.conversion?.diagnostics ?? []);
  }

  /* ---------------------------------------------------------------- export */

  /** Saves the template as a JSON file, from the browser. */
  save(): void {
    if (!this.conversion) return;
    this.download(JSON.stringify(this.conversion.template, undefined, 4), `${this.conversion.template.name.replace(/ /g, '_')}.json`);
  }

  download(text: string, filename: string): void {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }
}
