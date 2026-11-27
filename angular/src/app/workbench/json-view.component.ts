import { ChangeDetectionStrategy, Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { containerPaths, defaultExpanded, JsonRow, jsonRows } from './json-rows';

/**
 * A JSON value, coloured, where each object and list folds and unfolds. With `toolbar`,
 * buttons above it unfold everything, fold everything, and copy the JSON.
 */
@Component({
  selector: 'app-json-view',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    @if (toolbar) {
      <div class="json-toolbar">
        <button type="button" class="text-button" (click)="expandAll()">Expand all</button>
        <button type="button" class="text-button" (click)="collapseAll()">Collapse all</button>
        <button type="button" class="text-button" (click)="copy()">{{ copied ? 'Copied' : 'Copy' }}</button>
      </div>
    }
    <div class="json" role="tree" [attr.aria-label]="label || 'JSON'">
      @for (row of rows; track row.path) {
        <div class="json-row" [style.padding-left.px]="row.depth * 18 + 26">
          @if (row.foldable) {
            <button type="button" class="json-toggle" [attr.aria-expanded]="!row.folded" [attr.aria-label]="(row.folded ? 'Expand ' : 'Collapse ') + (row.key || 'value')" (click)="toggle(row)">
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" [class.open]="!row.folded"><path d="M9 6l6 6-6 6"></path></svg>
            </button>
          }
          @if (row.key !== undefined) {
            <span class="json-key">{{ row.key }}</span><span class="json-punct">: </span>
          }
          @if (row.scalar) {
            <span [class]="'json-' + row.scalar.type">{{ row.scalar.text }}</span>
          }
          @if (row.open) {
            @if (row.folded) {
              <button type="button" class="json-folded" (click)="toggle(row)">{{ row.open }} … {{ row.close }}</button>
              @if (!row.comma) {
                <span class="json-size">{{ sizeText(row) }}</span>
              }
            } @else if (row.size === 0) {
              <span class="json-punct">{{ row.open }}{{ row.close }}</span>
            } @else {
              <span class="json-punct">{{ row.open }}</span>
            }
          } @else if (row.close) {
            <span class="json-punct">{{ row.close }}</span>
          }
          @if (row.comma) {
            <span class="json-punct">,</span>
            @if (row.folded) {
              <span class="json-size">{{ sizeText(row) }}</span>
            }
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .json-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }
      .json {
        font-family: 'Roboto Mono', ui-monospace, monospace;
        font-size: 13px;
        line-height: 24px;
        background: #f7f9f9;
        border: 1px solid #e6ecec;
        border-radius: 8px;
        padding: 8px 12px 8px 0;
        overflow-x: auto;
      }
      .json-row {
        position: relative;
        white-space: pre;
        min-height: 24px;
      }
      .json-toggle {
        position: absolute;
        margin-left: -24px;
        top: 0;
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: none;
        color: #53666a;
        border-radius: 4px;
        cursor: pointer;
        padding: 0;
      }
      .json-toggle:hover {
        background: #dff3f2;
        color: #05635e;
      }
      .json-toggle svg {
        transition: transform 0.1s;
      }
      .json-toggle svg.open {
        transform: rotate(90deg);
      }
      .json-folded {
        font: inherit;
        border: 1px solid #d3dcdd;
        border-radius: 4px;
        background: #fff;
        color: #53666a;
        padding: 0 4px;
        cursor: pointer;
        line-height: 18px;
      }
      .json-size {
        color: #53666a;
        font-family: Roboto, sans-serif;
        font-size: 12px;
        margin-left: 8px;
      }
      .json-key {
        color: #05635e;
      }
      .json-string {
        color: #8a4600;
      }
      .json-number {
        color: #1d4fb8;
      }
      .json-boolean,
      .json-null {
        color: #7a2e9e;
      }
      .json-punct {
        color: #53666a;
      }
    `,
  ],
})
export class JsonViewComponent implements OnChanges {
  @Input() value: unknown;
  /** The key written before the value: the name of the part. */
  @Input() rootKey?: string;
  /** How many levels are unfolded when the value is first shown. */
  @Input() depth = 3;
  @Input() toolbar = false;
  @Input() label = '';

  rows: JsonRow[] = [];
  copied = false;
  private expanded = new Set<string>();

  ngOnChanges(changes: SimpleChanges): void {
    // A new part is unfolded as at first; the same part, converted again, keeps its folds
    if (changes['rootKey'] || changes['depth'] || this.expanded.size === 0) this.expanded = defaultExpanded(this.value, this.depth);
    this.refresh();
  }

  toggle(row: JsonRow): void {
    if (this.expanded.has(row.path)) this.expanded.delete(row.path);
    else this.expanded.add(row.path);
    this.refresh();
  }

  expandAll(): void {
    this.expanded = new Set(containerPaths(this.value));
    this.refresh();
  }

  collapseAll(): void {
    this.expanded = new Set(['']);
    this.refresh();
  }

  copy(): void {
    const text = JSON.stringify(this.rootKey === undefined ? this.value : { [this.rootKey]: this.value }, undefined, 2);
    navigator.clipboard?.writeText(text).then(() => {
      this.copied = true;
      setTimeout(() => (this.copied = false), 1500);
    });
  }

  sizeText(row: JsonRow): string {
    return `${row.size} ${row.size === 1 ? 'item' : 'items'}`;
  }

  private refresh(): void {
    this.rows = jsonRows(this.value, this.expanded, this.rootKey);
  }
}
