import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from 'typescript';
import { API, DiagnosticCategory, ModuleKind, ModuleResolutionKind } from 'typescript/sync';
import { toRootedDirectoryPath, toRootedFilePath } from 'typescript/path';
import { CompilationContext } from '../../src/project/compilation-context';
import { Paths } from '../../src/paths';
import type { CompilationContextOptions } from '../../src/project/compilation-context';
import type { Diagnostic, Snapshot } from 'typescript/sync';
import type { MockInstance } from 'vitest';

/**
 * Returns the parameters of the first recorded snapshot update.
 * @param spy - Spy on `Snapshot.update`
 * @returns The update parameters
 */
const updateParams = (spy: MockInstance): Parameters<Snapshot['update']>[0] => spy.mock.calls[0]![0] as Parameters<Snapshot['update']>[0];

let directory: ReturnType<typeof Paths.absolute>;
let entryPath: ReturnType<typeof Paths.absolute>;
let dependencyPath: ReturnType<typeof Paths.absolute>;
let api: API;
let contexts: CompilationContext[];

function createContext(overrides: Partial<CompilationContextOptions> = {}): CompilationContext {
	const options: CompilationContextOptions = {
		api,
		directory,
		rootNames: [ entryPath ],
		compilerOptions: {
			module: ModuleKind.ESNext,
			moduleResolution: ModuleResolutionKind.Bundler,
			types: [],
			declaration: true,
			incremental: true,
			rootDir: toRootedDirectoryPath(join(directory, 'src'), undefined),
			outDir: toRootedDirectoryPath(join(directory, 'dist'), undefined)
		},
		...overrides
	};
	options.compilerOptions = { configFilePath: toRootedFilePath(join(directory, 'tsconfig.json'), undefined), ...options.compilerOptions };
	const context = new CompilationContext(options);
	contexts.push(context);
	return context;
}

beforeEach(async () => {
	directory = Paths.absolute(await mkdtemp(join(tmpdir(), 'tsbuild-compilation-')));
	entryPath = Paths.absolute(join(directory, 'src/index.ts'));
	dependencyPath = Paths.absolute(join(directory, 'src/value.ts'));
	await mkdir(join(directory, 'src'));
	await writeFile(entryPath, 'import { value } from "./value"; export const result: number = value;');
	await writeFile(dependencyPath, 'export const value = 1;');
	api = new API({ cwd: directory });
	contexts = [];
	// Native methods are lazy getters; materialize them before Vitest inspects descriptors.
	void api.createSnapshot;
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const context of contexts) { context[Symbol.dispose]() }
	api[Symbol.dispose]();
	await rm(directory, { recursive: true, force: true });
});

