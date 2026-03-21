import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestHelper } from './scripts/test-helper';
import { vol } from 'memfs';
import { join } from 'node:path';
import { TypeScriptProject } from '../src/type-script-project';
import { Logger } from '../src/logger';
import { bundleDeclarations } from '../src/dts/declaration-bundler';
import { createIncrementalProgram } from 'typescript';
import type { TypeScriptOptions } from '../src/@types';

vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

const mocks = vi.hoisted(() => ({
	emitMock: vi.fn((..._args: unknown[]) => ({ diagnostics: [] as import('typescript').Diagnostic[] })),
	getSemanticDiagnosticsMock: vi.fn((): import('typescript').Diagnostic[] => []),
	getSourceFilesMock: vi.fn((): Array<{ isDeclarationFile: boolean; fileName: string }> => [])
}));

vi.mock('typescript', async (importOriginal) => {
	const mod = await importOriginal<typeof import('typescript')>();
	return {
		...mod,
		createIncrementalProgram: vi.fn(() => ({
			getCompilerOptions: () => ({}),
			getRootFileNames: () => [],
			getSemanticDiagnostics: mocks.getSemanticDiagnosticsMock,
			emit: mocks.emitMock,
			getProgram: () => ({
				getRootFileNames: () => [],
				getSourceFiles: mocks.getSourceFilesMock,
				emit: mocks.emitMock,
				getTypeChecker: () => ({ getExportsOfModule: () => [], getAmbientModules: () => [] })
			})
		})),
		sys: mod.sys
	};
});

vi.mock('../src/logger', () => ({
	Logger: {
		info: vi.fn(), error: vi.fn(), log: vi.fn(), clear: vi.fn(),
		warn: vi.fn(), success: vi.fn(), header: vi.fn(), separator: vi.fn(),
		step: vi.fn(), subSteps: vi.fn(),
		EntryType: { Info: 'info', Success: 'success', Done: 'done', Error: 'error', Warn: 'warn' }
	}
}));

vi.mock('../src/process-manager', () => ({
	processManager: { addCloseable: vi.fn(), close: vi.fn() }
}));

vi.mock('../src/dts/declaration-bundler', () => ({
	bundleDeclarations: vi.fn(() => Promise.resolve([]))
}));

const esbuildMocks = vi.hoisted(() => ({
	buildMock: vi.fn(async (options: { outdir: string; plugins?: Array<{ setup: (build: unknown) => void }>; entryPoints: Record<string, string>; define?: Record<string, string> }) => {
		const onEndCallbacks: Array<(result: { outputFiles: Array<{ path: string; contents: Uint8Array }> }) => unknown> = [];
		const build = {
			onEnd: (callback: (result: { outputFiles: Array<{ path: string; contents: Uint8Array }> }) => unknown): void => { onEndCallbacks.push(callback); },
			onResolve: (): void => {},
			onLoad: (): void => {},
			initialOptions: options
		};

		for (const plugin of options.plugins ?? []) { plugin.setup(build); }

		const encoder = new TextEncoder();
		const outputFiles = Object.keys(options.entryPoints).map((name) => {
			const defineValue = options.define?.['import.meta.env.API_URL'] ?? 'undefined';
			const contents = encoder.encode(`export const __API_URL = ${defineValue};\nexport {};\n`);
			return { path: `${options.outdir}/${name}.js`, contents };
		});

		for (const callback of onEndCallbacks) { await callback({ outputFiles }); }

		return { warnings: [], errors: [], metafile: { outputs: Object.fromEntries(outputFiles.map((file) => [file.path, { bytes: file.contents.length }])) }, outputFiles };
	}),
	formatMessagesMock: vi.fn(async () => [])
}));

vi.mock('esbuild', () => ({
	build: esbuildMocks.buildMock,
	formatMessages: esbuildMocks.formatMessagesMock
}));

