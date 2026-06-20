import { defineConfig, type Plugin } from 'vitest/config';
import { transform, type TransformResult } from 'esbuild';

// Custom esbuild plugin to handle TypeScript decorators in Vitest since the default transformer (OXC) does not support them.
function esbuildDecorators(): Plugin {
  return {
    name: 'esbuild-decorators',
    enforce: 'pre',
    async transform(code, id): Promise<TransformResult | undefined> {
      if (!id.endsWith('.ts') || !code.includes('@')) { return }

      const result = await transform(code, { loader: 'ts', target: 'es2024', sourcefile: id, sourcemap: true });

      return { code: result.code, map: result.map, warnings: [], mangleCache: {}, legalComments: 'none' };
    }
  };
}

export default defineConfig({
	plugins: [ esbuildDecorators() ],
  resolve: {
    alias: { 'src': new URL('./src', import.meta.url).pathname }
  },
  test: {
    environment: 'node',
    globals: false,
    pool: 'vmForks',
    testTimeout: 15_000,
		typecheck: { enabled: false },
    coverage: {
      reporter: [ 'text', 'json' ],
			reportsDirectory: 'tests/coverage',
      include: [ 'src/**/*.ts' ],
      // src/tsbuild.ts is tested (see tests/tsbuild.test.ts) but excluded because
      // Rolldown (coverage-v8 source-map pass) cannot parse TypeScript's `import type` syntax.
      // src/plugins/decorator-metadata.ts: SWC/legacy decorator removal is pending; no test until then.
      exclude: [ 'src/index.ts', 'src/tsbuild.ts', 'src/dts/index.ts', 'src/dts/@types', 'src/@types', 'src/plugins/decorator-metadata.ts' ]
    }
  }
});