import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestHelper } from './scripts/test-helper';
import { vol } from 'memfs';
import { join } from 'node:path';
import { TypeScriptProject } from '../src/type-script-project';
import { Logger } from '../src/logger';
import { Paths } from '../src/paths';
import { bundleDeclarations } from '../src/dts/declaration-bundler';
import type { TypeScriptOptions } from '../src/@types';

// Mock node:fs and node:fs/promises with memfs
vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

// Hoist mock variables
const mocks = vi.hoisted(() => ({
	emitMock: vi.fn((..._args: unknown[]) => ({ diagnostics: [] }))
}));

// Mock TypeScript globally
vi.mock('typescript', async (importOriginal) => {
	const mod = await importOriginal<typeof import('typescript')>();
	return {
		...mod,
		createProgram: vi.fn(() => ({
			getCompilerOptions: () => ({}),
			getRootFileNames: () => [],
			getSourceFiles: () => [],
			emit: mocks.emitMock,
			getTypeChecker: () => ({ getExportsOfModule: () => [], getAmbientModules: () => [] })
		})),
		createIncrementalProgram: vi.fn(() => ({
			getCompilerOptions: () => ({}),
			getRootFileNames: () => [],
			emit: mocks.emitMock,
			getProgram: () => ({
				getRootFileNames: () => [],
				getSourceFiles: () => [],
				emit: mocks.emitMock,
				getTypeChecker: () => ({ getExportsOfModule: () => [], getAmbientModules: () => [] })
			})
		})),
		sys: mod.sys
	};
});

// Mock Logger globally
vi.mock('../src/logger', () => ({
	Logger: {
		info: vi.fn(),
		error: vi.fn(),
		log: vi.fn(),
		clear: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		header: vi.fn(),
		separator: vi.fn(),
		step: vi.fn(),
		EntryType: { Info: 'info', Success: 'success', Done: 'done', Error: 'error', Warn: 'warn' }
	}
}));

// Mock ProcessManager globally
vi.mock('../src/process-manager', () => ({
	processManager: { addCloseable: vi.fn(), close: vi.fn() }
}));