describe('TypeScriptProject', () => {
	beforeEach(async () => {
		mocks.emitMock.mockClear();
		mocks.getSemanticDiagnosticsMock.mockClear();
		mocks.getSourceFilesMock.mockClear();
		esbuildMocks.buildMock.mockClear();
		vi.mocked(bundleDeclarations).mockClear();
		mocks.emitMock.mockImplementation((_target: unknown, writeFile: unknown) => {
			if (writeFile) (writeFile as Function)('test.d.ts', '', false, undefined, []);
			return { diagnostics: [] };
		});
		await TestHelper.setup();
	});

	afterEach(() => {
		TestHelper.teardown();
		process.exitCode = undefined;
	});

	const createProject = (directory: string, options: TypeScriptOptions = {}): InstanceType<typeof TypeScriptProject> => {
		return new TypeScriptProject(directory, {
			...options,
			tsbuild: {
				...(options.tsbuild as Record<string, unknown>),
				plugins: [TestHelper.createEsbuildPlugin(), ...((options.tsbuild as Record<string, unknown>)?.plugins as [] || [])]
			}
		});
	};

	describe('constructor', () => {
		it('creates project with default options', () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});

			const project = createProject(projectPath);
			expect(project).toBeDefined();
			expect(typeof project.build).toBe('function');
		});

		it('defaults types to ["node"]', () => {
			vi.mocked(createIncrementalProgram).mockClear();
			TestHelper.createTestProject({ tsconfig: { compilerOptions: {} } });

			createProject(process.cwd());
			const callOptions = vi.mocked(createIncrementalProgram).mock.calls[0][0].options;
			expect(callOptions.types).toContain('node');
		});

		it('merges user types with node default', () => {
			vi.mocked(createIncrementalProgram).mockClear();
			TestHelper.createTestProject({ tsconfig: { compilerOptions: { types: ['jest'] } } });

			createProject(process.cwd());
			const callOptions = vi.mocked(createIncrementalProgram).mock.calls[0][0].options;
			expect(callOptions.types).toContain('node');
			expect(callOptions.types).toContain('jest');
		});

		it('does not duplicate node in types', () => {
			vi.mocked(createIncrementalProgram).mockClear();
			TestHelper.createTestProject({ tsconfig: { compilerOptions: { types: ['node', 'jest'] } } });

			createProject(process.cwd());
			const callOptions = vi.mocked(createIncrementalProgram).mock.calls[0][0].options;
			expect(callOptions.types?.filter((t: string) => t === 'node')).toHaveLength(1);
		});
	});

	describe('clean', () => {
		it('removes output directory contents', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});
			const outDir = join(projectPath, 'dist');
			vol.mkdirSync(outDir, { recursive: true });
			vol.writeFileSync(join(outDir, 'output.js'), 'content');

			const project = createProject(projectPath);
			await project.clean();
			expect(vol.existsSync(join(outDir, 'output.js'))).toBe(false);
		});
	});

	describe('build', () => {
		it('sets exit code 3 when entry point does not exist', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { tsbuild: { entryPoints: { index: './src/missing.ts' } } },
				files: { 'src/index.ts': 'export const hello = "world";' }
			});
			const project = createProject(projectPath);

			await project.build();
			expect(process.exitCode).toBe(3);
		});

		it('skips transpile when noEmit is true', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { noEmit: true } }
			});
			const project = createProject(projectPath);

			await project.build();
			expect(esbuildMocks.buildMock).not.toHaveBeenCalled();
			expect(bundleDeclarations).not.toHaveBeenCalled();
			expect(mocks.emitMock).toHaveBeenCalled();
		});

		it('sets exit code 1 when type checking fails', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			const mockFile = { fileName: 'test.ts', text: 'const x: string = 123;', getLineAndCharacterOfPosition: () => ({ line: 0, character: 6 }) };
			mocks.emitMock.mockReturnValueOnce({
				diagnostics: [{ file: mockFile, messageText: 'Type error', start: 6, length: 1, category: 1, code: 2322 } as unknown as import('typescript').Diagnostic]
			});

			await project.build();
			expect(process.exitCode).toBe(1);
			expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Found 1 error in test.ts:1'));
		});

		it('outputs tsc-style summary for errors in same file', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			const mockFile = { fileName: 'test.ts', text: 'errors', getLineAndCharacterOfPosition: () => ({ line: 0, character: 6 }) };
			mocks.emitMock.mockReturnValueOnce({
				diagnostics: [
					{ file: mockFile, messageText: 'Error 1', start: 0, length: 1, category: 1, code: 2322 } as unknown as import('typescript').Diagnostic,
					{ file: mockFile, messageText: 'Error 2', start: 10, length: 1, category: 1, code: 2322 } as unknown as import('typescript').Diagnostic
				]
			});

			await project.build();
			expect(process.exitCode).toBe(1);
			expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Found 2 errors in the same file'));
		});

		it('outputs tsc-style summary for errors in multiple files', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			const mockFileA = { fileName: 'a.ts', text: 'x', getLineAndCharacterOfPosition: () => ({ line: 0, character: 6 }) };
			const mockFileB = { fileName: 'b.ts', text: 'y', getLineAndCharacterOfPosition: () => ({ line: 2, character: 6 }) };
			mocks.emitMock.mockReturnValueOnce({
				diagnostics: [
					{ file: mockFileA, messageText: 'Error 1', start: 0, length: 1, category: 1, code: 2322 } as unknown as import('typescript').Diagnostic,
					{ file: mockFileB, messageText: 'Error 2', start: 10, length: 1, category: 1, code: 2322 } as unknown as import('typescript').Diagnostic
				]
			});

			await project.build();
			expect(process.exitCode).toBe(1);
			expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Found 2 errors in 2 files.'));
		});

		it('calls transpile when declaration is false', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			await project.build();
			expect(esbuildMocks.buildMock).toHaveBeenCalled();
			expect(bundleDeclarations).not.toHaveBeenCalled();
		});

		it('bundles declarations when declaration is true', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: true, incremental: false } }
			});
			const project = createProject(projectPath);

			await project.build();
			expect(bundleDeclarations).toHaveBeenCalled();
		});
	});

	describe('incremental builds', () => {
		it('skips build when no .tsbuildinfo change with declarations', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: true, incremental: true } }
			});
			const project = createProject(projectPath);
			mocks.emitMock.mockImplementationOnce(() => ({ diagnostics: [] }));

			await project.build();
			expect(bundleDeclarations).not.toHaveBeenCalled();
			expect(esbuildMocks.buildMock).not.toHaveBeenCalled();
		});

		it('always runs transpile for incremental without declarations', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false, incremental: true } }
			});
			const project = createProject(projectPath);
			mocks.emitMock.mockImplementationOnce(() => ({ diagnostics: [] }));

			await project.build();
			expect(esbuildMocks.buildMock).toHaveBeenCalled();
		});

		it('runs full build when .tsbuildinfo changes', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: true, incremental: true } }
			});
			const project = createProject(projectPath);
			mocks.emitMock.mockImplementationOnce((_target: unknown, writeFile: unknown) => {
				if (writeFile) {
					(writeFile as Function)('test.d.ts', 'export {};', false, undefined, []);
					(writeFile as Function)('tsconfig.tsbuildinfo', '{}', false, undefined, []);
				}
				return { diagnostics: [] };
			});

			await project.build();
			expect(bundleDeclarations).toHaveBeenCalled();
			expect(esbuildMocks.buildMock).toHaveBeenCalled();
		});

		it('only type-checks when noEmit is true', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: true, incremental: true, noEmit: true } }
			});
			const project = createProject(projectPath);

			await project.build();
			expect(mocks.emitMock).toHaveBeenCalled();
			expect(bundleDeclarations).not.toHaveBeenCalled();
			expect(esbuildMocks.buildMock).not.toHaveBeenCalled();
		});

		it('runs full build with --force even when no changes detected', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: true, incremental: true } }
			});
			const project = createProject(projectPath, { tsbuild: { force: true } });
			mocks.emitMock.mockImplementationOnce(() => ({ diagnostics: [] }));

			await project.build();
			expect(bundleDeclarations).toHaveBeenCalled();
			expect(esbuildMocks.buildMock).toHaveBeenCalled();
		});
	});

	describe('transpile', () => {
		it('injects environment variables into output', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});
			const project = createProject(projectPath, {
				tsbuild: { env: { 'API_URL': 'https://api.example.com' } }
			});

			vol.writeFileSync(join(projectPath, 'src/index.ts'), 'export const url = import.meta.env.API_URL;');
			await (project as any).transpile();

			const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
			expect(output).toContain('"https://api.example.com"');
		});

		it('expands process.env references in env values', async () => {
			process.env.TEST_VAR_FOR_TSBUILD = 'expanded-value';
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});
			const project = createProject(projectPath, {
				tsbuild: { env: { 'MY_VAR': '${process.env.TEST_VAR_FOR_TSBUILD}' } }
			});

			await (project as any).transpile();
			const buildCall = esbuildMocks.buildMock.mock.calls[0]?.[0];
			expect(buildCall.define['import.meta.env.MY_VAR']).toBe('"expanded-value"');
			delete process.env.TEST_VAR_FOR_TSBUILD;
		});

		it('uses externalModulesPlugin when noExternal patterns exist', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});
			const project = createProject(projectPath, {
				tsbuild: { noExternal: ['lodash'] }
			});

			await (project as any).transpile();
			expect(esbuildMocks.buildMock).toHaveBeenCalled();
			const buildCall = esbuildMocks.buildMock.mock.calls[0]?.[0];
			// Should have more than just outputPlugin due to externalModulesPlugin
			expect(buildCall.plugins.length).toBeGreaterThanOrEqual(2);
		});

		it('handles esbuild warnings', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			esbuildMocks.buildMock.mockResolvedValueOnce({
				warnings: [{ text: 'Some warning' }],
				errors: [],
				metafile: { outputs: {} }
			});
			esbuildMocks.formatMessagesMock.mockResolvedValueOnce(['Formatted warning']);

			await (project as any).transpile();
			expect(esbuildMocks.formatMessagesMock).toHaveBeenCalled();
		});

		it('returns empty array on esbuild errors', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			esbuildMocks.buildMock.mockResolvedValueOnce({
				warnings: [],
				errors: [{ text: 'Some error' }],
				metafile: { outputs: {} }
			});
			esbuildMocks.formatMessagesMock.mockResolvedValueOnce(['Formatted error']);

			const result = await (project as any).transpile();
			expect(result).toEqual([]);
		});

		it('logs and re-throws unexpected esbuild exceptions', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			esbuildMocks.buildMock.mockRejectedValueOnce(new Error('esbuild crashed'));

			await expect((project as any).transpile()).rejects.toThrow('esbuild crashed');
			expect(Logger.error).toHaveBeenCalledWith('Transpile failed', expect.any(Error));
		});
	});

	describe('triggerRebuild', () => {
		it('adds new files to rootNames on add event', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);
			const newFilePath = join(projectPath, 'src/new-module.ts');

			vi.mocked(createIncrementalProgram).mockClear();
			(project as any).pendingChanges.push({ event: 'add', path: newFilePath });
			await (project as any).triggerRebuild();

			const lastCall = vi.mocked(createIncrementalProgram).mock.calls.at(-1);
			expect(lastCall?.[0].rootNames).toContain(newFilePath);
		});

		it('does not duplicate existing files on add event', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);
			const existingPath = join(projectPath, 'src/index.ts');

			(project as any).builderProgram = {
				getCompilerOptions: () => ({}),
				getRootFileNames: () => [existingPath],
				emit: mocks.emitMock,
				getProgram: () => ({
					getRootFileNames: () => [existingPath],
					getSourceFiles: () => [],
					emit: mocks.emitMock,
					getTypeChecker: () => ({ getExportsOfModule: () => [], getAmbientModules: () => [] })
				})
			};

			vi.mocked(createIncrementalProgram).mockClear();
			(project as any).pendingChanges.push({ event: 'add', path: existingPath });
			await (project as any).triggerRebuild();

			const rootNames = vi.mocked(createIncrementalProgram).mock.calls.at(-1)?.[0].rootNames ?? [];
			expect(rootNames.filter((n: string) => n === existingPath)).toHaveLength(1);
		});

		it('removes files from rootNames on unlink event', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);
			const deletedPath = join(projectPath, 'src/deleted.ts');

			(project as any).builderProgram = {
				getCompilerOptions: () => ({}),
				getRootFileNames: () => [deletedPath],
				emit: mocks.emitMock,
				getProgram: () => ({
					getRootFileNames: () => [deletedPath],
					getSourceFiles: () => [],
					emit: mocks.emitMock,
					getTypeChecker: () => ({ getExportsOfModule: () => [], getAmbientModules: () => [] })
				})
			};

			vi.mocked(createIncrementalProgram).mockClear();
			(project as any).pendingChanges.push({ event: 'unlink', path: deletedPath });
			await (project as any).triggerRebuild();

			const rootNames = vi.mocked(createIncrementalProgram).mock.calls.at(-1)?.[0].rootNames ?? [];
			expect(rootNames).not.toContain(deletedPath);
		});

		it('updates rootNames on rename event', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);
			const oldPath = join(projectPath, 'src/old.ts');
			const newPath = join(projectPath, 'src/new.ts');

			(project as any).builderProgram = {
				getCompilerOptions: () => ({}),
				getRootFileNames: () => [oldPath],
				emit: mocks.emitMock,
				getProgram: () => ({
					getRootFileNames: () => [oldPath],
					getSourceFiles: () => [],
					emit: mocks.emitMock,
					getTypeChecker: () => ({ getExportsOfModule: () => [], getAmbientModules: () => [] })
				})
			};
			(project as any).buildDependencies.add('src/old.ts');

			vi.mocked(createIncrementalProgram).mockClear();
			(project as any).pendingChanges.push({ event: 'rename', path: oldPath, nextPath: newPath });
			await (project as any).triggerRebuild();

			const rootNames = vi.mocked(createIncrementalProgram).mock.calls.at(-1)?.[0].rootNames ?? [];
			expect(rootNames).toContain(newPath);
			expect(rootNames).not.toContain(oldPath);
		});

		it('does nothing when pendingChanges is empty', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			vi.mocked(createIncrementalProgram).mockClear();
			await (project as any).triggerRebuild();
			// Should not have called createIncrementalProgram again
			expect(vi.mocked(createIncrementalProgram)).not.toHaveBeenCalled();
		});
	});

	describe('close', () => {
		it('is callable without error', () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});
			const project = createProject(projectPath);
			expect(() => project.close()).not.toThrow();
		});
	});

	describe('handleBuildError', () => {
		it('sets exit code 1 for unexpected errors', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			esbuildMocks.buildMock.mockRejectedValueOnce(new Error('something unexpected'));

			await project.build();
			expect(process.exitCode).toBe(1);
			expect(Logger.error).toHaveBeenCalledWith('Build failed', expect.any(Error));
		});

		it('does not set exit code in watch mode for BuildError', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath, { tsbuild: { watch: { enabled: true } } });

			// Return source files so the buildDependencies loop body executes
			mocks.getSourceFilesMock.mockReturnValue([
				{ isDeclarationFile: false, fileName: join(projectPath, 'src/index.ts') },
				{ isDeclarationFile: true, fileName: join(projectPath, 'src/index.d.ts') }
			]);
			mocks.emitMock.mockReturnValueOnce({
				diagnostics: [{ file: { fileName: 'test.ts', text: 'x', getLineAndCharacterOfPosition: () => ({ line: 0, character: 0 }) }, messageText: 'Error', start: 0, length: 1, category: 1, code: 2322 }]
			});

			await project.build();
			expect(process.exitCode).toBeUndefined();
		});

		it('does not set exit code in watch mode for unexpected errors', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath, { tsbuild: { watch: { enabled: true } } });

			esbuildMocks.buildMock.mockRejectedValueOnce(new Error('unexpected'));

			await project.build();
			expect(process.exitCode).toBeUndefined();
		});
	});

	describe('resolveConfiguration', () => {
		it('detects browser platform from DOM lib', () => {
			vi.mocked(createIncrementalProgram).mockClear();
			TestHelper.createTestProject({
				tsconfig: { compilerOptions: { lib: ['DOM', 'ESNext'] } }
			});

			const project = createProject(process.cwd());
			// Browser platform means packages === 'bundle'
			expect((project as any).buildConfiguration.platform).toBe('browser');
		});

		it('defaults to node platform without DOM lib', () => {
			TestHelper.createTestProject({
				tsconfig: { compilerOptions: { lib: ['ESNext'] } }
			});

			const project = createProject(process.cwd());
			expect((project as any).buildConfiguration.platform).toBe('node');
		});

		it('infers entry points from package.json exports', () => {
			TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: { outDir: 'dist' },
					tsbuild: undefined
				},
				packageJson: {
					name: 'my-pkg',
					version: '1.0.0',
					type: 'module',
					exports: { '.': { import: './dist/index.js' } }
				}
			});

			// Remove tsbuild section completely to trigger inference
			const tsconfig = JSON.parse(vol.readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf8') as string);
			delete tsconfig.tsbuild;
			vol.writeFileSync(join(process.cwd(), 'tsconfig.json'), JSON.stringify(tsconfig));

			const project = createProject(process.cwd());
			expect(project).toBeDefined();
		});

		it('throws ConfigurationError for invalid tsconfig', () => {
			vol.writeFileSync(join(process.cwd(), 'tsconfig.json'), 'invalid json { broken');

			expect(() => createProject(process.cwd())).toThrow();
		});

		it('ignores malformed package.json when inferring entry points', () => {
			TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: { outDir: 'dist' },
					tsbuild: undefined
				}
			});

			// Remove tsbuild section and write malformed package.json
			const tsconfig = JSON.parse(vol.readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf8') as string);
			delete tsconfig.tsbuild;
			vol.writeFileSync(join(process.cwd(), 'tsconfig.json'), JSON.stringify(tsconfig));
			vol.writeFileSync(join(process.cwd(), 'package.json'), '{ invalid json }}}');

			// Should not throw — the catch block silences the JSON parse error
			const project = createProject(process.cwd());
			expect(project).toBeDefined();
		});

		it('warns when package.json has export fields but entry points cannot be inferred', () => {
			TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: { outDir: 'dist' },
					tsbuild: undefined
				}
			});

			// Remove tsbuild section and write package.json with non-matching export paths
			const tsconfig = JSON.parse(vol.readFileSync(join(process.cwd(), 'tsconfig.json'), 'utf8') as string);
			delete tsconfig.tsbuild;
			vol.writeFileSync(join(process.cwd(), 'tsconfig.json'), JSON.stringify(tsconfig));
			vol.writeFileSync(join(process.cwd(), 'package.json'), JSON.stringify({
				name: 'test-project',
				version: '1.0.0',
				type: 'module',
				exports: { '.': { import: './lib/index.mjs' } }
			}));

			const project = createProject(process.cwd());
			expect(project).toBeDefined();
			expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not infer entry points'));
		});
	});

	describe('getEntryPoints', () => {
		it('expands directory entry points to individual files', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } },
				files: {
					'src/index.ts': 'export const a = 1;',
					'src/utils.ts': 'export const b = 2;'
				}
			});
			const project = createProject(projectPath, {
				tsbuild: { entryPoints: { src: './src' } }
			});

			const entryPoints = await (project as any).buildConfiguration.entryPoints;
			// Should have expanded the directory into individual files
			expect(Object.keys(entryPoints).length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('transpile', () => {
		it('loads SWC decorator metadata plugin when emitDecoratorMetadata is enabled', async () => {
			const projectPath = TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: {
						outDir: 'dist',
						experimentalDecorators: true,
						emitDecoratorMetadata: true
					}
				},
				files: { 'src/index.ts': 'export const a = 1;' }
			});

			const project = createProject(projectPath);
			await project.build();

			// The plugin should have been loaded and passed to esbuild
			const buildCall = esbuildMocks.buildMock.mock.calls[0][0];
			const pluginNames = buildCall.plugins.map((p: { name: string }) => p.name);
			expect(pluginNames).toContain('esbuild:swc-decorator-metadata');
		});
	});
});
