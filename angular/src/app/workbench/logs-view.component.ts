import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Conversion, Diagnostic, messageKind } from '../converters/convert';
import { linesText } from '../converters/report';
import { countByKind, KIND_LABEL, LOG_FILTERS, LogFilter, logsCsv, partOf } from './view-model';

/** Rows shown before "Show more". */
const PAGE = 100;

/** Every message of the conversion, sorted by what the user has to do about it. */
@Component({
  selector: 'app-logs-view',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <div class="detail-head">
      <span class="eyebrow">Logs</span>
      <h2>{{ title }}</h2>
      <p class="muted">{{ counts.all }} messages from {{ conversion.files.length }} file{{ conversion.files.length > 1 ? 's' : '' }}. Each one says the file and the lines it is about.</p>
    </div>
    <div class="pills" role="group" aria-label="Show the messages">
      @for (entry of filters; track entry.id) {
        <button type="button" class="filter-pill" [class.selected]="filter === entry.id" [attr.aria-pressed]="filter === entry.id" (click)="filterChange.emit(entry.id)">{{ entry.label }} {{ counts[entry.id] }}</button>
      }
    </div>
    <label class="filter wide">
      <span class="sr-only">Search the messages</span>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-4-4"></path></svg>
      <input type="search" placeholder="Search a file, a command, a port" [(ngModel)]="search" (ngModelChange)="refresh()" />
    </label>
    <div class="table-wrap">
      <table class="logs">
        <thead>
          <tr>
            <th scope="col">Kind</th>
            <th scope="col">File</th>
            <th scope="col">Lines</th>
            <th scope="col">Message</th>
            <th scope="col">In the template</th>
          </tr>
        </thead>
        <tbody>
          @for (message of rows; track $index) {
            <tr>
              <td><span class="pill" [class]="'pill ' + kindOf(message)">{{ kindLabel(message) }}</span></td>
              <td>
                @if (message.file) {
                  <button type="button" class="link-button" (click)="openFile.emit({ name: message.file, line: message.lines?.[0] })">{{ message.file }}</button>
                } @else {
                  <span class="muted">All files</span>
                }
              </td>
              <td class="numbers">{{ linesText(message.lines) }}</td>
              <td>{{ message.message }}</td>
              <td>
                @if (message.subject && isPart(message.subject)) {
                  <button type="button" class="link-button mono" (click)="openPart.emit(message.subject)">{{ message.subject }}</button>
                }
              </td>
            </tr>
          } @empty {
            <tr>
              <td colspan="5" class="muted">No message of this kind.</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
    <div class="row-actions">
      @if (matching.length > rows.length) {
        <button type="button" class="secondary-button" (click)="more()">Show {{ Math.min(page, matching.length - rows.length) }} more</button>
      }
      <button type="button" class="secondary-button" (click)="downloadCsv()">Download the logs</button>
    </div>
  `,
})
export class LogsViewComponent implements OnChanges {
  @Input() conversion: Conversion;
  @Input() filter: LogFilter = 'all';
  @Output() filterChange = new EventEmitter<LogFilter>();
  @Output() openFile = new EventEmitter<{ name: string; line?: number }>();
  @Output() openPart = new EventEmitter<string>();
  @Output() download = new EventEmitter<{ text: string; name: string }>();

  readonly filters = LOG_FILTERS;
  readonly linesText = linesText;
  readonly Math = Math;
  readonly page = PAGE;
  counts = countByKind([]);
  title = '';
  search = '';
  matching: Diagnostic[] = [];
  rows: Diagnostic[] = [];
  private shownCount = PAGE;

  ngOnChanges(): void {
    this.counts = countByKind(this.conversion.diagnostics);
    this.title = this.filter === 'all' ? 'All logs' : (LOG_FILTERS.find((entry) => entry.id === this.filter)?.label ?? 'Logs');
    this.shownCount = PAGE;
    this.refresh();
  }

  refresh(): void {
    const words = this.search.toLowerCase().split(/\s+/).filter((word) => word !== '');
    this.matching = this.conversion.diagnostics.filter((message) => {
      if (this.filter !== 'all' && messageKind(message) !== this.filter) return false;
      const text = `${message.file} ${message.message} ${message.subject ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    this.rows = this.matching.slice(0, this.shownCount);
  }

  more(): void {
    this.shownCount += PAGE;
    this.rows = this.matching.slice(0, this.shownCount);
  }

  kindOf(message: Diagnostic): string {
    return messageKind(message);
  }

  kindLabel(message: Diagnostic): string {
    return KIND_LABEL[messageKind(message)];
  }

  isPart(path: string): boolean {
    return partOf(path) !== undefined;
  }

  downloadCsv(): void {
    this.download.emit({ text: logsCsv(this.conversion.diagnostics), name: 'logs.csv' });
  }
}