// Mock bundleDeclarations globally
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
	});

	const createProject = (directory: string, options: TypeScriptOptions = {}): InstanceType<typeof TypeScriptProject> => {
		const resolvedOptions: TypeScriptOptions = {
			...options,
			tsbuild: {
				...(options.tsbuild as Record<string, unknown>),
				plugins: [TestHelper.createEsbuildPlugin(), ...((options.tsbuild as Record<string, unknown>)?.plugins as [] || [])]
			}
		};
		return new TypeScriptProject(directory, resolvedOptions);
	};

	describe('constructor', () => {
		it('should create project with TypeScriptOptions', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});

			const project = createProject(projectPath);

			expect(project).toBeDefined();
			expect(typeof project.build).toBe('function');
		});
	});

	describe('clean', () => {
		it('should remove output directory contents when clean is called', async () => {
			const projectPath = await TestHelper.createTestProject({
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
		it('should skip transpile when noEmit is true', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { noEmit: true } }
			});
			const project = createProject(projectPath);

			await project.build();

			expect(esbuildMocks.buildMock).not.toHaveBeenCalled();
			expect(bundleDeclarations).not.toHaveBeenCalled();
			expect(mocks.emitMock).toHaveBeenCalled();
		});

		it('should set exit code 1 and log errors when type checking fails', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);
			const loggerErrorSpy = vi.spyOn(Logger, 'error');

			const mockFile = { fileName: 'test.ts', text: 'const x: string = 123;', getLineAndCharacterOfPosition: () => ({ line: 0, character: 6 }) };
			mocks.emitMock.mockReturnValueOnce({
				diagnostics: [{
					file: mockFile,
					messageText: 'Type number is not assignable to type string',
					start: 6, length: 1, category: 1, code: 2322
				} as import('typescript').Diagnostic]
			});

			// build() no longer throws for expected build failures - it sets exit code instead
			await project.build();
			expect(process.exitCode).toBe(1);
			expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 error in test.ts:1'));

			loggerErrorSpy.mockRestore();
			process.exitCode = undefined;
		});

		it('should output tsc-style summary for multiple errors in same file', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);
			const loggerErrorSpy = vi.spyOn(Logger, 'error');

			const mockFile = { fileName: 'test.ts', text: 'const x: string = 123;', getLineAndCharacterOfPosition: () => ({ line: 0, character: 6 }) };
			mocks.emitMock.mockReturnValueOnce({
				diagnostics: [
					{ file: mockFile, messageText: 'Error 1', start: 0, length: 1, category: 1, code: 2322 } as import('typescript').Diagnostic,
					{ file: mockFile, messageText: 'Error 2', start: 10, length: 1, category: 1, code: 2322 } as import('typescript').Diagnostic
				]
			});

			// build() no longer throws for expected build failures - it sets exit code instead
			await project.build();
			expect(process.exitCode).toBe(1);
			expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 errors in the same file, starting at: test.ts:1'));

			loggerErrorSpy.mockRestore();
			process.exitCode = undefined;
		});

		it('should output tsc-style summary for multiple errors in multiple files', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);
			const loggerErrorSpy = vi.spyOn(Logger, 'error');

			const mockFileA = { fileName: 'a.ts', text: 'const x: string = 123;', getLineAndCharacterOfPosition: () => ({ line: 0, character: 6 }) };
			const mockFileB = { fileName: 'b.ts', text: 'const y: number = "x";', getLineAndCharacterOfPosition: () => ({ line: 2, character: 6 }) };
			mocks.emitMock.mockReturnValueOnce({
				diagnostics: [
					{ file: mockFileA, messageText: 'Error 1', start: 0, length: 1, category: 1, code: 2322 } as import('typescript').Diagnostic,
					{ file: mockFileB, messageText: 'Error 2', start: 10, length: 1, category: 1, code: 2322 } as import('typescript').Diagnostic
				]
			});

			// build() no longer throws for expected build failures - it sets exit code instead
			await project.build();
			expect(process.exitCode).toBe(1);
			expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 errors in 2 files.'));
			expect(loggerErrorSpy).toHaveBeenCalledWith('Errors  Files');
			expect(loggerErrorSpy).toHaveBeenCalledWith('     1  a.ts:1');
			expect(loggerErrorSpy).toHaveBeenCalledWith('     1  b.ts:3');

			loggerErrorSpy.mockRestore();
			process.exitCode = undefined;
		});

		it('should call transpile when declaration is false', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: false } }
			});
			const project = createProject(projectPath);

			await project.build();

			expect(esbuildMocks.buildMock).toHaveBeenCalled();
			expect(bundleDeclarations).not.toHaveBeenCalled();
		});

		it('should process declarations when declaration is true', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { declaration: true, incremental: false } }
			});
			const project = createProject(projectPath);

			await project.build();

			expect(bundleDeclarations).toHaveBeenCalled();
		});

		describe('incremental builds', () => {
			it('should skip build when incremental with declarations and no .tsbuildinfo change', async () => {
				const projectPath = await TestHelper.createTestProject({
					tsconfig: { compilerOptions: { declaration: true, incremental: true } }
				});
				const project = createProject(projectPath);

				// Mock emit to NOT write any files (simulating no changes)
				mocks.emitMock.mockImplementationOnce(() => ({ diagnostics: [] }));

				await project.build();

				expect(bundleDeclarations).not.toHaveBeenCalled();
				expect(esbuildMocks.buildMock).not.toHaveBeenCalled();
			});

			it('should skip build when incremental without declarations and no .tsbuildinfo change', async () => {
				const projectPath = await TestHelper.createTestProject({
					tsconfig: { compilerOptions: { declaration: false, incremental: true } }
				});
				const project = createProject(projectPath);

				// Mock emit to NOT write any files (simulating no changes)
				mocks.emitMock.mockImplementationOnce(() => ({ diagnostics: [] }));

				await project.build();

				expect(esbuildMocks.buildMock).not.toHaveBeenCalled();
			});

			it('should run build when incremental with declarations and .tsbuildinfo changes', async () => {
				const projectPath = await TestHelper.createTestProject({
					tsconfig: { compilerOptions: { declaration: true, incremental: true } }
				});
				const project = createProject(projectPath);

				// Mock emit to write files (simulating changes)
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

			it('should run build when incremental without declarations and .tsbuildinfo changes', async () => {
				const projectPath = await TestHelper.createTestProject({
					tsconfig: { compilerOptions: { declaration: false, incremental: true } }
				});
				const project = createProject(projectPath);

				// Mock emit to write .tsbuildinfo (simulating changes)
				mocks.emitMock.mockImplementationOnce((_target: unknown, writeFile: unknown) => {
					if (writeFile) (writeFile as Function)('tsconfig.tsbuildinfo', '{}', false, undefined, []);
					return { diagnostics: [] };
				});

				await project.build();

				expect(esbuildMocks.buildMock).toHaveBeenCalled();
			});

			it('should only type-check when incremental with noEmit', async () => {
				const projectPath = await TestHelper.createTestProject({
					tsconfig: { compilerOptions: { declaration: true, incremental: true, noEmit: true } }
				});
				const project = createProject(projectPath);

				await project.build();

				// emit should be called for type-checking and .tsbuildinfo
				expect(mocks.emitMock).toHaveBeenCalled();
				// But no transpile or processDeclarations
				expect(bundleDeclarations).not.toHaveBeenCalled();
				expect(esbuildMocks.buildMock).not.toHaveBeenCalled();
			});
		});
	});

	describe('transpile', () => {
		it('should inject environment variables into output', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: { compilerOptions: { outDir: 'dist' } }
			});
			const project = createProject(projectPath, {
				tsbuild: { env: { 'API_URL': 'https://api.example.com' } }
			});

			vol.writeFileSync(join(projectPath, 'src/index.ts'), 'export const url = import.meta.env.API_URL;');
			await project.transpile();

			const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
			expect(output).toContain('"https://api.example.com"');
		});
	});
});
