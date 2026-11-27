import { vol } from 'memfs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDirOptions } from '../src/constants';
import { FileManager } from '../src/file-manager';
import { DeclarationProcessor } from '../src/dts/declaration-processor';
import { TestHelper } from './scripts/test-helper';
import type { MockInstance } from 'vitest';
import type { AbsolutePath } from '../src/@types';

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
		it('constructs with an empty declaration store', () => {
			expect(new FileManager(TestHelper.api).getDeclarationFiles().size).toBe(0);
		});

		it('pre-processes declarations', () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(oneDeclaration('export const hello: string;'));
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

		it('skips writing declarations whose code is empty', async () => {
			const manager = new FileManager(TestHelper.api);
			manager.ingest(oneDeclaration(''));
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

});
