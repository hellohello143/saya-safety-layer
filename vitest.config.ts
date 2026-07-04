import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Each file runs isolated (own module registry) so per-file env + in-memory
    // DB singletons don't leak across files.
    isolate: true,
  },
});
