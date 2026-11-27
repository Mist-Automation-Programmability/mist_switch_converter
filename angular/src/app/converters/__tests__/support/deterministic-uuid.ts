/**
 * Replacement for `uuid.v4()` in tests, so that profile ids and the suffix added to
 * duplicate profile names are the same on every run.
 *
 * The counter is written into the FIRST four hex digits on purpose: when two profiles
 * end up with the same name, the converter appends the first four hex digits of the
 * profile id to tell them apart, so those digits must differ from one profile to the next.
 */
let counter = 0;

export function nextUuid(): string {
  counter += 1;
  return `${counter.toString(16).padStart(4, '0')}0000-0000-4000-8000-000000000000`;
}

export function resetUuid(): void {
  counter = 0;
}
