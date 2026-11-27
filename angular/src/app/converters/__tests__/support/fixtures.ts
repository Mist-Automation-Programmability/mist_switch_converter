/**
 * Access to the configuration files in `__fixtures__`.
 *
 * A fixture is a directory that holds one or more input files (`*.txt`, `*.cfg`,
 * `*.config`, converted together in alphabetical order) and `expected.json`, the
 * recorded result of the conversion.
 *
 * Every file in `__fixtures__` is synthetic. Never add a customer configuration:
 * see the README next to the tests.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import type { InputFile } from './harness';

export const FIXTURES_DIR = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
export const TESTS_DIR = fileURLToPath(new URL('../', import.meta.url));

const INPUT_FILE = /\.(txt|cfg|config)$/;

export interface Fixture {
  /** Path below `__fixtures__`, for example `cisco-ios/catalyst-9300-access`. */
  name: string;
  dir: string;
  inputs: InputFile[];
}

/** Every file below `dir`, as absolute paths, in alphabetical order. */
export function listFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

export function loadFixtures(): Fixture[] {
  const byDirectory = new Map<string, InputFile[]>();
  for (const path of listFiles(FIXTURES_DIR)) {
    if (!INPUT_FILE.test(path)) continue;
    const dir = join(path, '..');
    const inputs = byDirectory.get(dir) ?? [];
    inputs.push({ name: relative(dir, path), text: readFileSync(path, 'utf8') });
    byDirectory.set(dir, inputs);
  }
  return [...byDirectory.entries()].map(([dir, inputs]) => ({ name: relative(FIXTURES_DIR, dir).split(sep).join('/'), dir, inputs }));
}
