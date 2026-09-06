import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages,examples}/**/src/**/*.test.ts'],
    passWithNoTests: false,
  },
});
