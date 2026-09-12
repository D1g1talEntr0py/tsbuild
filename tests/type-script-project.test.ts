import { describe, it, expect, afterEach, vi, type MockInstance } from 'vitest';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { versionMajorMinor } from 'typescript';
import { context, type BuildContext } from 'esbuild';
import { TypeScriptProject } from '../src/type-script-project';
import { Files } from '../src/files';
import { Logger } from '../src/logger';
import { Paths } from '../src/paths';
import { processManager } from '../src/process-manager';
import { TestHelper } from './scripts/test-helper';
import { alwaysUndefined } from 'src/constants';
import { bundleDeclarations } from '../src/dts/declaration-bundler';
import { EsbuildRunner } from '../src/project/esbuild-runner';
import { flushPerformanceLog } from '../src/decorators/performance-logger';

const typeScript6OrNewer = Number(versionMajorMinor.split('.')[0]) >= 6;

vi.mock('esbuild', async (importOriginal) => {
	const actual = await importOriginal<typeof import('esbuild')>();
	return { ...actual, context: vi.fn(actual.context) };
});

vi.mock('../src/dts/declaration-bundler', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/dts/declaration-bundler')>();
	return { ...actual, bundleDeclarations: vi.fn(actual.bundleDeclarations) };
});

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
		it('logs initialization first and reconciles displayed build overhead', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject();
			cleanup = c;
			const stepSpy = vi.spyOn(Logger, 'step').mockImplementation(() => {});
			const subStepsSpy = vi.spyOn(Logger, 'subSteps').mockImplementation(() => {});

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				flushPerformanceLog();
				await project.close();

				const messages = stepSpy.mock.calls.map(([ message ]) => message.replace(/\x1b\[[0-9;]*m/g, ''));
				const initializationIndex = messages.findIndex(message => message.includes('Initialization'));
				const typeCheckIndex = messages.findIndex(message => message.includes('Type-checking/Emit'));
				const duration = (label: string) => Number(/\((\d+)ms\)/.exec(messages.find(message => message.includes(label)) ?? '')?.[1]);
				const groupedSteps = subStepsSpy.mock.calls.flatMap(([ steps ]) => steps);
				const completed = Number(/Completed in (\d+)ms/.exec(messages.find(message => message.includes('Completed in')) ?? '')?.[1]);
				const overhead = duration('Overhead');

				expect(initializationIndex).toBeGreaterThanOrEqual(0);
				expect(typeCheckIndex).toBeGreaterThan(initializationIndex);
				expect(messages.filter(message => message.includes('Bundle'))).toHaveLength(1);
				expect(messages.some(message => message.includes('Process Declarations') || message.includes('Transpile'))).toBe(false);
				expect(groupedSteps.map(({ name }) => name)).toEqual([ 'Process Declarations', 'Transpile' ]);
				expect(completed).toBe(duration('Initialization') + duration('Type-checking/Emit') + duration('Bundle') + overhead);
			} finally {
				stepSpy.mockRestore();
				subStepsSpy.mockRestore();
			}
		});

		it('starts declaration bundling and transpilation concurrently', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 1;' },
				tsconfig: { compilerOptions: { declaration: true }, tsbuild: { clean: false } }
			});
			cleanup = c;
			const declarationStarted = Promise.withResolvers<void>();
			const transpileStarted = Promise.withResolvers<void>();
			const declarationSpy = vi.mocked(bundleDeclarations).mockImplementationOnce(async () => {
				declarationStarted.resolve();
				await transpileStarted.promise;
				return [];
			});
			const transpileSpy = vi.spyOn(EsbuildRunner.prototype, 'run').mockImplementationOnce(async () => {
				transpileStarted.resolve();
				await declarationStarted.promise;
				return [];
			});

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				await project.close();

				expect(declarationSpy).toHaveBeenCalledOnce();
				expect(transpileSpy).toHaveBeenCalledOnce();
			} finally {
				declarationSpy.mockRestore();
				transpileSpy.mockRestore();
			}
		});

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

		it('runs a scoped TypeScript plugin with non-erasable syntax and project path aliases', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/index.ts': 'export const hello = "world";',
					'build-support/message.ts': 'export const message = "plugin-ran";',
					'build/plugin.ts': [
						'import { writeFile } from "node:fs/promises";',
						'import { join } from "node:path";',
						'import { message } from "@plugin/message";',
						'import type { Plugin } from "esbuild";',
						'enum Output { Marker = "plugin-output.txt" }',
						'export default function (): Plugin {',
						'  return {',
						'    name: "scoped-typescript-plugin",',
						'    setup(build) {',
						'      build.onEnd(() => writeFile(join(build.initialOptions.absWorkingDir!, Output.Marker), message));',
						'    },',
						'  };',
						'}'
					].join('\n')
				},
				tsconfig: {
					compilerOptions: {
						baseUrl: '.',
						...(typeScript6OrNewer ? { ignoreDeprecations: '6.0' } : {}),
						paths: { '@plugin/*': [ './build-support/*' ] }
					},
					tsbuild: { plugins: [ './build/plugin.ts' ] }
				}
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(readFile(join(dir, 'plugin-output.txt'), 'utf8')).resolves.toBe('plugin-ran');
			expect(process.exitCode).toBeUndefined();
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

		it('does not finalize incremental state after a phase failure', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value: number = 42;' },
				tsconfig: { compilerOptions: { declaration: true } }
			});
			cleanup = c;

			let fail = true;
			const plugin = {
				name: 'fail-once',
				setup(build: { onEnd: (callback: () => void) => void }) {
					build.onEnd(() => {
						if (fail) { throw new Error('intentional phase failure') }
					});
				}
			};

			const first = new TypeScriptProject(dir, { tsbuild: { plugins: [ plugin ] } });
			await first.build();
			first.close();
			await expect(access(join(dir, '.tsbuild/tsconfig.tsbuildinfo'))).rejects.toThrow();

			process.exitCode = undefined;
			fail = false;
			const second = new TypeScriptProject(dir, { tsbuild: { plugins: [ plugin ] } });
			await second.build();
			second.close();

			expect(process.exitCode).toBeUndefined();
			await expect(readFile(join(dir, 'dist/index.js'), 'utf8')).resolves.toContain('value');
		});

		it('writes shebang entry points with executable mode from the start', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': '#!/usr/bin/env node\nexport const value = 1;' },
				tsconfig: { compilerOptions: { declaration: false } }
			});
			cleanup = c;

			const originalWriteFiles = Files.writeFiles.bind(Files);
			let capturedEntries: Array<{ path: string; data: string | NodeJS.ArrayBufferView; options?: { mode?: number } }> = [];
			const writeFilesSpy = vi.spyOn(Files, 'writeFiles').mockImplementation(async (projectDirectory, entries) => {
				capturedEntries = entries as Array<{ path: string; data: string | NodeJS.ArrayBufferView; options?: { mode?: number } }>;
				return await originalWriteFiles(projectDirectory, entries);
			});
			const chmodSpy = vi.spyOn(Files, 'chmod').mockImplementation(async () => {
				throw new Error('chmod should not be used for shebang writes');
			});

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				project.close();

				const entry = capturedEntries.find((entry) => entry.path === join(dir, 'dist/index.js'));
				expect(entry?.options).toMatchObject({ mode: 0o755 });
			} finally {
				writeFilesSpy.mockRestore();
				chmodSpy.mockRestore();
			}
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

		it('names array entry points by source file stem', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/index.ts': 'export const a = 1;',
					'src/cli.ts': 'export const b = 2;'
				},
				tsconfig: { tsbuild: { entryPoints: ['./src/index.ts', './src/cli.ts'] } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
			await expect(access(join(dir, 'dist/cli.js'))).resolves.toBeUndefined();
		});

		it('rejects duplicate array entry point stems during construction', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/first/index.ts': 'export const a = 1;', 'src/second/index.ts': 'export const b = 2;' },
				tsconfig: { tsbuild: { entryPoints: ['./src/first/index.ts', './src/second/index.ts'] } }
			});
			cleanup = c;

			expect(() => new TypeScriptProject(dir)).toThrow('Duplicate entry point stem: index');
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

		it('does not read dependency metadata when noExternal is empty', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 1;' },
				tsconfig: { tsbuild: { entryPoints: { index: './src/index.ts' }, clean: false }, compilerOptions: { declaration: false } }
			});
			cleanup = c;
			const packagePath = join(dir, 'package.json');
			const readSpy = vi.spyOn(Files, 'read');

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(readSpy.mock.calls.some(([path]) => path === packagePath)).toBe(false);
			readSpy.mockRestore();
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

		it('warns once for each missing environment variable without exposing values', async () => {
			delete process.env['TSBUILD_MISSING_VALUE'];
			const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: {
					'src/env.d.ts': 'interface ImportMeta { env: Record<string, string>; readonly url: string; }',
					'src/index.ts': 'export const values = [import.meta.env.FIRST, import.meta.env.SECOND];'
				},
				tsconfig: {
					tsbuild: {
						env: {
							FIRST: '${process.env.TSBUILD_MISSING_VALUE}',
							SECOND: 'prefix-${process.env.TSBUILD_MISSING_VALUE}'
						},
						clean: false
					},
					compilerOptions: { declaration: false }
				}
			});
			cleanup = c;

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				project.close();

				expect(warnSpy).toHaveBeenCalledTimes(1);
				expect(warnSpy).toHaveBeenCalledWith('Environment variable TSBUILD_MISSING_VALUE is not set; substituting an empty string.');
				expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('expanded-secret');
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('warns with the package path when package.json is malformed during entry-point inference', async () => {
			const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 1;' },
				tsconfig: { tsbuild: { entryPoints: undefined } }
			});
			cleanup = c;
			const packageJsonPath = join(dir, 'package.json');
			await writeFile(packageJsonPath, '{"name":');

			try {
				new TypeScriptProject(dir).close();
				expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(packageJsonPath));
				expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('explicit entryPoints'));
			} finally {
				warnSpy.mockRestore();
			}
		});

		it('does not warn when package.json is absent during entry-point inference', async () => {
			const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
			const { dir, cleanup: c } = await TestHelper.createTempProject({ tsconfig: { tsbuild: { entryPoints: undefined } } });
			cleanup = c;
			await rm(join(dir, 'package.json'));

			try {
				new TypeScriptProject(dir).close();
				expect(warnSpy).not.toHaveBeenCalled();
			} finally {
				warnSpy.mockRestore();
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
		it('reuses canonicalized project input paths across validations', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject();
			cleanup = c;
			const sourcePath = join(dir, 'src/index.ts');
			const canonicalSpy = vi.spyOn(Paths, 'canonical');
			const project = new TypeScriptProject(dir);

			try {
				await project.build();
				await project.clean();

				expect(canonicalSpy.mock.calls.filter(([path]) => path === sourcePath)).toHaveLength(1);
			} finally {
				project.close();
				canonicalSpy.mockRestore();
			}
		});

		it('allows a dedicated dist directory with clean enabled', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				tsconfig: { tsbuild: { clean: true } }
			});
			cleanup = c;
			const { mkdir } = await import('node:fs/promises');
			await mkdir(join(dir, 'dist'), { recursive: true });
			await writeFile(join(dir, 'dist/stale.txt'), 'stale');

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
			await expect(access(join(dir, 'dist/stale.txt'))).rejects.toThrow();
			expect(process.exitCode).toBeUndefined();
		});

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

		it.each([
			[ 'the project directory', '.' ],
			[ 'a project ancestor', '..' ],
			[ 'a directory containing project inputs', '../' ]
		])('rejects clean output at %s before mutating the filesystem', async (_description, outDir) => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				tsconfig: { compilerOptions: { outDir }, tsbuild: { clean: true } }
			});
			cleanup = c;
			const emptySpy = vi.spyOn(Files, 'empty');
			const writeSpy = vi.spyOn(Files, 'writeFiles');

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				project.close();

				expect(process.exitCode).toBe(3);
				expect(emptySpy).not.toHaveBeenCalled();
				expect(writeSpy).not.toHaveBeenCalled();
			} finally {
				emptySpy.mockRestore();
				writeSpy.mockRestore();
			}
		});

		it('rejects a symlink alias to the project before cleaning', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				tsconfig: { compilerOptions: { outDir: './project-alias' }, tsbuild: { clean: true } }
			});
			cleanup = c;
			const { symlink } = await import('node:fs/promises');
			await symlink(dir, join(dir, 'project-alias'));
			const emptySpy = vi.spyOn(Files, 'empty');
			const writeSpy = vi.spyOn(Files, 'writeFiles');

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				project.close();

				expect(process.exitCode).toBe(3);
				expect(emptySpy).not.toHaveBeenCalled();
				expect(writeSpy).not.toHaveBeenCalled();
			} finally {
				emptySpy.mockRestore();
				writeSpy.mockRestore();
			}
		});

		it('rejects declaration entry names that escape outDir even with clean disabled', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				tsconfig: {
					compilerOptions: { outDir: './dist', declaration: true },
					tsbuild: { clean: false, entryPoints: { '../outside': './src/index.ts' } }
				}
			});
			cleanup = c;
			const emptySpy = vi.spyOn(Files, 'empty');
			const writeSpy = vi.spyOn(Files, 'writeFiles');

			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				project.close();

				expect(process.exitCode).toBe(3);
				expect(emptySpy).not.toHaveBeenCalled();
				expect(writeSpy).not.toHaveBeenCalled();
				await expect(access(join(dir, 'outside.d.ts'))).rejects.toThrow();
			} finally {
				emptySpy.mockRestore();
				writeSpy.mockRestore();
			}
		});
	});

	describe('close', () => {
		it('registers exactly once through the decorator', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;
			const registerSpy = vi.spyOn(processManager, 'addCloseable');
			try {
				const project = new TypeScriptProject(dir);
				expect(registerSpy).toHaveBeenCalledExactlyOnceWith(project);
				await project.close();
			} finally {
				registerSpy.mockRestore();
			}
		});

		it('is idempotent — multiple calls do not throw', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir);
			expect(() => project.close()).not.toThrow();
			expect(() => project.close()).not.toThrow();
		});

		it('removes itself from the process manager so it is not retained after close', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;

			const removeSpy = vi.spyOn(processManager, 'removeCloseable');
			const project = new TypeScriptProject(dir);
			project.close();

			expect(removeSpy).toHaveBeenCalledWith(project);
			removeSpy.mockRestore();
		});

		it('does not leave closed projects registered for process-exit cleanup (no unbounded growth)', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;

			const closeSpy = vi.spyOn(TypeScriptProject.prototype, 'close');
			const projects = Array.from({ length: 5 }, () => new TypeScriptProject(dir));
			for (const project of projects) { project.close() }
			closeSpy.mockClear();

			// If closed projects were still retained by the process manager, this would re-invoke close() on each.
			process.emit('exit', 0);
			expect(closeSpy).not.toHaveBeenCalled();
			closeSpy.mockRestore();
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
				files: {
					'src/index.ts': 'import type { Greeting } from "./types"; export const hello: Greeting = "world";',
					'src/types.ts': 'export type Greeting = string;'
				},
				tsconfig: { compilerOptions: { declaration: true } }
			});
			cleanup = c;

			const project1 = new TypeScriptProject(dir);
			await project1.build();
			await project1.close();
			const output1 = await readFile(join(dir, 'dist/index.js'), 'utf8');

			const project2 = new TypeScriptProject(dir, {}, { force: false, watch: false, minify: true });
			await project2.build();
			await project2.close();
			const output2 = await readFile(join(dir, 'dist/index.js'), 'utf8');

			expect(output2.length).toBeLessThan(output1.length);
			await expect(readFile(join(dir, 'dist/index.d.ts'), 'utf8')).resolves.toContain('type Greeting = string;');
		});

		it('--force always rebuilds even when incremental cache matches', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { declaration: true } }
			});
			cleanup = c;

			const project1 = new TypeScriptProject(dir);
			await project1.build();
			project1.close();

			const project2 = new TypeScriptProject(dir, {}, { force: true, watch: false, minify: false });
			await project2.build();
			project2.close();

			expect(process.exitCode).toBeUndefined();
			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
			await expect(readFile(join(dir, 'dist/index.d.ts'), 'utf8')).resolves.toContain('x');
		});
	});

	describe('resolveConfiguration', () => {
		it('detects browser platform from an inherited DOM lib', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const title = document.title;' }
			});
			cleanup = c;

			await writeFile(join(dir, 'base.json'), JSON.stringify({ compilerOptions: { lib: ['ES2022', 'DOM'] } }));
			await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './base.json', compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, outDir: './dist', declaration: false }, tsbuild: { entryPoints: { index: './src/index.ts' }, clean: false } }));

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(process.exitCode).toBeUndefined();
		});

		it('honors an explicit node platform over inherited DOM detection', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const version = process.version;' }
			});
			cleanup = c;

			await writeFile(join(dir, 'base.json'), JSON.stringify({ compilerOptions: { lib: ['ES2022', 'DOM'] } }));
			await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './base.json', compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, outDir: './dist', declaration: false }, tsbuild: { platform: 'node', entryPoints: { index: './src/index.ts' }, clean: false } }));

			const project = new TypeScriptProject(dir);
			await project.build();
			project.close();

			expect(process.exitCode).toBeUndefined();
		});

		it('throws ConfigurationError on invalid tsconfig.json', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;

			await writeFile(join(dir, 'tsconfig.json'), 'invalid json { broken');

			expect(() => new TypeScriptProject(dir)).toThrow();
		});

		it('rejects unknown JSON tsbuild keys with valid-key guidance', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				tsconfig: { tsbuild: { entyPoints: {} } }
			});
			cleanup = c;

			expect(() => new TypeScriptProject(dir)).toThrow('Unknown configuration key "tsbuild.entyPoints". Valid keys:');
		});

		it.each([
			[ 'dts', { dts: { entyPoints: [] } }, 'tsbuild.dts.entyPoints' ],
			[ 'banner', { banner: { html: 'banner' } }, 'tsbuild.banner.html' ],
			[ 'footer', { footer: { html: 'footer' } }, 'tsbuild.footer.html' ],
			[ 'iife', { iife: { name: 'Example' } }, 'tsbuild.iife.name' ]
		])('rejects unknown %s keys with their complete path', async (_name, tsbuild, path) => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({ tsconfig: { tsbuild } });
			cleanup = c;

			expect(() => new TypeScriptProject(dir)).toThrow(`Unknown configuration key "${path}"`);
		});

		it.each([
			[ 'clearCache', true ],
			[ 'force', true ],
			[ 'minify', true ],
			[ 'watch', true ]
		])('rejects tsconfig %s with CLI guidance', async (option, value) => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({ tsconfig: { tsbuild: { [option]: value } } });
			cleanup = c;

			expect(() => new TypeScriptProject(dir)).toThrow(`Configuration option "tsbuild.${option}" is CLI-only; use the "--${option}" command-line option.`);
		});

		it('validates only the JSON source and preserves programmatic plugin objects', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject();
			cleanup = c;
			const plugin = { name: 'programmatic-plugin', setup: alwaysUndefined };

			expect(() => new TypeScriptProject(dir, { tsbuild: { plugins: [ plugin ] } })).not.toThrow();
		});

		it('does not validate tsbuild keys in an extended config', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject();
			cleanup = c;

			await writeFile(join(dir, 'base.json'), JSON.stringify({ tsbuild: { unknownInheritedKey: true } }));
			await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './base.json', tsbuild: { clean: false } }));

			expect(() => new TypeScriptProject(dir)).not.toThrow();
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
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir, { tsbuild: { clean: false } }, { force: false, watch: true, minify: false });
			await project.build();
			await new Promise<void>(resolve => setImmediate(resolve));

			expect(() => project.close()).not.toThrow();
		});
	});

	describe('async cleanup', () => {
		it('disposes a context created during shutdown before close resolves without resurrecting the watcher', async () => {
			const { dir, cleanup: cleanupProject } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value = 1;' },
				tsconfig: { compilerOptions: { declaration: false }, tsbuild: { clean: false } }
			});
			cleanup = cleanupProject;

			const { Watchr } = await import('@d1g1tal/watchr');
			const contextMock = vi.mocked(context);
			const originalContext = contextMock.getMockImplementation()!;
			const contextEntered = Promise.withResolvers<void>();
			const releaseContext = Promise.withResolvers<void>();
			const disposeEntered = Promise.withResolvers<void>();
			const releaseDispose = Promise.withResolvers<void>();
			const events: string[] = [];
			let disposeSpy: MockInstance<BuildContext['dispose']> | undefined;
			let disposeContext: (() => Promise<void>) | undefined;
			let disposed = false;
			let build: Promise<void> | undefined;
			const watcherListenerSpy = vi.spyOn(Watchr.prototype, 'on');
			const project = new TypeScriptProject(dir, {}, { force: false, watch: true, minify: false });

			try {
				contextMock.mockImplementation(async (options) => {
					contextEntered.resolve();
					await releaseContext.promise;
					const watchContext = await originalContext(options);
					disposeContext = watchContext.dispose.bind(watchContext);
					disposeSpy = vi.spyOn(watchContext, 'dispose').mockImplementation(async () => {
						disposeEntered.resolve();
						await releaseDispose.promise;
						await disposeContext!();
						disposed = true;
						events.push('disposed');
					});
					return watchContext;
				});
				build = project.build();
				await Promise.race([ contextEntered.promise, build.then(() => { throw new Error('Build completed before entering context creation') }) ]);

				const closing = project.close();
				const closed = closing.then(() => { events.push('closed') });
				expect(project.close()).toBe(closing);
				await Promise.resolve();
				expect(events).toEqual([]);

				releaseContext.resolve();
				await Promise.race([ disposeEntered.promise, closed ]);
				expect(disposeSpy).toHaveBeenCalledOnce();
				expect(events).toEqual([]);
				releaseDispose.resolve();
				await Promise.all([ build, closed ]);

				expect(events).toEqual([ 'disposed', 'closed' ]);
				expect(disposeSpy).toHaveBeenCalledOnce();
				expect(watcherListenerSpy).not.toHaveBeenCalled();
				expect(process.exitCode).toBeUndefined();
			} finally {
				releaseContext.resolve();
				releaseDispose.resolve();
				try {
					await Promise.allSettled([ build, project.close() ]);
					if (!disposed) { await disposeContext?.() }
				} finally {
					disposeSpy?.mockRestore();
					watcherListenerSpy.mockRestore();
					contextMock.mockImplementation(originalContext);
				}
			}
		});

		it('waits for an in-flight build before releasing state', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { declaration: true }, tsbuild: { clean: false } }
			});
			cleanup = c;

			let releaseClean!: () => void;
			let cleanStarted!: () => void;
			const cleanReady = new Promise<void>((resolve) => { cleanStarted = resolve });
			const pendingClean = new Promise<void>((resolve) => { releaseClean = resolve });
			const writeCompressedSpy = vi.spyOn(Files, 'writeCompressed').mockImplementation(async () => {
				cleanStarted();
				await pendingClean;
			});

			try {
				const project = new TypeScriptProject(dir);
				const build = project.build();
				await cleanReady;

				const closing = project.close();
				let settled = false;
				void closing.then(() => { settled = true });
				await Promise.resolve();
				expect(settled).toBe(false);

				releaseClean();
				await build;
				await closing;
			} finally {
				writeCompressedSpy.mockRestore();
			}
		});

		it('waits for pending cache I/O and is idempotent', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { declaration: true }, tsbuild: { clean: false } }
			});
			cleanup = c;

			let release!: () => void;
			const pendingWrite = new Promise<void>((resolve) => { release = resolve });
			const writeCompressedSpy = vi.spyOn(Files, 'writeCompressed').mockImplementation(async () => pendingWrite);

			try {
				const project = new TypeScriptProject(dir);
				await project.build();

				const shutdown = project.close(1000);
				expect(project.close()).toBe(shutdown);
				expect(project[Symbol.asyncDispose]()).toBe(shutdown);
				let settled = false;
				shutdown.finally(() => { settled = true });
				await Promise.resolve();
				expect(writeCompressedSpy).toHaveBeenCalled();
				expect(settled).toBe(false);

				release();
				await shutdown;
			} finally {
				writeCompressedSpy.mockRestore();
			}
		});

		it('reports cache errors and timeout failures', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { declaration: true }, tsbuild: { clean: false } }
			});
			cleanup = c;

			const writeCompressedSpy = vi.spyOn(Files, 'writeCompressed').mockRejectedValue(new Error('cache write failed'));
			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				await expect(project.close()).rejects.toThrow('cache write failed');
			} finally {
				writeCompressedSpy.mockRestore();
			}

			let release!: () => void;
			const pendingWrite = new Promise<void>((resolve) => { release = resolve });
			const pendingWriteSpy = vi.spyOn(Files, 'writeCompressed').mockImplementation(async () => pendingWrite);
			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				await expect(project.close(1)).rejects.toThrow('timed out after 1ms');
				release();
			} finally {
				pendingWriteSpy.mockRestore();
			}
		});

		it('waits for watch context disposal exactly once', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			const project = new TypeScriptProject(dir, {}, { force: false, watch: true, minify: false });
			await project.build();
			const watchContext = await vi.mocked(context).mock.results.at(-1)!.value;
			const dispose = watchContext.dispose.bind(watchContext);
			let release!: () => void;
			const pendingDispose = new Promise<void>((resolve) => { release = resolve });
			const disposeSpy = vi.spyOn(watchContext, 'dispose').mockImplementation(async () => {
				await pendingDispose;
				await dispose();
			});
			try {
				const closing = project.close();
				expect(project.close()).toBe(closing);
				let settled = false;
				void closing.then(() => { settled = true });
				await Promise.resolve();
				expect(disposeSpy).toHaveBeenCalledOnce();
				expect(settled).toBe(false);
				release();
				await closing;
				expect(disposeSpy).toHaveBeenCalledOnce();
			} finally {
				release();
				await project.close();
				disposeSpy.mockRestore();
			}
		});

		it.each([ false, true ])('await using drains cache writes when scope throws: %s', async (throws) => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { compilerOptions: { declaration: true }, tsbuild: { clean: false } }
			});
			cleanup = c;
			let release!: () => void;
			const pendingWrite = new Promise<void>((resolve) => { release = resolve });
			const writeSpy = vi.spyOn(Files, 'writeCompressed').mockImplementation(async () => pendingWrite);
			try {
				const project = new TypeScriptProject(dir);
				await project.build();
				const scopeError = new Error('scope failed');
				const scope = (async () => {
					await using resource = project;
					expect(resource).toBe(project);
					if (throws) { throw scopeError }
				})();
				let settled = false;
				const outcome = scope.then(() => { settled = true }, (error: unknown) => { settled = true; return error });
				await Promise.resolve();
				expect(writeSpy).toHaveBeenCalled();
				expect(settled).toBe(false);
				release();
				expect(await outcome).toBe(throws ? scopeError : undefined);
			} finally {
				release();
				writeSpy.mockRestore();
			}
		});

		it('rejects invalid timeouts without preventing later cleanup', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' }
			});
			cleanup = c;
			const project = new TypeScriptProject(dir);
			for (const timeout of [ -1, NaN, Infinity ]) {
				await expect(project.close(timeout)).rejects.toThrow('finite non-negative');
			}
			await expect(project.close(0)).resolves.toBeUndefined();
		});
	});
});
