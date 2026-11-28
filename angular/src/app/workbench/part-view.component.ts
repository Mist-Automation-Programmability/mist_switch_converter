import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Conversion, Diagnostic, messageKind, OriginSource } from '../converters/convert';
import { linesText } from '../converters/report';
import { JsonViewComponent } from './json-view.component';
import { KIND_LABEL, messagesAbout, originOf, PartRef, SETTINGS, summaryOf, valueOf } from './view-model';

/** At most this many lines of a file are shown under Detected. */
const MAX_EXCERPT = 14;
/** Files shown under Detected before "Show the other files". */
const FIRST_SOURCES = 3;

const KIND_TITLE: Record<PartRef['kind'], string> = { network: 'Network', usage: 'Port profile', rule: 'Switch rule', setting: 'Settings' };

interface SourceView {
  source: OriginSource;
  /** "24 ports, the first is GigabitEthernet1/0/1", "lines 4, 5". */
  meta: string;
  excerpt: Array<{ number: number; text: string }>;
  /** Lines of the source that the excerpt does not show. */
  more: number;
}

/**
 * One part of the template: what was generated (its JSON), what the converter decided
 * (its name, the messages about it), and where it was detected (files and lines).
 */
@Component({
  selector: 'app-part-view',
  standalone: true,
  imports: [JsonViewComponent, FormsModule],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="detail-head">
      <span class="eyebrow">{{ kindTitle }}</span>
      <h2>{{ part.name }}</h2>
      <p class="muted">{{ summary }}</p>
    </div>

    <section class="block" aria-labelledby="generated">
      <h3 id="generated">Generated</h3>
      <app-json-view [value]="value" [rootKey]="rootKey" [depth]="part.kind === 'rule' ? 2 : 4" [toolbar]="true" [label]="'Generated ' + part.name"></app-json-view>
    </section>

    <section class="block" aria-labelledby="decided">
      <h3 id="decided">Decided</h3>
      <dl class="decisions">
        @if (naming) {
          <dt>Name</dt>
          <dd>{{ naming }}</dd>
        }
        @if (settingNote) {
          <dt>Merge</dt>
          <dd>{{ settingNote }}</dd>
        }
        @if (part.kind === 'usage') {
          <dt>Merge</dt>
          <dd>Ports with the same settings share one port profile, whatever their switch and their vendor.</dd>
        }
      </dl>
      @if (part.path === 'snmp_config') {
        <label class="checkbox">
          <input type="checkbox" [ngModel]="copySecrets" (ngModelChange)="copySecretsChange.emit($event)" />
          <span>Copy the SNMP secrets that are in clear text</span>
        </label>
      }
      @if (messages.length > 0) {
        <ul class="messages">
          @for (message of messages; track $index) {
            <li>
              <span class="pill" [class]="'pill ' + kindOf(message)">{{ kindLabel(message) }}</span>
              <span>{{ message.message }}</span>
              @if (message.file) {
                <button type="button" class="link-button" (click)="openFile.emit({ name: message.file, line: message.lines?.[0] })">{{ message.file }}{{ message.lines ? ', line ' + linesText(message.lines) : '' }}</button>
              }
            </li>
          }
        </ul>
      }
    </section>

    <section class="block" aria-labelledby="detected">
      <h3 id="detected">Detected</h3>
      @if (sources.length === 0) {
        <p class="muted">No file gives this part a line of its own.</p>
      }
      <ul class="sources">
        @for (view of shownSources; track view.source.file) {
          <li>
            <div class="source-head">
              <button type="button" class="icon-button" (click)="toggle(view.source.file)" [attr.aria-expanded]="expanded.has(view.source.file)" [attr.aria-label]="(expanded.has(view.source.file) ? 'Hide' : 'Show') + ' the lines of ' + view.source.file">
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" [class.open]="expanded.has(view.source.file)"><path d="M9 6l6 6-6 6"></path></svg>
              </button>
              <button type="button" class="link-button strong" (click)="openFile.emit({ name: view.source.file, line: view.source.lines[0] })">{{ view.source.file }}</button>
              <span class="muted">{{ view.meta }}</span>
            </div>
            @if (expanded.has(view.source.file) && view.excerpt.length > 0) {
              <pre class="cli"><code>@for (line of view.excerpt; track line.number) {<span class="cli-line"><span class="cli-number">{{ line.number }}</span>{{ line.text }}
</span>}</code></pre>
              @if (view.more > 0) {
                <button type="button" class="link-button" (click)="openFile.emit({ name: view.source.file, line: view.source.lines[0] })">{{ view.more }} more line{{ view.more > 1 ? 's' : '' }}: open the file</button>
              }
            }
          </li>
        }
      </ul>
      @if (sources.length > shownSources.length) {
        <button type="button" class="secondary-button" (click)="showAll = true">Show the {{ sources.length - shownSources.length }} other files</button>
      }
    </section>
  `,
})
export class PartViewComponent implements OnChanges {
  @Input() conversion: Conversion;
  @Input() part: PartRef;
  @Input() files: Array<{ name: string; text: string }> = [];
  @Input() copySecrets = false;
  @Output() copySecretsChange = new EventEmitter<boolean>();
  @Output() openFile = new EventEmitter<{ name: string; line?: number }>();
  @Output() openPart = new EventEmitter<string>();

  kindTitle = '';
  summary = '';
  value: unknown;
  rootKey = '';
  naming = '';
  settingNote = '';
  messages: Diagnostic[] = [];
  sources: SourceView[] = [];
  expanded = new Set<string>();
  showAll = false;
  readonly linesText = linesText;

  get shownSources(): SourceView[] {
    return this.showAll ? this.sources : this.sources.slice(0, FIRST_SOURCES);
  }

  ngOnChanges(changes: SimpleChanges): void {
    const partChanged = changes['part'] && changes['part'].previousValue?.path !== this.part.path;
    const conversion = this.conversion;
    const part = this.part;
    this.kindTitle = KIND_TITLE[part.kind];
    this.summary = summaryOf(conversion, part);
    this.value = valueOf(conversion, part);
    this.rootKey = part.kind === 'setting' ? part.path : part.name;
    const origin = originOf(conversion, part.path);
    this.naming = origin?.naming ?? '';
    this.settingNote = SETTINGS.find((entry) => entry.path === part.path)?.decided ?? '';
    this.messages = messagesAbout(conversion, part.path);
    this.sources = (origin?.sources ?? []).map((source) => this.viewOf(source));
    if (partChanged || changes['conversion']?.firstChange) {
      this.showAll = false;
      this.expanded = new Set(this.sources.slice(0, 1).map((view) => view.source.file));
    }
  }

  toggle(file: string): void {
    if (this.expanded.has(file)) this.expanded.delete(file);
    else this.expanded.add(file);
  }

  kindOf(message: Diagnostic): string {
    return messageKind(message);
  }

  kindLabel(message: Diagnostic): string {
    return KIND_LABEL[messageKind(message)];
  }

  private viewOf(source: OriginSource): SourceView {
    const text = this.files.find((file) => file.name === source.file)?.text ?? '';
    const all = text.split('\n');
    let lines = source.lines;
    let meta = source.lines.length > 0 ? `line${source.lines.length > 1 ? 's' : ''} ${linesText(source.lines)}` : 'no line of its own';
    if (source.ports && source.ports.length > 0) {
      const count = source.ports.length;
      meta = count > 1 ? `${count} ports, the first is ${source.ports[0]}` : `1 port, ${source.ports[0]}`;
      // The lines of the first port: the others have the same settings
      const first = this.conversion.ports.find((port) => port.file === source.file && port.name === source.ports?.[0]);
      if (first && this.part.kind === 'usage') lines = first.lineNumbers;
    }
    const excerpt = lines.slice(0, MAX_EXCERPT).map((number) => ({ number, text: (all[number - 1] ?? '').replace(/\r$/, '') }));
    return { source, meta, excerpt, more: source.lines.length - excerpt.length };
  }
}
