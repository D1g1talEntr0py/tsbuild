import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fs, vol } from 'memfs';
import { performance } from 'node:perf_hooks';
import { createEmitAndSemanticDiagnosticsBuilderProgram, createIncrementalCompilerHost, createIncrementalProgram, DiagnosticCategory, ModuleKind, ModuleResolutionKind, ScriptTarget, sys } from 'typescript';
import { CompilationContext } from '../../src/project/compilation-context';
import { Paths } from '../../src/paths';
import type { CompilationContextOptions } from '../../src/project/compilation-context';
import type { Diagnostic, EmitAndSemanticDiagnosticsBuilderProgram, WriteFileCallback } from 'typescript';

vi.mock('typescript', async (importOriginal) => {
	const actual = await importOriginal<typeof import('typescript')>();
	return {
		...actual,
		createIncrementalCompilerHost: vi.fn(actual.createIncrementalCompilerHost),
		createIncrementalProgram: vi.fn(actual.createIncrementalProgram),
		createEmitAndSemanticDiagnosticsBuilderProgram: vi.fn(actual.createEmitAndSemanticDiagnosticsBuilderProgram)
	};
});

const directory = Paths.absolute('/project');
const entryPath = Paths.absolute('/project/src/index.ts');
const dependencyPath = Paths.absolute('/project/src/value.ts');
const globalsPath = Paths.absolute('/project/globals.d.ts');

function sessionOptions(overrides: Partial<CompilationContextOptions> = {}): CompilationContextOptions {
	return {
		directory,
		rootNames: [ entryPath, globalsPath ],
		compilerOptions: { target: ScriptTarget.ESNext, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler, noLib: true, types: [], declaration: true, outDir: '/project/dist', incremental: true, tsBuildInfoFile: '/project/cache.tsbuildinfo' },
		watch: true,
		...overrides
	};
}

function initialBuilder(): EmitAndSemanticDiagnosticsBuilderProgram {
	return vi.mocked(createIncrementalProgram).mock.results[0]!.value as EmitAndSemanticDiagnosticsBuilderProgram;
}

beforeEach(() => {
	vi.clearAllMocks();
	vol.fromJSON({
		[entryPath]: 'import { value } from "./value"; export const result: number = value;',
		[dependencyPath]: 'export const value = 1;',
		[globalsPath]: 'interface Object {} interface Function {} interface CallableFunction {} interface NewableFunction {} interface IArguments {} interface String {} interface Number {} interface Boolean {} interface RegExp {} interface Array<T> { length: number; [index: number]: T; }'
	});
	vi.spyOn(sys, 'getCurrentDirectory').mockReturnValue(directory);
	vi.spyOn(sys, 'readFile').mockImplementation((path) => {
		try { return fs.readFileSync(path, 'utf8') as string } catch { return undefined }
	});
	vi.spyOn(sys, 'fileExists').mockImplementation((path) => {
		try { return fs.statSync(path).isFile() } catch { return false }
	});
	vi.spyOn(sys, 'directoryExists').mockImplementation((path) => {
		try { return fs.statSync(path).isDirectory() } catch { return false }
	});
	vi.spyOn(sys, 'getDirectories').mockReturnValue([]);
	vi.spyOn(sys, 'readDirectory').mockReturnValue([]);
	vi.spyOn(sys, 'realpath').mockImplementation((path) => path);
});

afterEach(() => {
	vi.restoreAllMocks();
	performance.clearMarks('diagnostics:start');
	vol.reset();
});

