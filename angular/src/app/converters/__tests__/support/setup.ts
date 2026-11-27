import { vi } from 'vitest';

// Applied to every test file: the converter gets predictable ids instead of random ones.
vi.mock('uuid', async () => {
  const { nextUuid } = await import('./deterministic-uuid');
  return { v4: nextUuid };
});
