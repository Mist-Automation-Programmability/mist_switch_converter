/**
 * The part of a conversion that is recorded in a golden file: `expected.json` for
 * a fixture, and a file under `test_configs/_results` for a local configuration.
 */
import type { Conversion, FileResult } from './harness';
import type { MistTemplate } from '../../template/mist';

export interface Golden {
  files: FileResult[];
  /** One line per interface of the sources: "<hostname> <interface> = <port usage>". */
  ports: string[];
  /** What the user is told went wrong or needs attention. */
  problems: string[];
  errors: string[];
  template: MistTemplate;
}

export function goldenOf(result: Conversion): Golden {
  return {
    files: result.files,
    ports: result.ports.map((port) => `${port.hostname} ${port.source} = ${port.usage}`),
    problems: result.logs.filter((entry) => entry.level !== 'info').map((entry) => `${entry.level}: ${entry.message}`),
    errors: result.errors.map((error) => String(error)),
    template: result.template,
  };
}

/** The text written to a golden file. */
export function goldenText(golden: object): string {
  return JSON.stringify(golden, null, 2) + '\n';
}
