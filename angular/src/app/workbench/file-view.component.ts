import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { Conversion, Diagnostic, FileReport, LineOutcome } from '../converters/convert';
import { JsonViewComponent } from './json-view.component';
import { lineLinks, partOf, Segment, segmentsOf, VENDOR_LABEL, valueOf } from './view-model';

type Filter = 'all' | Exclude<LineOutcome, 'none'>;

/** A run of lines that are not needed is cut after this many lines, until the user asks for the rest. */
const SHORT_RUN = 4;

interface SegmentView {
  segment: Segment;
  /** What the right column shows. */
  right:
    | { kind: 'port'; key: string; value: unknown; usage: string; rule: string }
    | { kind: 'part'; path: string; name: string; value: unknown; rootKey: string; repeat: boolean }
    | { kind: 'not-converted'; messages: Diagnostic[] }
    | { kind: 'ignored' }
    | { kind: 'converted' };
}

/**
 * One file: its lines on the left, and on the right what each run of lines became in
 * the template, or why it is not there.
 */
@Component({
  selector: 'app-file-view',
  standalone: true,
  imports: [JsonViewComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="detail-head">
      <span class="eyebrow">File</span>
      <h2>{{ file.name }}</h2>
      <p class="muted">{{ description }}</p>
      @if (report?.message) {
        <p class="notice" [class.error]="!report?.converted">{{ report?.message }}</p>
      }
    </div>

    @if (report?.converted) {
      <div class="outcome-bar" role="img" [attr.aria-label]="counts.converted + ' lines converted, ' + counts.ignored + ' not needed in Mist, ' + counts['not-converted'] + ' not converted'">
        <span class="converted" [style.flex-grow]="counts.converted"></span>
        <span class="ignored" [style.flex-grow]="counts.ignored"></span>
        <span class="not-converted" [style.flex-grow]="counts['not-converted']"></span>
      </div>
      <div class="pills" role="group" aria-label="Show the lines">
        @for (entry of filters; track entry.id) {
          <button type="button" class="filter-pill" [class.selected]="filter === entry.id" [attr.aria-pressed]="filter === entry.id" (click)="setFilter(entry.id)">
            @if (entry.id !== 'all') {
              <span class="dot" [class]="'dot ' + entry.id" aria-hidden="true"></span>
            }
            {{ entry.label }}
          </button>
        }
      </div>
      <div class="pairs-head" aria-hidden="true">
        <span>Source CLI</span>
        <span>Generated in the template</span>
      </div>
    }

    <div class="pairs">
      @for (view of shown; track view.segment.first; let index = $index) {
        @if (gapBefore(index); as gap) {
          <div class="gap">{{ gap }} line{{ gap > 1 ? 's' : '' }} not shown</div>
        }
        <div class="pair" [class]="'pair ' + view.segment.outcome">
          <pre class="cli"><code>@for (line of linesOf(view); track line.number) {<span class="cli-line" [id]="'L' + line.number" [class.target]="line.number === target" [class.blank]="line.outcome === 'none'"><span class="cli-number">{{ line.number }}</span>{{ line.text }}
</span>}</code></pre>
          @if (linesOf(view).length < view.segment.lines.length) {
            <button type="button" class="link-button small more-lines" (click)="unfolded.add(view.segment.first)">Show {{ view.segment.lines.length - linesOf(view).length }} more lines</button>
          }
          <div class="pair-right">
            @switch (view.right.kind) {
              @case ('port') {
                @if (view.right.kind === 'port') {
                  <app-json-view [value]="view.right.value" [rootKey]="view.right.key" [depth]="2" [label]="view.right.key"></app-json-view>
                  <p class="muted small">
                    In the switch rule
                    <button type="button" class="link-button" (click)="openPart.emit('switch_matching.rules.' + view.right.rule)">{{ view.right.rule }}</button>,
                    port profile
                    <button type="button" class="link-button" (click)="openPart.emit('port_usages.' + view.right.usage)">{{ view.right.usage }}</button>
                  </p>
                }
              }
              @case ('part') {
                @if (view.right.kind === 'part') {
                  @if (view.right.repeat) {
                    <p class="muted small">
                      Goes to
                      <button type="button" class="link-button" (click)="openPart.emit(view.right.path)">{{ view.right.name }}</button>,
                      shown above.
                    </p>
                  } @else {
                    <app-json-view [value]="view.right.value" [rootKey]="view.right.rootKey" [depth]="2" [label]="view.right.name"></app-json-view>
                    <button type="button" class="link-button small" (click)="openPart.emit(view.right.path)">Open {{ view.right.name }}</button>
                  }
                }
              }
              @case ('not-converted') {
                @if (view.right.kind === 'not-converted') {
                  <span class="pill not-converted">Not converted</span>
                  @for (message of view.right.messages; track $index) {
                    <p class="small">{{ message.message }}</p>
                  }
                }
              }
              @case ('ignored') {
                <p class="muted small">Not needed in Mist</p>
              }
              @case ('converted') {
                <p class="muted small">Converted</p>
              }
            }
          </div>
        </div>
      } @empty {
        @if (!report?.converted) {
          <pre class="cli"><code>{{ preview }}</code></pre>
        } @else {
          <p class="muted">No line of this kind.</p>
        }
      }
    </div>
  `,
})
export class FileViewComponent implements OnChanges {
  @Input() conversion: Conversion;
  @Input() file: { name: string; text: string; report?: FileReport };
  /** A line to show: scrolled to and highlighted. */
  @Input() line?: number;
  @Output() openPart = new EventEmitter<string>();

  report: FileReport | undefined;
  description = '';
  counts: Record<LineOutcome, number> = { converted: 0, ignored: 0, 'not-converted': 0, none: 0 };
  filters: Array<{ id: Filter; label: string }> = [];
  filter: Filter = 'all';
  views: SegmentView[] = [];
  shown: SegmentView[] = [];
  /** Runs of lines that are not needed and that the user unfolded, by first line. */
  unfolded = new Set<number>();
  target?: number;
  preview = '';

  constructor(private host: ElementRef<HTMLElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    const fileChanged = changes['file'] && changes['file'].previousValue?.name !== this.file.name;
    if (fileChanged) {
      this.filter = 'all';
      this.unfolded = new Set();
    }
    this.report = this.conversion.files.find((entry) => entry.name === this.file.name);
    const report = this.report;
    const lines = this.file.text.split('\n').length;
    this.counts = report?.counts ?? this.counts;
    if (!report || !report.converted) {
      this.description = `${lines} lines. Not read.`;
      this.views = [];
      this.shown = [];
      this.preview = this.file.text.split('\n').slice(0, 200).join('\n');
      return;
    }
    const hostname = report.hostname ? `, switch ${report.hostname}` : '';
    this.description = `${VENDOR_LABEL[report.format]}${hostname}. ${lines} lines, ${report.ports} port${report.ports === 1 ? '' : 's'} in the template.`;
    this.filters = [
      { id: 'all', label: `All ${lines} lines` },
      { id: 'converted', label: `${this.counts.converted} converted` },
      { id: 'ignored', label: `${this.counts.ignored} not needed in Mist` },
      { id: 'not-converted', label: `${this.counts['not-converted']} not converted` },
    ];
    this.views = this.viewsOf(report);
    if (changes['line'] || fileChanged) this.target = this.line;
    if (this.target !== undefined) {
      this.filter = 'all';
      const holder = this.views.find((view) => view.segment.lines.some((line) => line.number === this.target));
      if (holder) this.unfolded.add(holder.segment.first);
    }
    this.applyFilter();
    if (this.target !== undefined && (changes['line'] || fileChanged)) this.scrollToTarget();
  }

  setFilter(filter: Filter): void {
    this.filter = filter;
    this.applyFilter();
  }

  linesOf(view: SegmentView): Segment['lines'] {
    const lines = view.segment.lines;
    if (view.segment.outcome !== 'ignored' || this.unfolded.has(view.segment.first) || lines.length <= SHORT_RUN + 1) return lines;
    return lines.slice(0, SHORT_RUN);
  }

  /** How many lines the filter hides before the segment at this index. */
  gapBefore(index: number): number {
    if (this.filter === 'all') return 0;
    const previous = this.shown[index - 1];
    const end = previous ? previous.segment.first + previous.segment.lines.length : 1;
    return Math.max(0, this.shown[index].segment.first - end);
  }

  private applyFilter(): void {
    this.shown = this.filter === 'all' ? this.views : this.views.filter((view) => view.segment.outcome === this.filter);
  }

  private viewsOf(report: FileReport): SegmentView[] {
    const links = lineLinks(this.conversion, this.file.name);
    const segments = segmentsOf(this.file.text, report.outcomes, links);
    const messages = this.conversion.diagnostics.filter((diagnostic) => diagnostic.file === this.file.name && diagnostic.lines);
    const seen = new Set<string>();
    return segments.map((segment): SegmentView => {
      const link = segment.link;
      if (link?.kind === 'port') {
        const rule = this.conversion.template.switch_matching.rules.find((candidate) => candidate.name === link.port.hostname);
        return { segment, right: { kind: 'port', key: link.portKey, value: rule?.port_config[link.portKey], usage: link.port.usage, rule: link.port.hostname } };
      }
      if (link?.kind === 'part') {
        const part = partOf(link.path);
        const repeat = seen.has(link.path);
        seen.add(link.path);
        const rootKey = part?.kind === 'setting' ? link.path : (part?.name ?? link.path);
        return { segment, right: { kind: 'part', path: link.path, name: part?.name ?? link.path, value: part ? valueOf(this.conversion, part) : undefined, rootKey, repeat } };
      }
      if (segment.outcome === 'not-converted') {
        const numbers = new Set(segment.lines.map((line) => line.number));
        return { segment, right: { kind: 'not-converted', messages: messages.filter((message) => message.lines?.some((line) => numbers.has(line))) } };
      }
      return { segment, right: { kind: segment.outcome === 'ignored' ? 'ignored' : 'converted' } };
    });
  }

  private scrollToTarget(): void {
    setTimeout(() => this.host.nativeElement.querySelector(`#L${this.target}`)?.scrollIntoView({ block: 'center' }), 0);
  }
}
