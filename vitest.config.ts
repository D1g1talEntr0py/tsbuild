import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'src': new URL('./src', import.meta.url).pathname }
  },
  test: {
    environment: 'node',
    globals: false,
    pool: 'vmForks',
    testTimeout: 15_000,
    coverage: {
      reporter: [ 'text', 'json' ],
			reportsDirectory: 'tests/coverage',
      include: [ 'src/**/*.ts' ],
		exclude: [ 'src/index.ts', 'src/tsbuild.ts', 'src/dts/index.ts', 'src/dts/@types', 'src/@types' ]
    }
  }
});