describe('CompilationContext', () => {
	it.each([ false, true ])('preserves compiler inputs and applies only watch overrides (watch: %s)', (watch) => {
		const options = sessionOptions({ watch, configFileParsingDiagnostics: [], projectReferences: [] });
		const context = new CompilationContext(options);
		const initial = vi.mocked(createIncrementalProgram).mock.calls[0]![0];
		expect(initial.rootNames).toBe(options.rootNames);
		expect(initial.configFileParsingDiagnostics).toBe(options.configFileParsingDiagnostics);
		expect(initial.projectReferences).toBe(options.projectReferences);
		expect(initial.options).toEqual(watch ? { ...options.compilerOptions, incremental: false, tsBuildInfoFile: undefined } : options.compilerOptions);
		expect(initial.options === options.compilerOptions).toBe(!watch);
		expect(options.compilerOptions.incremental).toBe(true);
		expect(options.compilerOptions.tsBuildInfoFile).toBe('/project/cache.tsbuildinfo');
		expect(createIncrementalCompilerHost).toHaveBeenCalledExactlyOnceWith(initial.options);
		expect(createEmitAndSemanticDiagnosticsBuilderProgram).not.toHaveBeenCalled();
		context.rebuild(context.rootNames);
		expect(createEmitAndSemanticDiagnosticsBuilderProgram).toHaveBeenCalledExactlyOnceWith(context.rootNames, initial.options, initial.host, initialBuilder(), options.configFileParsingDiagnostics, options.projectReferences);
	});

	it('reuses unchanged sources and the exact prior builder while replacing invalidated sources', () => {
		const context = new CompilationContext(sessionOptions());
		const originalBuilder = initialBuilder();
		const originalEntry = originalBuilder.getProgram().getSourceFile(entryPath);
		const originalDependency = originalBuilder.getProgram().getSourceFile(dependencyPath);
		const originalGlobals = originalBuilder.getProgram().getSourceFile(globalsPath);
		expect(context.collectDiagnostics(vi.fn())).toEqual([]);
		vol.writeFileSync(dependencyPath, 'export const value = 2;');
		context.invalidateSource(dependencyPath);
		expect(context.sourceText(dependencyPath)).toBe('export const value = 1;');
		context.rebuild(context.rootNames);
		const nextBuilder = vi.mocked(createEmitAndSemanticDiagnosticsBuilderProgram).mock.results[0]!.value as EmitAndSemanticDiagnosticsBuilderProgram;
		expect(vi.mocked(createEmitAndSemanticDiagnosticsBuilderProgram).mock.calls[0]![3]).toBe(originalBuilder);
		expect(nextBuilder.getProgram().getSourceFile(entryPath)).toBe(originalEntry);
		expect(nextBuilder.getProgram().getSourceFile(globalsPath)).toBe(originalGlobals);
		expect(nextBuilder.getProgram().getSourceFile(dependencyPath)).not.toBe(originalDependency);
		expect(context.sourceText(dependencyPath)).toBe('export const value = 2;');
		expect(context.collectDiagnostics(vi.fn())).toEqual([]);
		context.rebuild(context.rootNames);
		expect(vi.mocked(createEmitAndSemanticDiagnosticsBuilderProgram).mock.calls[1]![3]).toBe(nextBuilder);
		expect(createIncrementalProgram).toHaveBeenCalledTimes(1);
		expect(createIncrementalCompilerHost).toHaveBeenCalledTimes(1);
	});

	it('preserves cache hits, forced source creation, missing files, and explicit cache clearing', () => {
		const context = new CompilationContext(sessionOptions());
		const host = vi.mocked(createIncrementalProgram).mock.calls[0]![0].host!;
		const original = host.getSourceFile(entryPath, ScriptTarget.ESNext)!;
		const reads = vi.mocked(sys.readFile).mock.calls.length;
		expect(host.getSourceFile(entryPath, ScriptTarget.ESNext)).toBe(original);
		expect(vi.mocked(sys.readFile).mock.calls).toHaveLength(reads);
		const forced = host.getSourceFile(entryPath, ScriptTarget.ESNext, undefined, true);
		expect(forced).toBeDefined();
		expect(forced).not.toBe(original);
		expect(host.getSourceFile(entryPath, ScriptTarget.ESNext)).toBe(forced);
		const missingPath = Paths.absolute('/project/src/missing.ts');
		expect(host.getSourceFile(missingPath, ScriptTarget.ESNext)).toBeUndefined();
		expect(context.sourceText(missingPath)).toBeUndefined();
		vol.writeFileSync(missingPath, 'export const found = true;');
		expect(host.getSourceFile(missingPath, ScriptTarget.ESNext)?.text).toContain('found');
		const dependencies = context.dependencies;
		context.clear();
		expect(host.getSourceFile(entryPath, ScriptTarget.ESNext)).not.toBe(forced);
		expect(context.dependencies).toEqual(dependencies);
		expect(context.dependencies).not.toBe(dependencies);
	});

	it('returns detached roots and caches dependency snapshots by Program identity', () => {
		vol.fromJSON({ '/project-other/outside.ts': 'export const outside = 1;' });
		const context = new CompilationContext(sessionOptions({ rootNames: [ entryPath, globalsPath, '/project-other/outside.ts' ] }));
		const getSourceFiles = vi.spyOn(initialBuilder().getProgram(), 'getSourceFiles');
		const dependencies = context.dependencies;
		expect([ ...dependencies ]).toEqual([ 'src/value.ts', 'src/index.ts' ]);
		expect(context.dependencies).toBe(dependencies);
		expect(getSourceFiles).toHaveBeenCalledTimes(1);
		const roots = context.rootNames;
		roots.splice(0, 1);
		expect(context.rootNames).toContain(entryPath);
		const renamedPath = Paths.absolute('/project/src/renamed.ts');
		vol.renameSync(entryPath, renamedPath);
		context.invalidateSource(entryPath);
		context.invalidateSource(renamedPath);
		context.rebuild([ renamedPath, ...roots ]);
		expect(context.rootNames).toEqual([ renamedPath, ...roots ]);
		expect(context.sourceText(entryPath)).toBeUndefined();
		expect([ ...context.dependencies ]).toEqual([ 'src/value.ts', 'src/renamed.ts' ]);
		expect([ ...dependencies ]).toEqual([ 'src/value.ts', 'src/index.ts' ]);
	});

	it.each([ false, true ])('collects noEmit diagnostics in order before emit (declaration: %s)', (declaration) => {
		vol.writeFileSync(entryPath, 'export const result: number = "invalid";');
		const parsingDiagnostic: Diagnostic = { category: DiagnosticCategory.Error, code: 9001, messageText: 'configuration error', file: undefined, start: undefined, length: undefined };
		const options = sessionOptions({ watch: false, configFileParsingDiagnostics: [ parsingDiagnostic ] });
		options.compilerOptions = { ...options.compilerOptions, noEmit: true, declaration };
		const context = new CompilationContext(options);
		const builder = initialBuilder();
		const diagnosticMethods = [ 'getConfigFileParsingDiagnostics', 'getOptionsDiagnostics', 'getSyntacticDiagnostics', 'getGlobalDiagnostics', 'getSemanticDiagnostics', 'getDeclarationDiagnostics' ] as const;
		const spies = diagnosticMethods.map((method) => vi.spyOn(builder, method));
		const emit = vi.spyOn(builder, 'emit');
		const mark = vi.spyOn(performance, 'mark');
		const writer = vi.fn<WriteFileCallback>();
		const diagnostics = context.collectDiagnostics(writer);
		const calledSpies = declaration ? spies : spies.slice(0, -1);
		const callOrder = [ mark.mock.invocationCallOrder[0], ...calledSpies.map((spy) => spy.mock.invocationCallOrder[0]), emit.mock.invocationCallOrder[0] ];
		expect(callOrder.every((order) => order !== undefined)).toBe(true);
		expect(callOrder).toEqual([ ...callOrder ].sort((left, right) => left! - right!));
		expect(mark).toHaveBeenCalledWith('diagnostics:start');
		expect(diagnostics).toEqual(calledSpies.flatMap((spy) => spy.mock.results[0]!.value));
		expect(diagnostics).toContain(parsingDiagnostic);
		expect(diagnostics.some(({ code }) => code === 2322)).toBe(true);
		if (!declaration) { expect(spies[5]).not.toHaveBeenCalled() }
		expect(emit).toHaveBeenCalledExactlyOnceWith(undefined, writer, undefined, true);
		expect(writer.mock.calls.map(([ path ]) => path)).toEqual([ '/project/cache.tsbuildinfo' ]);
		const buildInfo: unknown = JSON.parse(writer.mock.calls[0]![1]);
		expect(buildInfo).toHaveProperty('semanticDiagnosticsPerFile');
	});

	it('emits before semantic checking and preserves both semantic and declaration errors', () => {
		vol.writeFileSync(entryPath, 'import { missing } from "./missing"; export const value: number = "invalid"; export const hidden = new class { private secret = 1; }();');
		const context = new CompilationContext(sessionOptions());
		const builder = initialBuilder();
		const emit = vi.spyOn(builder, 'emit');
		const semantic = vi.spyOn(builder, 'getSemanticDiagnostics');
		const mark = vi.spyOn(performance, 'mark');
		const writer = vi.fn<WriteFileCallback>();
		const diagnostics = context.collectDiagnostics(writer);
		expect(emit.mock.invocationCallOrder[0]).toBeLessThan(semantic.mock.invocationCallOrder[0]!);
		expect(emit).toHaveBeenCalledExactlyOnceWith(undefined, writer, undefined, true);
		expect(diagnostics).toEqual([ ...semantic.mock.results[0]!.value, ...emit.mock.results[0]!.value.diagnostics ]);
		expect(diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([ 2307, 2322, 4094 ]));
		expect(mark).not.toHaveBeenCalledWith('diagnostics:start');
	});

	it('passes declaration output to the caller and propagates writer failures unchanged', () => {
		const context = new CompilationContext(sessionOptions());
		const writer = vi.fn<WriteFileCallback>();
		expect(context.collectDiagnostics(writer)).toEqual([]);
		expect(writer.mock.calls.map(([ path ]) => path)).toEqual([ '/project/dist/value.d.ts', '/project/dist/index.d.ts' ]);
		const failure = new Error('writer failed');
		const failingContext = new CompilationContext(sessionOptions());
		expect(() => failingContext.collectDiagnostics(() => { throw failure })).toThrow(failure);
	});
});