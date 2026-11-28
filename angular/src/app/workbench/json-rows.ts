/**
 * A JSON value as lines, for a view where each object and list can be folded. Plain
 * functions with no Angular: the component only draws the rows.
 */

export type JsonScalar = 'string' | 'number' | 'boolean' | 'null';

export interface JsonRow {
  /** Identifies the node: '' for the root, then one "\u0000"-separated step per key or index. */
  path: string;
  depth: number;
  /** The key of an object member, written with its quotes. Absent for list items and the root. */
  key?: string;
  /** A scalar value. */
  scalar?: { type: JsonScalar; text: string };
  /** The opening bracket of an object or list. */
  open?: '{' | '[';
  /** The closing bracket of an object or list, on its own row. */
  close?: '}' | ']';
  /** Set on the opening row of an object or list that has members. */
  foldable?: boolean;
  /** True when that object or list is folded: the row shows "{ … }" and how many items it has. */
  folded?: boolean;
  /** Number of members of an object or list. */
  size?: number;
  /** A comma follows the row. */
  comma: boolean;
}

function scalarOf(value: unknown): { type: JsonScalar; text: string } {
  if (value === null || value === undefined) return { type: 'null', text: 'null' };
  if (typeof value === 'string') return { type: 'string', text: JSON.stringify(value) };
  if (typeof value === 'number') return { type: 'number', text: String(value) };
  return { type: 'boolean', text: String(value) };
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function entriesOf(value: Record<string, unknown> | unknown[]): Array<[string | undefined, unknown]> {
  if (Array.isArray(value)) return value.map((item) => [undefined, item]);
  // As JSON.stringify writes it: members without a value are left out
  return Object.entries(value).filter(([, item]) => item !== undefined);
}

function childPath(path: string, step: string | number): string {
  return path === '' ? String(step) : `${path}\u0000${step}`;
}

/** The rows of a value, with the objects and lists whose path is in `expanded` unfolded. */
export function jsonRows(value: unknown, expanded: ReadonlySet<string>, rootKey?: string): JsonRow[] {
  const rows: JsonRow[] = [];
  const visit = (node: unknown, path: string, depth: number, key: string | undefined, comma: boolean): void => {
    const quotedKey = key === undefined ? undefined : JSON.stringify(key);
    if (!isContainer(node)) {
      rows.push({ path, depth, key: quotedKey, scalar: scalarOf(node), comma });
      return;
    }
    const list = Array.isArray(node);
    const entries = entriesOf(node);
    const open = list ? '[' : '{';
    const close = list ? ']' : '}';
    if (entries.length === 0) {
      rows.push({ path, depth, key: quotedKey, open, close, size: 0, comma });
      return;
    }
    if (!expanded.has(path)) {
      rows.push({ path, depth, key: quotedKey, open, close, foldable: true, folded: true, size: entries.length, comma });
      return;
    }
    rows.push({ path, depth, key: quotedKey, open, foldable: true, folded: false, size: entries.length, comma: false });
    entries.forEach(([childKey, child], index) => visit(child, childPath(path, childKey ?? index), depth + 1, childKey, index < entries.length - 1));
    rows.push({ path: `${path}\u0001`, depth, close, comma });
  };
  visit(value, '', 0, rootKey, false);
  return rows;
}

/** The paths of every object and list of a value that has members. */
export function containerPaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (!isContainer(node)) return;
    const entries = entriesOf(node);
    if (entries.length === 0) return;
    paths.push(path);
    entries.forEach(([key, child], index) => visit(child, childPath(path, key ?? index)));
  };
  visit(value, '');
  return paths;
}

/**
 * What is unfolded when a value is first shown: the objects and lists down to `depth`
 * levels, except the long ones (more than `maxSize` members), which stay folded.
 */
export function defaultExpanded(value: unknown, depth: number, maxSize = 24): Set<string> {
  const expanded = new Set<string>();
  const visit = (node: unknown, path: string, level: number): void => {
    if (!isContainer(node) || level >= depth) return;
    const entries = entriesOf(node);
    if (entries.length === 0 || (level > 0 && entries.length > maxSize)) return;
    expanded.add(path);
    entries.forEach(([key, child], index) => visit(child, childPath(path, key ?? index), level + 1));
  };
  visit(value, '', 0);
  return expanded;
}
