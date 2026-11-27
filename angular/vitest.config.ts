import { defineConfig } from 'vitest/config';

// The converter is plain TypeScript with no DOM, network or Angular dependency at runtime,
// so its tests run directly in Node. Nothing here starts a browser or the Angular compiler.
export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['src/app/converters/**/*.test.ts'],
    // `vitest run --mode defects` (npm run test:defects) runs the known defects as
    // normal tests, so that each one fails with its real message.
    env: mode === 'defects' ? { SHOW_DEFECTS: '1' } : {},
  },
}));
