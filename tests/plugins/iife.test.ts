import { describe, it, expect, afterEach } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { iifePlugin } from 'src/plugins/iife';
import type { IifePluginInstance } from 'src/plugins/iife';
import type { PluginBuild } from 'esbuild';
import { TestHelper } from '../scripts/test-helper';

describe('iifePlugin', () => {
	let cleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	describe('factory', () => {
		it('has the correct plugin name', () => {
			expect(iifePlugin().plugin.name).toBe('esbuild:iife');
		});

		it('returns a plugin and an empty files array', () => {
			const instance: IifePluginInstance = iifePlugin();
			expect(typeof instance.plugin.setup).toBe('function');
			expect(instance.files).toEqual([]);
		});

		it('does not register onEnd when outdir is missing', () => {
			const { plugin } = iifePlugin();
			let called = false;
			const build: Partial<PluginBuild> = {
				initialOptions: {} as PluginBuild['initialOptions'],
				onEnd: () => { called = true },
			};
			plugin.setup(build as PluginBuild);
			expect(called).toBe(false);
		});
	});

	describe('real esbuild integration', () => {
		it('produces ESM output and IIFE output alongside it', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 42;' }
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			// ESM output in outdir
			const esm = await readFile(join(dir, 'dist/index.js'), 'utf8');
			expect(esm).toContain('value');

			// IIFE output in outdir/iife
			const iife = await readFile(join(dir, 'dist/iife/index.js'), 'utf8');
			expect(iife).toContain('value');
		});

		it('wraps exports in named global when globalName is provided', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 42;' }
			});
			cleanup = c;

			const instance = iifePlugin({ globalName: 'MyLib' });
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			const iife = await readFile(join(dir, 'dist/iife/index.js'), 'utf8');
			expect(iife).toContain('globalThis.MyLib');
		});

		it('uses flat Object.assign when no globalName is provided', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 42;' }
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			const iife = await readFile(join(dir, 'dist/iife/index.js'), 'utf8');
			expect(iife).toContain('Object.assign(globalThis');
		});

		it('produces source map file when sourcemap is enabled', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 42;' }
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				sourcemap: true,
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			await expect(access(join(dir, 'dist/iife/index.js.map'))).resolves.toBeUndefined();
		});

		it('produces minified IIFE output when minify is true', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 42;' }
			});
			cleanup = c;

			const instanceMinified = iifePlugin();
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist-min'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				minify: true,
				plugins: [instanceMinified.plugin],
				logLevel: 'silent',
			});

			const instanceNormal = iifePlugin();
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist-normal'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				minify: false,
				plugins: [instanceNormal.plugin],
				logLevel: 'silent',
			});

			const minified = await readFile(join(dir, 'dist-min/iife/index.js'), 'utf8');
			const normal = await readFile(join(dir, 'dist-normal/iife/index.js'), 'utf8');
			// Minified output should be shorter
			expect(minified.length).toBeLessThan(normal.length);
		});

		it('produces IIFE output for each entry point in a multi-entry build', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/index.ts': 'export const a = 1;',
					'src/utils.ts': 'export const b = 2;',
				}
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: {
					index: join(dir, 'src/index.ts'),
					utils: join(dir, 'src/utils.ts'),
				},
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			await expect(access(join(dir, 'dist/iife/index.js'))).resolves.toBeUndefined();
			await expect(access(join(dir, 'dist/iife/utils.js'))).resolves.toBeUndefined();
		});

		it('populates the files array with written IIFE output paths', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 42;' }
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			expect(instance.files.length).toBeGreaterThan(0);
			expect(instance.files.some(f => f.path.includes('iife'))).toBe(true);
		});

		it('supports array-form entry points with string and object entries', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/index.ts': 'export const a = 1;',
					'src/utils.ts': 'export const b = 2;',
				}
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: [
					join(dir, 'src/index.ts'),
					{ in: join(dir, 'src/utils.ts'), out: 'utils' },
				],
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			await expect(access(join(dir, 'dist/iife/index.js'))).resolves.toBeUndefined();
			await expect(access(join(dir, 'dist/iife/utils.js'))).resolves.toBeUndefined();
		});

		it('inlines split chunks via the virtual loader for self-contained IIFE output', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/shared.ts': 'export const shared = 10;',
					'src/index.ts': "import { shared } from './shared.js'; export const a = shared + 1;",
					'src/utils.ts': "import { shared } from './shared.js'; export const b = shared + 2;",
				}
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: {
					index: join(dir, 'src/index.ts'),
					utils: join(dir, 'src/utils.ts'),
				},
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				splitting: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			// The split shared chunk must be inlined into each self-contained IIFE entry.
			const iife = await readFile(join(dir, 'dist/iife/index.js'), 'utf8');
			expect(iife).toContain('10');
			expect(iife).not.toContain('import');
		});

		it('marks bare specifiers as external in the IIFE build', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/index.ts': "import { dirname } from 'node:path'; export const dir = dirname('/a/b');",
				}
			});
			cleanup = c;

			const instance = iifePlugin();
			await build({
				entryPoints: { index: join(dir, 'src/index.ts') },
				outdir: join(dir, 'dist'),
				format: 'esm',
				bundle: true,
				platform: 'node',
				packages: 'external',
				plugins: [instance.plugin],
				logLevel: 'silent',
			});

			// The bare specifier stays external (imported), not inlined, in the IIFE output.
			const iife = await readFile(join(dir, 'dist/iife/index.js'), 'utf8');
			expect(iife).toContain('node:path');
		});
	});
});
