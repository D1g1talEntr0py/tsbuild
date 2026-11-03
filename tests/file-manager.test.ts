import { vol } from 'memfs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDirOptions } from '../src/constants';
import { FileManager } from '../src/file-manager';
import { IncrementalBuildCache } from '../src/incremental-build-cache';
import { DeclarationProcessor } from '../src/dts/declaration-processor';
import { TestHelper } from './scripts/test-helper';
import type { MockInstance } from 'vitest';
import type { AbsolutePath, BuildInputManifest, CachedDeclaration } from '../src/@types';

vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});
vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

const tempDir = '/test' as AbsolutePath;
const declarationPath = '/test/types.d.ts' as AbsolutePath;
const oneDeclaration = (text: string): ReadonlyMap<AbsolutePath, string> => new Map([[declarationPath, text]]);

describe('FileManager', () => {
	beforeEach(async () => {
		await TestHelper.setupMemfs();
		vol.mkdirSync(tempDir, defaultDirOptions);
	});
	afterEach(() => { TestHelper.teardownMemfs() });

	describe('ingest and lifecycle', () => {
		it('constructs with and without a build cache', () => {
			expect(new FileManager(TestHelper.api).getDeclarationFiles().size).toBe(0);
			expect(new FileManager(TestHelper.api, new IncrementalBuildCache(tempDir)).getDeclarationFiles().size).toBe(0);
		});

		it('pre-processes declarations and finalizes uncached builds', async () => {
			const manager = new FileManager(TestHelper.api);
			await manager.initialize();
			expect(manager.finalize()).toBe(true);
			manager.ingest(oneDeclaration('export const hello: string;'));
			expect(manager.finalize()).toBe(true);
			const result = manager.getDeclarationFiles().get(declarationPath);
			expect(result?.code).toContain('declare const hello: string;');
			expect(result?.code).toContain('export { hello }');
		});

		it('reuses the prior preprocessing result when declaration text is unchanged', () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(oneDeclaration('export const value: string;'));
			const processed = manager.getDeclarationFiles().get(declarationPath);
			manager.ingest(oneDeclaration('export const value: string;'));
			expect(manager.getDeclarationFiles().get(declarationPath)).toBe(processed);
		});

		it('replaces the declaration set and drops removed paths', () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(new Map([
				[declarationPath, 'export const value: string;'],
				['/test/removed.d.ts' as AbsolutePath, 'export const removed: boolean;'],
			]));
			manager.ingest(oneDeclaration('export const value: number;'));
			expect(manager.getDeclarationFiles().size).toBe(1);
			expect(manager.getDeclarationFiles().get(declarationPath)?.code).toContain('number');
			manager.ingest(new Map());
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('does not store declarations that preprocess to empty content', () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(oneDeclaration(''));
			expect(manager.getDeclarationFiles().size).toBe(0);
			expect(manager.finalize()).toBe(true);
		});

		it('waits for a pending cache write during initialize', async () => {
			const manager = new FileManager(TestHelper.api, new IncrementalBuildCache(tempDir));
			manager.ingest(oneDeclaration('export const value: string;'));
			manager.persistCache('fingerprint');
			await manager.initialize();
			expect(manager.finalize()).toBe(false);
		});

		it('resets the emit flag on initialize without clearing declarations', async () => {
			const manager = new FileManager(TestHelper.api, new IncrementalBuildCache(tempDir));
			manager.ingest(oneDeclaration('export const value: string;'));
			await manager.initialize();
			expect(manager.finalize()).toBe(false);
			expect(manager.getDeclarationFiles().size).toBe(1);
		});

		it('restores cached declarations, and does not overwrite an already populated map', async () => {
			const source = new Map<string, CachedDeclaration>([[declarationPath, {
				code: 'declare const cached: string;', typeReferences: new Set<string>(), fileReferences: new Set<string>(),
			}]]);
			await new IncrementalBuildCache(tempDir).save(source, 'fingerprint');
			const manager = new FileManager(TestHelper.api, new IncrementalBuildCache(tempDir));
			await manager.restore();
			expect(manager.getDeclarationFiles().get(declarationPath)?.code).toBe('declare const cached: string;');
			manager.ingest(oneDeclaration('export const fresh: number;'));
			await manager.restore();
			expect(manager.getDeclarationFiles().size).toBe(1);
			expect(manager.getDeclarationFiles().get(declarationPath)?.code).toContain('fresh');
			await expect(new FileManager(TestHelper.api).restore()).resolves.toBeUndefined();
		});

		it('persists emitted declarations with their manifest', async () => {
			const cache = new IncrementalBuildCache(tempDir);
			const save = vi.spyOn(cache, 'save');
			const manager = new FileManager(TestHelper.api, cache);
			const manifest: BuildInputManifest = { key: 'input-key', files: [] };
			manager.ingest(oneDeclaration('export const value: string;'), manifest);
			manager.persistCache('fingerprint');
			await manager.flush();
			expect(save).toHaveBeenCalledWith(manager.getDeclarationFiles(), 'fingerprint', manifest);
		});

		it('saves configuration changes without compiler output, but otherwise skips cache writes', async () => {
			const cache = new IncrementalBuildCache(tempDir);
			const save = vi.spyOn(cache, 'save');
			const manager = new FileManager(TestHelper.api, cache);
			manager.persistCache('changed', true);
			await manager.flush();
			expect(save).toHaveBeenCalledWith(manager.getDeclarationFiles(), 'changed');
			const uncached = new FileManager(TestHelper.api);
			uncached.ingest(oneDeclaration('export const value: string;'));
			uncached.persistCache('unused');
			manager.persistCache('unchanged');
			await manager.flush();
			expect(save).toHaveBeenCalledTimes(1);
		});
	});

	describe('batched ingestion', () => {
		afterEach(() => { vi.restoreAllMocks() });

		const manyDeclarations = (count: number, suffix = '') => new Map(Array.from({ length: count }, (_, i): [AbsolutePath, string] => [ `/test/module-${i}.d.ts` as AbsolutePath, `import type { Shared } from './shared';\nexport declare const value${i}: Shared${suffix};` ]));
		const parseIndividually = (path: string, text: string) => {
			using retained = TestHelper.api.createSourceFile(path, text);
			return DeclarationProcessor.preProcess(retained.sourceFile);
		};

		it('pre-processes more declarations than one batch identically to individual parsing, in emitted order', () => {
			const declarations = manyDeclarations(70);
			const batch: MockInstance = vi.spyOn(TestHelper.api, 'batch');
			const manager = new FileManager(TestHelper.api);
			manager.ingest(declarations);

			expect(Array.from(manager.getDeclarationFiles().keys())).toEqual(Array.from(declarations.keys()));
			for (const [ path, text ] of declarations) { expect(manager.getDeclarationFiles().get(path)).toEqual(parseIndividually(path, text)) }
			for (const generators of batch.mock.calls) { expect(generators.length).toBeLessThanOrEqual(32) }
			expect(batch.mock.calls.length).toBeGreaterThan(0);
		});

		it('re-parses only changed declarations and keeps emitted order', () => {
			const declarations = manyDeclarations(40);
			const manager = new FileManager(TestHelper.api);
			manager.ingest(declarations);
			const before = new Map(manager.getDeclarationFiles());
			const changedPath = '/test/module-20.d.ts' as AbsolutePath;
			const addedPath = '/test/added.d.ts' as AbsolutePath;
			const next = new Map(declarations);
			next.set(changedPath, 'export declare const value20: number;');
			next.delete('/test/module-5.d.ts' as AbsolutePath);
			next.set(addedPath, 'export declare const added: boolean;');
			const preProcess = vi.spyOn(DeclarationProcessor, 'preProcess');

			manager.ingest(next);

			expect(preProcess).toHaveBeenCalledTimes(2);
			expect(Array.from(manager.getDeclarationFiles().keys())).toEqual(Array.from(next.keys()));
			for (const [ path, result ] of manager.getDeclarationFiles()) {
				if (path === changedPath || path === addedPath) { expect(result).toEqual(parseIndividually(path, next.get(path) ?? '')) } else { expect(result).toBe(before.get(path)) }
			}
		});

		it('makes no API requests when nothing is emitted', () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(oneDeclaration('export const value: string;'));
			const batch = vi.spyOn(TestHelper.api, 'batch');
			const preProcess = vi.spyOn(DeclarationProcessor, 'preProcess');

			manager.ingest(new Map());

			expect(batch).not.toHaveBeenCalled();
			expect(preProcess).not.toHaveBeenCalled();
			expect(manager.getDeclarationFiles().size).toBe(0);
			expect(manager.finalize()).toBe(true);
		});

		it('keeps the stored declarations when an emitted declaration cannot be parsed', () => {
			const declarations = manyDeclarations(3);
			const manager = new FileManager(TestHelper.api);
			manager.ingest(declarations);
			const before = new Map(manager.getDeclarationFiles());
			const failing = new Map(manyDeclarations(3, ' | null'));
			failing.set('' as AbsolutePath, 'export {};');

			expect(() => manager.ingest(failing)).toThrow('fileName must not be empty');
			expect(manager.getDeclarationFiles()).toEqual(before);

			// The previous emitted text is still known, so re-ingesting it reuses every stored result
			const preProcess = vi.spyOn(DeclarationProcessor, 'preProcess');
			manager.ingest(declarations);
			expect(preProcess).not.toHaveBeenCalled();
			for (const [ path, result ] of manager.getDeclarationFiles()) { expect(result).toBe(before.get(path)) }
		});

		it('releases every parse lease and keeps stored declarations when pre-processing throws', () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(oneDeclaration('export const value: string;'));
			const before = new Map(manager.getDeclarationFiles());
			const failure = new Error('malformed declaration');
			const releases: MockInstance[] = [];
			const { createSourceFile } = TestHelper.api;
			const create = createSourceFile.gen;
			vi.spyOn(createSourceFile, 'gen').mockImplementation(function* (fileName, sourceText, options) {
				const retained = yield* create(fileName, sourceText, options);
				releases.push(vi.spyOn(retained.dispose, 'gen'));
				return retained;
			});
			const preProcess = DeclarationProcessor.preProcess;
			vi.spyOn(DeclarationProcessor, 'preProcess').mockImplementation((sourceFile) => {
				if (sourceFile.fileName.endsWith('module-1.d.ts')) { throw failure }
				return preProcess(sourceFile);
			});

			expect(() => manager.ingest(manyDeclarations(4))).toThrow(failure);
			expect(releases).toHaveLength(4);
			for (const release of releases) { expect(release).toHaveBeenCalledTimes(1) }
			expect(manager.getDeclarationFiles()).toEqual(before);
		});
	});

	describe('writeFiles', () => {
		it('returns an empty result when there are no declarations', async () => {
			expect(await new FileManager(TestHelper.api).writeFiles(tempDir)).toEqual([]);
		});

		it('rewrites relative declaration specifiers and preserves package specifiers', async () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(oneDeclaration('export { Foo } from "./foo";\nexport { Bar } from "./bar.js";\nexport { baz } from "pkg";'));
			await manager.writeFiles(tempDir);
			const output = await fsReadFile(declarationPath, 'utf8');
			expect(output).toContain('from "./foo.js"');
			expect(output).toContain('from "./bar.js"');
			expect(output).toContain('from "pkg"');
		});

		it('skips writing cached declarations whose code is empty', async () => {
			const empty = new Map<string, CachedDeclaration>([[declarationPath, {
				code: '', typeReferences: new Set<string>(), fileReferences: new Set<string>(),
			}]]);
			await new IncrementalBuildCache(tempDir).save(empty, 'fingerprint');
			const manager = new FileManager(TestHelper.api, new IncrementalBuildCache(tempDir));
			await manager.restore();
			expect(await manager.writeFiles(tempDir)).toEqual([]);
		});

		it('rewrites side-effect imports and skips empty cached files', async () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(new Map([
				[declarationPath, 'import "./polyfill";\nimport \'./other.js\';\nimport "pkg";\nexport declare class Foo {}'],
				['/test/empty.d.ts' as AbsolutePath, ''],
			]));
			await manager.writeFiles(tempDir);
			const output = await fsReadFile(declarationPath, 'utf8');
			expect(output).toContain('import "./polyfill.js"');
			expect(output).toContain("import './other.js'");
			expect(output).toContain('import "pkg"');
		});
	});

	describe('resolveEntryPoints', () => {
		it('selects the default point or returns all points when no default exists', () => {
			const manager = new FileManager(TestHelper.api);
			expect(manager.resolveEntryPoints({ index: './src/index.ts' as AbsolutePath, main: './src/main.ts' as AbsolutePath })).toEqual({ index: './src/index.ts' });
			expect(manager.resolveEntryPoints({ main: './src/main.ts' as AbsolutePath })).toEqual({ main: './src/main.ts' });
		});
		it('filters selected points and accepts an empty selection', () => {
			const manager = new FileManager(TestHelper.api);
			const points = { index: './src/index.ts' as AbsolutePath, main: './src/main.ts' as AbsolutePath };
			expect(manager.resolveEntryPoints(points, ['main'])).toEqual({ main: './src/main.ts' });
			expect(manager.resolveEntryPoints(points, [])).toEqual({});
		});
		it('reports unknown names and the empty valid-point list', () => {
			const manager = new FileManager(TestHelper.api);
			expect(() => manager.resolveEntryPoints({ index: './src/index.ts' as AbsolutePath }, ['bad'])).toThrow('Unknown dts.entryPoints: bad. Valid entry points: index.');
			expect(() => manager.resolveEntryPoints({}, ['bad'])).toThrow('Valid entry points: (none).');
		});
	});

	it('exposes its inspection tag and clears declarations on close', () => {
		const manager = new FileManager(TestHelper.api);
		manager.ingest(oneDeclaration('export const value: string;'));
		expect(Object.prototype.toString.call(manager)).toBe('[object FileManager]');
		manager.close();
		expect(manager.getDeclarationFiles().size).toBe(0);
	});

	describe('flush', () => {
		it('waits for saves and allows a subsequent save cycle', async () => {
			const manager = new FileManager(TestHelper.api, new IncrementalBuildCache(tempDir));
			manager.ingest(oneDeclaration('export const first: string;'));
			manager.persistCache('one');
			await manager.flush();
			await expect(manager.flush()).resolves.toBeUndefined();
			manager.ingest(oneDeclaration('export const second: number;'));
			manager.persistCache('two');
			await manager.flush();
			expect(manager.getDeclarationFiles().get(declarationPath)?.code).toContain('second');
		});

		it('combines overlapping save promises', async () => {
			const cache = new IncrementalBuildCache(tempDir);
			const save = vi.spyOn(cache, 'save').mockImplementation(async () => {
				await new Promise<void>(resolve => setImmediate(resolve));
			});
			const manager = new FileManager(TestHelper.api, cache);
			manager.ingest(oneDeclaration('export const value: string;'));
			manager.persistCache('one');
			manager.persistCache('two');
			await manager.flush();
			expect(save).toHaveBeenCalledTimes(2);
		});

		it('handles rejected background saves without an unhandled rejection', async () => {
			const cache = new IncrementalBuildCache(tempDir);
			vi.spyOn(cache, 'save').mockRejectedValue(new Error('cache save failed'));
			const manager = new FileManager(TestHelper.api, cache);
			manager.ingest(oneDeclaration('export const value: string;'));
			const unhandled: unknown[] = [];
			const listener = (reason: unknown): void => { unhandled.push(reason) };
			process.on('unhandledRejection', listener);
			manager.persistCache('fingerprint');
			await new Promise<void>(resolve => setImmediate(resolve));
			process.off('unhandledRejection', listener);
			expect(unhandled).toEqual([]);
			await expect(manager.flush()).rejects.toThrow('cache save failed');
		});
	});

	describe('async disposal', () => {
		it('waits for cache writes before clearing declarations and shares its promise', async () => {
			const cache = new IncrementalBuildCache(tempDir);
			const manager = new FileManager(TestHelper.api, cache);
			const saveStarted = Promise.withResolvers<void>();
			const releaseSave = Promise.withResolvers<void>();
			vi.spyOn(cache, 'save').mockImplementation(async () => {
				saveStarted.resolve();
				await releaseSave.promise;
			});
			manager.ingest(oneDeclaration('export const value: string;'));
			manager.persistCache('fingerprint');
			await saveStarted.promise;

			const disposal = manager[Symbol.asyncDispose]();
			expect(manager[Symbol.asyncDispose]()).toBe(disposal);
			expect(manager.getDeclarationFiles()).toHaveProperty('size', 1);

			releaseSave.resolve();
			await disposal;
			expect(manager.getDeclarationFiles()).toHaveProperty('size', 0);
		});

		it('releases declarations and propagates cache-save failures', async () => {
			const cache = new IncrementalBuildCache(tempDir);
			const manager = new FileManager(TestHelper.api, cache);
			vi.spyOn(cache, 'save').mockRejectedValue(new Error('cache save failed'));
			manager.ingest(oneDeclaration('export const value: string;'));
			manager.persistCache('fingerprint');

			await expect(manager[Symbol.asyncDispose]()).rejects.toThrow('cache save failed');
			expect(manager.getDeclarationFiles()).toHaveProperty('size', 0);
		});
	});
});