describe('CompilationContext', () => {
	it('creates its generation lazily, returns detached roots and keys only compiler inputs', async () => {
		const createSnapshot = vi.spyOn(api, 'createSnapshot');
		const context = createContext();
		const key = context.manifestKey;
		expect(JSON.parse(key)).toEqual({
			rootNames: [ entryPath ],
			compilerOptions: expect.objectContaining({ declaration: true, incremental: true }),
			version
		});
		context.rootNames.push(dependencyPath);
		expect(context.rootNames).toEqual([ entryPath ]);
		expect(context.sourceText(entryPath)).toBeUndefined();
		expect(context.dependencies.size).toBe(0);
		context.notify('change', dependencyPath);
		context.rebuild([ entryPath, dependencyPath ]);
		expect(context.manifestKey).not.toBe(key);
		expect(createSnapshot).not.toHaveBeenCalled();
		await writeFile(dependencyPath, 'export const value = 2;');
		const changedKey = context.manifestKey;
		expect(context.compile().diagnostics).toEqual([]);
		expect(context.sourceText(dependencyPath)).toBe('export const value = 2;');
		expect(context.manifestKey).toBe(changedKey);
		context.compile();
		expect(createSnapshot).toHaveBeenCalledTimes(1);
	});

	it('emits detached declarations and an incremental manifest with input stat signatures', async () => {
		const before = new Date(Date.now() - 10_000);
		await utimes(entryPath, before, before);
		const context = createContext();
		const batch = vi.spyOn(api, 'batch');
		const result = context.compile();
		expect(result.diagnostics).toEqual([]);
		expect(batch).toHaveBeenCalledTimes(1);
		expect(result.declarations.get(Paths.absolute(join(directory, 'dist/index.d.ts')))).toContain('export declare const result: number;');
		expect(result.declarations.get(Paths.absolute(join(directory, 'dist/value.d.ts')))).toContain('value = 1');
		expect(result.manifest?.key).toBe(context.manifestKey);
		expect(result.manifest?.files).toContainEqual([ entryPath, (await stat(entryPath)).mtimeMs, (await stat(entryPath)).size ]);
		expect(result.manifest!.files.length).toBeGreaterThan(2);
		const dependencies = context.dependencies;
		expect(dependencies).toEqual(new Set([ 'src/value.ts', 'src/index.ts' ]));
		expect(context.dependencies).toBe(dependencies);
		expect(context.sourceText(Paths.absolute(join(directory, 'missing.ts')))).toBeUndefined();
		context.clear();
		expect(result.declarations.size).toBe(2);
		expect(result.manifest?.files.length).toBeGreaterThan(2);
	});

	it('returns semantic errors and does not create a manifest', async () => {
		await writeFile(dependencyPath, 'export const value = "wrong";');
		const result = createContext().compile();
		expect(result.diagnostics).toEqual(expect.arrayContaining([ expect.objectContaining({ code: 2322 }) ]));
		expect(result.manifest).toBeUndefined();
	});

	it('prepends configuration parsing diagnostics to compiler diagnostics', async () => {
		await writeFile(dependencyPath, 'export const value = "wrong";');
		const diagnostic: Diagnostic = { category: DiagnosticCategory.Error, code: 9000, text: 'Invalid configuration', pos: -1, end: -1 };
		const result = createContext({ configFileParsingDiagnostics: [ diagnostic ] }).compile();
		expect(result.diagnostics[0]).toBe(diagnostic);
		expect(result.diagnostics.slice(1)).toEqual(expect.arrayContaining([ expect.objectContaining({ code: 2322 }) ]));
		expect(result.manifest).toBeUndefined();
	});

	it.each([ true, false ])('checks without emitting declarations under noEmit (declaration: %s)', (declaration) => {
		const context = createContext({ compilerOptions: { module: ModuleKind.ESNext, types: [], declaration, noEmit: true, incremental: true } });
		const result = context.compile();
		expect(result.diagnostics).toEqual([]);
		expect(result.declarations.size).toBe(0);
		expect(result.manifest?.key).toBe(context.manifestKey);
	});

	it('returns declaration diagnostics under noEmit', async () => {
		await writeFile(entryPath, 'class Hidden { private value = 1; } export const value = new Hidden();');
		const result = createContext({ compilerOptions: { declaration: true, noEmit: true, isolatedDeclarations: true, types: [] } }).compile();
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(result.declarations.size).toBe(0);
		expect(result.manifest).toBeUndefined();
	});

	it('omits the manifest when incremental compilation is disabled', () => {
		const result = createContext({ compilerOptions: { types: [], declaration: false, incremental: false } }).compile();
		expect(result.diagnostics).toEqual([]);
		expect(result.declarations.size).toBe(0);
		expect(result.manifest).toBeUndefined();
	});

	it('filters declaration maps out of emitted declarations', () => {
		const result = createContext({ compilerOptions: { types: [], declaration: true, declarationMap: true } }).compile();
		expect(result.diagnostics).toEqual([]);
		expect(result.declarations.size).toBe(2);
		expect([ ...result.declarations.keys() ].every(path => path.endsWith('.d.ts'))).toBe(true);
	});

	it('keeps pending changes out of sourceText until rebuild and releases the previous snapshot', async () => {
		const createSnapshot = vi.spyOn(api, 'createSnapshot');
		const context = createContext();
		context.compile();
		const snapshot = createSnapshot.mock.results[0]!.value;
		void snapshot.dispose;
		void snapshot.update;
		const dispose = vi.spyOn(snapshot, 'dispose');
		const update = vi.spyOn(snapshot, 'update');
		const dependencies = context.dependencies;
		await writeFile(dependencyPath, 'export const value = 2;');
		context.notify('change', dependencyPath);
		expect(context.sourceText(dependencyPath)).toBe('export const value = 1;');
		context.rebuild(context.rootNames);
		expect(updateParams(update).reconfigurePrograms).toBeUndefined();
		expect(updateParams(update).fileNotifications).toEqual({ changed: [ dependencyPath ], created: [], deleted: [] });
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(context.sourceText(dependencyPath)).toBe('export const value = 2;');
		expect(context.compile().diagnostics).toEqual([]);
		expect(context.dependencies).not.toBe(dependencies);
		const nextSnapshot = update.mock.results[0]!.value;
		void nextSnapshot.update;
		const nextUpdate = vi.spyOn(nextSnapshot, 'update');
		context.rebuild(context.rootNames);
		expect(updateParams(nextUpdate).fileNotifications).toEqual({ changed: [], created: [], deleted: [] });
		expect(updateParams(nextUpdate).reconfigurePrograms).toBeUndefined();
		expect(createSnapshot).toHaveBeenCalledTimes(1);
	});

	it.each([ 'add', 'addDir' ] as const)('loads newly created sources after %s notifications', async (event) => {
		await rm(dependencyPath);
		const context = createContext();
		expect(context.compile().diagnostics.length).toBeGreaterThan(0);
		await writeFile(dependencyPath, 'export const value = 3;');
		context.notify(event, dependencyPath);
		context.rebuild(context.rootNames);
		expect(context.sourceText(dependencyPath)).toBe('export const value = 3;');
		expect(context.compile().diagnostics).toEqual([]);
	});

	it.each([ 'unlink', 'unlinkDir', 'rename', 'renameDir' ] as const)('removes sources after %s notifications without a destination', async (event) => {
		const context = createContext();
		context.compile();
		await rm(dependencyPath);
		context.notify(event, dependencyPath);
		context.rebuild(context.rootNames);
		expect(context.sourceText(dependencyPath)).toBeUndefined();
		expect(context.compile().diagnostics).toEqual(expect.arrayContaining([ expect.objectContaining({ code: 2307 }) ]));
	});

	it.each([ 'rename', 'renameDir' ] as const)('loads the destination of %s notifications', async (event) => {
		const context = createContext();
		context.compile();
		const nextPath = Paths.absolute(join(directory, 'src/renamed.ts'));
		await rename(dependencyPath, nextPath);
		await writeFile(entryPath, 'export { value } from "./renamed";');
		context.notify(event, dependencyPath, nextPath);
		context.notify('change', entryPath);
		context.rebuild(context.rootNames);
		expect(context.sourceText(dependencyPath)).toBeUndefined();
		expect(context.sourceText(nextPath)).toBe('export const value = 1;');
		expect(context.compile().diagnostics).toEqual([]);
	});

	it.each([ 'length', 'order' ])('reconfigures the program when root-name %s changes', (change) => {
		const createSnapshot = vi.spyOn(api, 'createSnapshot');
		const context = createContext({ rootNames: [ entryPath, dependencyPath ], projectReferences: [] });
		context.compile();
		const snapshot = createSnapshot.mock.results[0]!.value;
		void snapshot.dispose;
		void snapshot.update;
		const update = vi.spyOn(snapshot, 'update');
		const roots = change === 'length' ? [ dependencyPath ] : [ dependencyPath, entryPath ];
		context.rebuild(roots);
		expect(updateParams(update).reconfigurePrograms).toEqual([ expect.objectContaining({ rootFiles: roots, options: { projectReferences: [] } }) ]);
		expect(context.rootNames).toEqual(roots);
		expect(context.compile().diagnostics).toEqual([]);
		if (change === 'length') { expect(context.sourceText(entryPath)).toBeUndefined() }

		const nextSnapshot = update.mock.results[0]!.value;
		void nextSnapshot.update;
		const nextUpdate = vi.spyOn(nextSnapshot, 'update');
		context.rebuild([ ...roots ]);
		expect(updateParams(nextUpdate).reconfigurePrograms).toBeUndefined();
	});

	it('restores only in-project non-declaration dependencies without creating a generation', () => {
		const createSnapshot = vi.spyOn(api, 'createSnapshot');
		const context = createContext();
		const empty = context.dependencies;
		context.restore({ key: context.manifestKey, files: [
			[ entryPath, 0, 1 ], [ dependencyPath, 0, 1 ],
			[ join(directory, 'globals.d.ts'), 0, 1 ],
			[ directory + '-other/outside.ts', 0, 1 ]
		] });
		expect(context.dependencies).toEqual(new Set([ 'src/index.ts', 'src/value.ts' ]));
		expect(context.dependencies).not.toBe(empty);
		expect(context.sourceText(entryPath)).toBeUndefined();
		expect(createSnapshot).not.toHaveBeenCalled();
		context.restore({ key: context.manifestKey, files: [] });
		expect(context.dependencies.size).toBe(0);
	});

	it.each([ 'clear', 'dispose' ])('releases the generation, dependencies and pending state with %s', async (method) => {
		const createSnapshot = vi.spyOn(api, 'createSnapshot');
		const context = createContext();
		context.compile();
		const snapshot = createSnapshot.mock.results[0]!.value;
		void snapshot.dispose;
		void snapshot.update;
		const dispose = vi.spyOn(snapshot, 'dispose');
		context.notify('unlink', entryPath);
		if (method === 'clear') { context.clear() } else { context[Symbol.dispose]() }
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(context.sourceText(entryPath)).toBeUndefined();
		expect(context.dependencies.size).toBe(0);
		context.clear();
		expect(dispose).toHaveBeenCalledTimes(1);
		await writeFile(dependencyPath, 'export const value = 9;');
		expect(context.compile().diagnostics).toEqual([]);
		expect(context.sourceText(dependencyPath)).toBe('export const value = 9;');
		expect(createSnapshot).toHaveBeenCalledTimes(2);
	});

	it('marks inputs modified at or after compilation start as unverifiable', async () => {
		const startedAt = Date.now() + 10_000;
		await utimes(entryPath, new Date(startedAt), new Date(startedAt));
		await utimes(dependencyPath, new Date(startedAt + 1_000), new Date(startedAt + 1_000));
		vi.spyOn(Date, 'now').mockReturnValue(startedAt);
		const result = createContext().compile();
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest?.files).toContainEqual([ entryPath, -1, (await stat(entryPath)).size ]);
		expect(result.manifest?.files).toContainEqual([ dependencyPath, -1, (await stat(dependencyPath)).size ]);
	});

	it('omits inputs that disappeared from disk after the program read them', async () => {
		const context = createContext();
		context.compile();
		await rm(dependencyPath);
		const result = context.compile();
		expect(result.diagnostics).toEqual([]);
		expect(result.manifest?.files.some(([ path ]) => path === dependencyPath)).toBe(false);
	});

	it('disposes both snapshots and reports a missing program from the native boundary', () => {
		const createSnapshot = vi.spyOn(api, 'createSnapshot');
		const context = createContext();
		context.compile();
		const snapshot = createSnapshot.mock.results[0]!.value;
		void snapshot.dispose;
		void snapshot.update;
		const update = snapshot.update;
		const disposePrevious = vi.spyOn(snapshot, 'dispose');
		let disposeNext: ReturnType<typeof vi.spyOn> | undefined;
		vi.spyOn(snapshot, 'update').mockImplementation((params) => {
			const next = update(params);
			void next.getProgram;
			void next.dispose;
			vi.spyOn(next, 'getProgram').mockReturnValue(undefined);
			disposeNext = vi.spyOn(next, 'dispose');
			return next;
		});
		expect(() => context.rebuild(context.rootNames)).toThrow(/TypeScript program .* is missing from the updated snapshot/);
		expect(disposePrevious).toHaveBeenCalledTimes(1);
		expect(disposeNext).toHaveBeenCalledTimes(1);
		expect(context.sourceText(entryPath)).toBeUndefined();
		expect(context.compile().diagnostics).toEqual([]);
	});

	it('drops the released generation and recovers with a fresh snapshot when a snapshot update fails', async () => {
		const createSnapshot = vi.spyOn(api, 'createSnapshot');
		const context = createContext();
		context.compile();
		const snapshot = createSnapshot.mock.results[0]!.value;
		void snapshot.update;
		vi.spyOn(snapshot, 'update').mockImplementation(() => { throw new Error('update failed') });
		await writeFile(dependencyPath, 'export const value = "text";');
		context.notify('change', dependencyPath);

		expect(() => context.rebuild(context.rootNames)).toThrow('update failed');
		expect(snapshot.isDisposed()).toBe(true);
		expect(context.sourceText(entryPath)).toBeUndefined();
		// The next build must not touch the released snapshot; it starts a fresh one that reads current file contents
		expect(() => context.rebuild(context.rootNames)).not.toThrow();
		expect(context.compile().diagnostics.map(({ code }) => code)).toEqual([ 2322 ]);
		expect(createSnapshot).toHaveBeenCalledTimes(2);
	});
});
