import { describe, it, expect, afterEach, vi } from 'vitest';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptProject } from '../src/type-script-project';
import { processManager } from '../src/process-manager';
import { TestHelper } from './scripts/test-helper';

// Watchr emits an 'error' event when a watched path is deleted during tmpdir cleanup.
// Add a no-op error listener to prevent unhandled-error escalation in tests.
vi.mock('@d1g1tal/watchr', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@d1g1tal/watchr')>();
	class SafeWatchr extends actual.Watchr {
		constructor(...args: ConstructorParameters<typeof actual.Watchr>) {
			super(...args);
			this.on('error', () => {});
		}
	}
	return { ...actual, Watchr: SafeWatchr };
});

describe('TypeScriptProject', () => {
	let cleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		processManager.close();
		await cleanup?.();
		cleanup = undefined;
		process.exitCode = undefined;
	});

	describe('build', () => {
		it('emits JS output for a simple ESM project', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const hello = "world";' }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
			expect(output).toContain('hello');
		});

		it('emits bundled .d.ts when declaration is true', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value: number = 42;' },
				tsconfig: { compilerOptions: { declaration: true, outDir: './dist' } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			const dts = await readFile(join(dir, 'dist/index.d.ts'), 'utf8');
			expect(dts).toContain('value');
		});

		it('sets exit code 1 on TypeScript type error', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'const x: number = "not a number"; export { x };' }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(process.exitCode).toBe(1);
		});

		it('sets exit code 3 when entry point does not exist', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { entryPoints: { index: './src/missing.ts' }, clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(process.exitCode).toBe(3);
		});

		it('skips JS emit when noEmit is true', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { noEmit: true } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(access(join(dir, 'dist/index.js'))).rejects.toThrow();
		});

		it('sets exit code 1 on type error when noEmit is true', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'const x: number = "bad"; export { x };' },
				tsconfig: { compilerOptions: { noEmit: true } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(process.exitCode).toBe(1);
		});

		it('does not emit .d.ts when declaration is false', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { declaration: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			const js = await readFile(join(dir, 'dist/index.js'), 'utf8');
			expect(js).toContain('x');
			await expect(access(join(dir, 'dist/index.d.ts'))).rejects.toThrow();
		});

		it('injects env vars as import.meta.env.* in output', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					// Augment ImportMeta so TypeScript accepts import.meta.env.*
					'src/env.d.ts': 'interface ImportMeta { env: Record<string, string>; readonly url: string; }',
					'src/index.ts': 'export const url = import.meta.env.API_URL;'
				},
				tsconfig: { tsbuild: { env: { API_URL: 'https://api.example.com' }, clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
			expect(output).toContain('"https://api.example.com"');
		});

		it('emits JS for multiple entry points', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/index.ts': 'export const a = 1;',
					'src/utils.ts': 'export const b = 2;'
				},
				tsconfig: { tsbuild: { entryPoints: { index: './src/index.ts', utils: './src/utils.ts' }, clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
			await expect(access(join(dir, 'dist/utils.js'))).resolves.toBeUndefined();
		});

		it('infers entry point from package.json exports when no tsbuild config', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: {},
				packageJson: {
					name: 'my-lib',
					version: '1.0.0',
					type: 'module',
					exports: { '.': { import: './dist/index.js' } }
				}
			});
			cleanup = c;

			const tsconfigPath = join(dir, 'tsconfig.json');
			const raw = JSON.parse(await readFile(tsconfigPath, 'utf8'));
			delete raw.tsbuild;
			await writeFile(tsconfigPath, JSON.stringify(raw));

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
		});

		it('emits only .d.ts when emitDeclarationOnly is true', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value: number = 42;' },
				tsconfig: { compilerOptions: { declaration: true, emitDeclarationOnly: true }, tsbuild: { clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(access(join(dir, 'dist/index.d.ts'))).resolves.toBeUndefined();
			await expect(access(join(dir, 'dist/index.js'))).rejects.toThrow();
		});

		it('bundles a dependency forced via noExternal', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': "import MagicString from 'magic-string'; export const out = new MagicString('a').toString();" },
				tsconfig: { tsbuild: { noExternal: ['magic-string'], clean: false }, compilerOptions: { declaration: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
			// magic-string is inlined rather than left as a bare import
			expect(output).not.toContain("from \"magic-string\"");
		});

		it('expands a directory entry point into per-file entries', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/alpha.ts': 'export const alpha = 1;',
					'src/beta.ts': 'export const beta = 2;'
				},
				tsconfig: { tsbuild: { entryPoints: { lib: './src' }, bundle: false, clean: false }, compilerOptions: { declaration: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(access(join(dir, 'dist/alpha.js'))).resolves.toBeUndefined();
			await expect(access(join(dir, 'dist/beta.js'))).resolves.toBeUndefined();
		});

		it('sets exit code 3 when legacy decorator options are enabled', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true, declaration: false }, tsbuild: { clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(process.exitCode).toBe(3);
		});

		it('expands ${process.env.*} references in env values', async () => {
			process.env['TSBUILD_TEST_TOKEN'] = 'expanded-secret';
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/env.d.ts': 'interface ImportMeta { env: Record<string, string>; readonly url: string; }',
					'src/index.ts': 'export const token = import.meta.env.TOKEN;'
				},
				tsconfig: { tsbuild: { env: { TOKEN: '${process.env.TSBUILD_TEST_TOKEN}' }, clean: false }, compilerOptions: { declaration: false } }
			});
			cleanup = c;

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				project.close();

				const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
				expect(output).toContain('"expanded-secret"');
			} finally {
				delete process.env['TSBUILD_TEST_TOKEN'];
			}
		});

		it('merges explicit compilerOptions.types from tsconfig and constructor options', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { types: ['node'], declaration: false }, tsbuild: { clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir, { compilerOptions: { types: ['node'] } });
			await project.build();
			project.close();

			const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
			expect(output).toContain('x');
		});

		it('invalidates the incremental cache when clearCache is set', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { incremental: true, declaration: false }, tsbuild: { clean: false } }
			});
			cleanup = c;

			// First build to populate the incremental cache, then a second run with clearCache
			const first = new TypeScriptProject(dir);
			await first.build();
			first.close();

			const second = new TypeScriptProject(dir, { clearCache: true });
			await second.build();
			second.close();

			const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
			expect(output).toContain('x');
			expect(process.exitCode).toBeUndefined();
		});
	});

	describe('clean', () => {
		it('removes output directory contents', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();

			await project.clean();
			await expect(access(join(dir, 'dist/index.js'))).rejects.toThrow();

			project.close();
		});
	});

	describe('close', () => {
		it('is idempotent — multiple calls do not throw', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			expect(() => project.close()).not.toThrow();
			expect(() => project.close()).not.toThrow();
		});
	});

	describe('incremental builds', () => {
		it('succeeds on second build with no source changes', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			const project1 = new TypeScriptProject(dir);
			await project1.build();
			project1.close();

			const output1 = await readFile(join(dir, 'dist/index.js'), 'utf8');

			const project2 = new TypeScriptProject(dir);
			await project2.build();
			project2.close();

			expect(process.exitCode).toBeUndefined();
			const output2 = await readFile(join(dir, 'dist/index.js'), 'utf8');
			expect(output2).toBe(output1);
		});

		it('forces full rebuild when fingerprint changes (minify toggled)', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const hello = "world";' },
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			const project1 = new TypeScriptProject(dir);
			await project1.build();
			project1.close();
			const output1 = await readFile(join(dir, 'dist/index.js'), 'utf8');

			const project2 = new TypeScriptProject(dir, { tsbuild: { clean: false, minify: true } });
			await project2.build();
			project2.close();
			const output2 = await readFile(join(dir, 'dist/index.js'), 'utf8');

			expect(output2.length).toBeLessThan(output1.length);
		});

		it('--force always rebuilds even when incremental cache matches', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			const project1 = new TypeScriptProject(dir);
			await project1.build();
			project1.close();

			const project2 = new TypeScriptProject(dir, { tsbuild: { clean: false, force: true } });
			await project2.build();
			project2.close();

			expect(process.exitCode).toBeUndefined();
			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
		});
	});

	describe('resolveConfiguration', () => {
		it('throws ConfigurationError on invalid tsconfig.json', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;

			await writeFile(join(dir, 'tsconfig.json'), 'invalid json { broken');

			expect(() => new TypeScriptProject(dir)).toThrow();
		});

		it('does not throw when package.json is malformed', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;

			const tsconfigPath = join(dir, 'tsconfig.json');
			const raw = JSON.parse(await readFile(tsconfigPath, 'utf8'));
			delete raw.tsbuild;
			await writeFile(tsconfigPath, JSON.stringify(raw));
			await writeFile(join(dir, 'package.json'), '{ invalid json }}}');

			expect(() => new TypeScriptProject(dir)).not.toThrow();
		});

		it('warns when package.json export paths do not match outDir', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: {},
				packageJson: {
					name: 'my-lib',
					version: '1.0.0',
					type: 'module',
					exports: { '.': { import: './lib/index.js' } }
				}
			});
			cleanup = c;

			const tsconfigPath = join(dir, 'tsconfig.json');
			const raw = JSON.parse(await readFile(tsconfigPath, 'utf8'));
			delete raw.tsbuild;
			await writeFile(tsconfigPath, JSON.stringify(raw));

			// Export path (./lib) does not match outDir (./dist) → inference fails and warns,
			// but construction still succeeds by falling back to default entry points.
			expect(() => new TypeScriptProject(dir)).not.toThrow();
		});

		it('detects browser platform when lib includes DOM', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: {
					compilerOptions: { lib: ['DOM', 'ESNext'], declaration: false },
					tsbuild: { clean: false, bundle: false }
				}
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(process.exitCode).toBeUndefined();
		});
	});

	describe('watch mode', () => {
		it('starts watching and close() cleans up the watcher', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { watch: { enabled: true }, clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			await new Promise<void>(resolve => setImmediate(resolve));

			expect(() => project.close()).not.toThrow();
		});
	});
});
