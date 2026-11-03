import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import { TestHelper } from './scripts/test-helper';
import { Logger } from 'src/logger';
import type { MockInstance } from 'vitest';
import type { AbsolutePath } from 'src/@types';
import type { SourceFile } from 'typescript/ast';
import type { bundleDeclarations as BundleDeclarationsFn } from 'src/dts/declaration-bundler';
import type { DtsBundleOptions } from 'src/dts/@types';

vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

describe('bundleDeclarations', () => {
	let bundleDeclarations: typeof BundleDeclarationsFn;
	const cwd = process.cwd() as AbsolutePath;
	const outDir = join(cwd, 'dist') as AbsolutePath;

	const makeOptions = (overrides: Record<string, unknown> = {}) => ({
		api: TestHelper.api,
		currentDirectory: cwd,
		resolve: false,
		external: [] as (string | RegExp)[],
		noExternal: [] as (string | RegExp)[],
		compilerOptions: { outDir },
		...overrides,
	}) as unknown as DtsBundleOptions;

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		({ bundleDeclarations } = await import('src/dts/declaration-bundler'));
	});

	afterEach(() => { TestHelper.teardownMemfs() });

	describe('basic bundling', () => {
		it('bundles a single entry point', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'export declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(1);

			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { a };');
		});

		it('bundles types imported through a directory barrel', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import type { Options } from "./types";\nexport declare const options: Options;'],
					[join(cwd, 'src/types/index.d.ts'), 'export type Options = { enabled: boolean; };'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('type Options = { enabled: boolean; };');
			expect(content).not.toContain('from "./types"');
		});

		it('bundles multiple entry points in parallel', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'export declare const a: number;'],
					[join(cwd, 'src/utils.d.ts'), 'export declare const b: string;'],
				]),
				entryPoints: {
					index: join(cwd, 'src/index.d.ts') as AbsolutePath,
					utils: join(cwd, 'src/utils.d.ts') as AbsolutePath,
				},
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(2);
			expect(result.map(r => r.path)).toContain('dist/index.d.ts');
			expect(result.map(r => r.path)).toContain('dist/utils.d.ts');
		});

		it('preserves declaration identity for types shared by bundled entries', async () => {
			const declarationDirectory = join(outDir, 'src');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(declarationDirectory, 'a.d.ts'), `export { Token, brand } from './shared.js';
export type { Branded } from './shared.js';`],
					[join(declarationDirectory, 'b.d.ts'), `export { Token, brand } from './shared.js';
export type { Branded } from './shared.js';`],
					[join(declarationDirectory, 'shared.d.ts'), `export declare class Token { #private; }
export declare const brand: unique symbol;
export interface Branded { readonly [brand]: true; }`],
				]),
				entryPoints: {
					a: join(declarationDirectory, 'a.d.ts') as AbsolutePath,
					b: join(declarationDirectory, 'b.d.ts') as AbsolutePath
				},
			});

			await bundleDeclarations(options);

			const a = TestHelper.readFile(join(outDir, 'a.d.ts'));
			const b = TestHelper.readFile(join(outDir, 'b.d.ts'));
			const shared = TestHelper.readFile(join(outDir, '__tsbuild_shared/0.d.ts'));
			expect(a).toContain(`from './__tsbuild_shared/0.js'`);
			expect(b).toContain(`from './__tsbuild_shared/0.js'`);
			expect(a).not.toContain('class Token');
			expect(b).not.toContain('class Token');
			expect(shared).toContain('class Token');
			expect(shared).toContain('unique symbol');

			const { createFileSystemWithLib } = await import('typescript/fs');
			using snapshot = TestHelper.api.createSnapshot({
				fileSystem: createFileSystemWithLib([
					[ '/check/a.d.ts', a ],
					[ '/check/b.d.ts', b ],
					[ '/check/__tsbuild_shared/0.d.ts', shared ],
					[ '/check/consumer.ts', `import type { Token as TokenA, Branded as BrandedA } from './a.js';
import type { Token as TokenB, Branded as BrandedB } from './b.js';
declare const tokenA: TokenA;
declare const tokenB: TokenB;
declare const brandedA: BrandedA;
const token: TokenB = tokenA;
const branded: BrandedB = brandedA;
export { token, tokenB, branded };` ]
				]),
				createPrograms: [ { rootFiles: [ '/check/consumer.ts' ], compilerOptions: { strict: true, module: 99, moduleResolution: 100, noEmit: true, skipLibCheck: false, types: [], verbatimModuleSyntax: true } } ]
			});
			const [ program ] = snapshot.operation.createdPrograms;
			expect([ ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics() ]).toEqual([]);
		});

		it('resolves cross-file imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { foo } from "./foo";\nexport { foo };'],
					[join(cwd, 'src/foo.d.ts'), 'export declare const foo: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { foo };');
		});
	});

	describe('batched parsing', () => {
		afterEach(() => { vi.restoreAllMocks() });

		const moduleCount = 40;
		const typeAlias = (i: number) => i % 10 === 0 && i > 0 ? `type T${i} = T${i - 1} | ${i};` : `type T${i} = Shared | ${i};`;
		const barrelOptions = () => makeOptions({
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'src/index.d.ts'), Array.from({ length: moduleCount }, (_, i) => `export * from "./m${i}";`).join('\n')],
				[join(cwd, 'src/shared.d.ts'), 'export interface Shared { readonly id: string; }'],
				...Array.from({ length: moduleCount }, (_, i): [string, string] => [
					join(cwd, `src/m${i}.d.ts`),
					`import type { Shared } from "./shared";\n${i % 10 === 0 && i > 0 ? `import type { T${i - 1} } from "./m${i - 1}";\nexport type T${i} = T${i - 1} | ${i};` : `export type T${i} = Shared | ${i};`}\nexport declare const v${i}: T${i};`
				]),
			]),
			entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath, m20: join(cwd, 'src/m20.d.ts') as AbsolutePath },
		});
		let batch: MockInstance;
		/** Index of the batch call that created each batched source file */
		let parseBatches: number[];
		beforeEach(() => {
			batch = vi.spyOn(TestHelper.api, 'batch');
			parseBatches = [];
		});
		/** Records every batched source file lease, spying on its release */
		const trackLeases = (fail?: (fileName: string) => boolean) => {
			const releases: MockInstance[] = [];
			const { createSourceFile } = TestHelper.api;
			const create = createSourceFile.gen;
			vi.spyOn(createSourceFile, 'gen').mockImplementation(function* (fileName, sourceText, options) {
				// Runs when the batch first advances this generator
				parseBatches.push(batch.mock.calls.length);
				if (fail?.(fileName)) { throw new Error(`cannot parse ${fileName}`) }
				const retained = yield* create(fileName, sourceText, options);
				releases.push(vi.spyOn(retained.dispose, 'gen'));
				return retained;
			});
			return releases;
		};

		it('preserves bounded parse batches while externalizing shared declarations', async () => {
			const releases = trackLeases();

			await bundleDeclarations(barrelOptions());

			const index = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(index).toContain(`import type { Shared } from "./__tsbuild_shared/2.js"`);
			expect(index).toContain(`export * from "./__tsbuild_shared/0.js"`);
			expect(index).toContain(`export * from "./__tsbuild_shared/1.js"`);
			expect(TestHelper.readFile(join(outDir, 'm20.d.ts'))).toBe(`export * from "./__tsbuild_shared/1.js";`);
			expect(TestHelper.readFile(join(outDir, '__tsbuild_shared/0.d.ts'))).toContain('type T19 = Shared | 19;');
			expect(TestHelper.readFile(join(outDir, '__tsbuild_shared/1.d.ts'))).toContain('type T20 = T19 | 20;');
			expect(TestHelper.readFile(join(outDir, '__tsbuild_shared/2.d.ts'))).toContain('interface Shared { readonly id: string; }');
			// The barrel's modules are discovered together and parsed once across both entry points, in batches of at most 32;
			// the entry point and the shared module are each discovered alone and parsed with direct requests
			expect(releases).toHaveLength(moduleCount);
			for (const release of releases) { expect(release).toHaveBeenCalledTimes(1) }
			expect(Array.from(Map.groupBy(parseBatches, (index) => index).values(), (files) => files.length)).toEqual([ 32, 8 ]);
		});

		it('rejects and releases every created lease when a module fails to parse', async () => {
			const releases = trackLeases((fileName) => fileName.endsWith('/m7.d.ts'));

			await expect(bundleDeclarations(barrelOptions())).rejects.toThrow('/m7.d.ts');
			expect(releases.length).toBeGreaterThan(0);
			for (const release of releases) { expect(release).toHaveBeenCalledTimes(1) }
		});

		describe('event-loop yielding within an entry point', () => {
			const indexPath = join(cwd, 'src/index.d.ts') as AbsolutePath;
			/** Records `observe()` on every event-loop turn; a turn can only run while bundling has yielded */
			const probeTurns = <T>(observe: () => T) => {
				const observed: T[] = [];
				let active = true;
				const turn = () => {
					if (!active) { return }
					observed.push(observe());
					setImmediate(turn);
				};
				setImmediate(turn);
				return { observed, stop: () => { active = false } };
			};
			const released = (releases: readonly MockInstance[]) => releases.filter((release) => release.mock.calls.length > 0).length;

			it('runs other callbacks between parse batches and later stages of one entry point while transpile runs in parallel', async () => {
				const releases = trackLeases();
				const probe = probeTurns(() => ({ parsed: parseBatches.length, released: released(releases) }));
				let turnsBeforePostProcess = -1;
				const { DeclarationProcessor } = await import('src/dts/declaration-processor');
				const postProcess = DeclarationProcessor.postProcess;
				vi.spyOn(DeclarationProcessor, 'postProcess').mockImplementation((sourceFile) => {
					turnsBeforePostProcess = probe.observed.length;
					return postProcess(sourceFile);
				});

				await bundleDeclarations({ ...barrelOptions(), entryPoints: { index: indexPath }, parallelTranspile: true, yieldIntervalMs: 0 });
				probe.stop();

				// A turn ran after the first batch was parsed and released but before the second batch was parsed: no lease spans a yield
				expect(probe.observed).toContainEqual({ parsed: 32, released: 32 });
				// More turns ran after the last batch, during the module walk, combination and final parse of the same entry point
				const lastBatchTurn = probe.observed.findIndex(({ parsed }) => parsed === moduleCount);
				expect(lastBatchTurn).toBeGreaterThan(-1);
				expect(turnsBeforePostProcess - lastBatchTurn).toBeGreaterThan(moduleCount);
				for (const release of releases) { expect(release).toHaveBeenCalledTimes(1) }
			});

			it('keeps an entry point in one synchronous unit when no transpile runs in parallel', async () => {
				trackLeases();
				const probe = probeTurns(() => parseBatches.length);

				await bundleDeclarations({ ...barrelOptions(), entryPoints: { index: indexPath }, parallelTranspile: false, yieldIntervalMs: 0 });
				probe.stop();

				expect(probe.observed.every((parsed) => parsed === 0 || parsed === moduleCount)).toBe(true);
			});

			it('produces identical declarations with and without yielding', async () => {
				const read = () => [ 'index.d.ts', 'm20.d.ts' ].map((name) => TestHelper.readFile(join(outDir, name)));

				const sequential = await bundleDeclarations(barrelOptions());
				const sequentialOutput = read();
				const yielding = await bundleDeclarations({ ...barrelOptions(), parallelTranspile: true, yieldIntervalMs: 0 });

				expect(yielding).toEqual(sequential);
				expect(read()).toEqual(sequentialOutput);
			});

			it('rejects and releases leases and resolution resources when parsing fails after a yield', async () => {
				const releases = trackLeases((fileName) => fileName.endsWith('/m35.d.ts'));
				const probe = probeTurns(() => parseBatches.length);
				const snapshotDisposals: MockInstance[] = [];
				const { createSnapshot } = TestHelper.api;
				const create = createSnapshot.gen;
				vi.spyOn(createSnapshot, 'gen').mockImplementation(function* (...args: Parameters<typeof create>) {
					const snapshot = yield* create(...args);
					snapshotDisposals.push(vi.spyOn(snapshot, Symbol.dispose));
					return snapshot;
				} as typeof create);

				await expect(bundleDeclarations({ ...barrelOptions(), entryPoints: { index: indexPath }, parallelTranspile: true, yieldIntervalMs: 0 })).rejects.toThrow('/m35.d.ts');
				probe.stop();

				// The failure happened in the second batch, after the bundler had yielded to other callbacks
				expect(probe.observed).toContain(32);
				expect(releases.length).toBeGreaterThan(32);
				for (const release of releases) { expect(release).toHaveBeenCalledTimes(1) }
				expect(snapshotDisposals).toHaveLength(1);
				expect(snapshotDisposals[0]).toHaveBeenCalledTimes(1);
			});

			it('reports a failed declaration write after later entry points finish bundling', async () => {
				// A directory at the first entry's output path makes its write fail while the second entry is still bundling
				const { mkdirSync } = await import('node:fs');
				mkdirSync(join(outDir, 'index.d.ts'), { recursive: true });

				await expect(bundleDeclarations({ ...barrelOptions(), parallelTranspile: true, yieldIntervalMs: 0 })).rejects.toThrow(/EISDIR|illegal operation on a directory/);
				expect(TestHelper.readFile(join(outDir, 'm20.d.ts'))).toContain('export * from "./__tsbuild_shared/1.js";');
			});

			it('waits for every output write to settle before rejecting a failed entry', async () => {
				const { mkdirSync } = await import('node:fs');
				const fs = await import('node:fs/promises');
				mkdirSync(join(outDir, 'index.d.ts'), { recursive: true });

				const writeStarted = Promise.withResolvers<void>();
				const writeReleased = Promise.withResolvers<void>();
				const originalWrite = fs.writeFile;
				const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
					if (String(args[0]).endsWith('/m20.d.ts')) {
						writeStarted.resolve();
						await writeReleased.promise;
					}

					return Reflect.apply(originalWrite, fs, args);
				});

				const bundling = bundleDeclarations({ ...barrelOptions(), parallelTranspile: true, yieldIntervalMs: 0 });
				let settled = false;
				void bundling.then(() => { settled = true }, () => { settled = true });

				try {
					await writeStarted.promise;
					await Promise.resolve();
					expect(settled).toBe(false);

					writeReleased.resolve();
					await expect(bundling).rejects.toThrow(/EISDIR|illegal operation on a directory/);
					expect(TestHelper.readFile(join(outDir, 'm20.d.ts'))).toContain('export * from "./__tsbuild_shared/1.js";');
				} finally {
					writeReleased.resolve();
					await bundling.catch(() => undefined);
					writeSpy.mockRestore();
				}
			});
		});
	});

	describe('project-lifetime syntax cache', () => {
		it('reuses unchanged declaration ASTs while honoring entry and signature changes', async () => {
			const fixtureDir = join(cwd, 'dts-project-syntax-cache');
			const indexPath = join(fixtureDir, 'index.d.ts') as AbsolutePath;
			const secondPath = join(fixtureDir, 'second.d.ts') as AbsolutePath;
			const typePath = join(fixtureDir, 'types.d.ts') as AbsolutePath;
			const declarations = TestHelper.createDeclarationFilesMap([
				[indexPath, `import type { Shape } from './types';\nexport declare const value: Shape;`],
				[secondPath, 'export declare const second: number;'],
				[typePath, 'export interface Shape { label: string; }'],
			]);
			const sourceFileCache = new Map<AbsolutePath, { text: string; sourceFile: SourceFile }>();
			const options = makeOptions({
				declarationFiles: declarations,
				entryPoints: { index: indexPath },
				sourceFileCache,
			});

			await bundleDeclarations(options);
			const originalIndex = sourceFileCache.get(indexPath)?.sourceFile;
			const originalType = sourceFileCache.get(typePath)?.sourceFile;
			expect(originalIndex).toBeDefined();
			expect(originalType).toBeDefined();

			await bundleDeclarations({ ...options, entryPoints: { second: secondPath } });
			expect(TestHelper.readFile(join(outDir, 'second.d.ts'))).toContain('export { second };');
			expect(sourceFileCache.get(indexPath)?.sourceFile).toBe(originalIndex);
			expect(sourceFileCache.get(typePath)?.sourceFile).toBe(originalType);

			declarations.set(typePath, {
				code: 'export interface Shape { active: boolean; }',
				typeReferences: new Set(),
				fileReferences: new Set(),
			});
			await bundleDeclarations(options);
			expect(sourceFileCache.get(typePath)?.sourceFile).not.toBe(originalType);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('active: boolean');
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).not.toContain('label: string');
		});

		it('prunes removed and renamed paths, and reparses a later re-addition', async () => {
			const fixtureDir = join(cwd, 'dts-project-syntax-cache-paths');
			const indexPath = join(fixtureDir, 'index.d.ts') as AbsolutePath;
			const originalPath = join(fixtureDir, 'types.d.ts') as AbsolutePath;
			const renamedPath = join(fixtureDir, 'renamed.d.ts') as AbsolutePath;
			const declarations = TestHelper.createDeclarationFilesMap([
				[indexPath, `import type { Shape } from './types';\nexport declare const value: Shape;`],
				[originalPath, 'export interface Shape { label: string; }'],
			]);
			const sourceFileCache = new Map<AbsolutePath, { text: string; sourceFile: SourceFile }>();
			const options = makeOptions({ declarationFiles: declarations, entryPoints: { index: indexPath }, sourceFileCache });

			await bundleDeclarations(options);
			const original = sourceFileCache.get(originalPath)?.sourceFile;
			declarations.delete(originalPath);
			declarations.set(renamedPath, {
				code: 'export interface Shape { active: boolean; }',
				typeReferences: new Set(),
				fileReferences: new Set(),
			});
			declarations.set(indexPath, {
				code: `import type { Shape } from './renamed';\nexport declare const value: Shape;`,
				typeReferences: new Set(),
				fileReferences: new Set(),
			});
			await bundleDeclarations(options);
			expect(sourceFileCache.has(originalPath)).toBe(false);
			const renamed = sourceFileCache.get(renamedPath)?.sourceFile;
			expect(renamed).toBeDefined();
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('active: boolean');

			declarations.delete(renamedPath);
			declarations.set(originalPath, {
				code: 'export interface Shape { active: boolean; }',
				typeReferences: new Set(),
				fileReferences: new Set(),
			});
			declarations.set(indexPath, {
				code: `import type { Shape } from './types';\nexport declare const value: Shape;`,
				typeReferences: new Set(),
				fileReferences: new Set(),
			});
			await bundleDeclarations(options);
			expect(sourceFileCache.has(renamedPath)).toBe(false);
			expect(sourceFileCache.get(originalPath)?.sourceFile).not.toBe(original);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('active: boolean');
		});

		it('does not reuse external declaration text or resolution results across bundles', async () => {
			const fs = await import('node:fs');
			const fixtureDir = join(cwd, 'dts-project-syntax-cache-external');
			const packageDir = join(cwd, 'node_modules/syntax-cache-external');
			fs.mkdirSync(packageDir, { recursive: true });
			fs.writeFileSync(join(packageDir, 'index.d.ts'), 'export interface ExternalShape { before: string; }');
			const entryPath = join(fixtureDir, 'index.d.ts') as AbsolutePath;
			const declarations = TestHelper.createDeclarationFilesMap([
				[entryPath, `import type { ExternalShape } from 'syntax-cache-external';\nexport declare const value: ExternalShape;`],
			]);
			const sourceFileCache = new Map<AbsolutePath, { text: string; sourceFile: SourceFile }>();
			const options = makeOptions({
				declarationFiles: declarations,
				entryPoints: { index: entryPath },
				resolve: true,
				noExternal: ['syntax-cache-external'],
				sourceFileCache,
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('before: string');
			expect(sourceFileCache.size).toBe(1);

			fs.writeFileSync(join(packageDir, 'index.d.ts'), 'export interface ExternalShape { after: number; }');
			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('after: number');
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).not.toContain('before: string');
			expect(sourceFileCache.size).toBe(1);
		});
	});

	describe('identifier conflict renaming', () => {
		it('renames conflicting identifiers from different modules', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { User } from "./types";\nimport { User as LibUser } from "lib";\nexport { User, LibUser };'],
					[join(cwd, 'src/types.d.ts'), 'export interface User { name: string; }'],
					[join(cwd, 'node_modules/lib/index.d.ts'), 'export interface User { id: number; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
				noExternal: ['lib'] as (string | RegExp)[],
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('interface User');
			expect(content).toContain('User$1');
		});

		it('does not rename when no conflicts', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { User } from "./types";\nimport { Config } from "./utils";\nexport { User, Config };'],
					[join(cwd, 'src/types.d.ts'), 'export interface User { name: string; }'],
					[join(cwd, 'src/utils.d.ts'), 'export interface Config { apiUrl: string; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toContain('User$1');
			expect(content).not.toContain('Config$1');
		});

		it('avoids rename collisions with existing declarations', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { Foo } from "./a";\nimport { Foo as FooB } from "./b";\nimport { Foo$1 } from "./c";\nexport { Foo, FooB, Foo$1 };'],
					[join(cwd, 'src/a.d.ts'), 'export interface Foo { a: string; }'],
					[join(cwd, 'src/b.d.ts'), 'export interface Foo { b: number; }'],
					[join(cwd, 'src/c.d.ts'), 'export interface Foo$1 { c: boolean; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('interface Foo$2');
			expect(content).toContain('interface Foo {');
			expect(content).toContain('interface Foo$1');
		});

		it('preserves whitespace when renaming (regression: node.pos → node.getStart())', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { Options as A } from "./a";\nimport { Options as B } from "./b";\nexport { A, B };'],
					[join(cwd, 'src/a.d.ts'), 'export type Options = { value: string; };'],
					[join(cwd, 'src/b.d.ts'), 'export type Options = { count: number; };'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('type Options$1');
			expect(content).not.toContain('typeOptions$1');
		});

		it('does not reinsert renamed identifiers in removed export clauses (regression)', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'dts-bundler-regression/index.d.ts'), 'import { PublishOptions } from "./events";\nimport { Json } from "./json";\nexport { PublishOptions, Json };'],
					[join(cwd, 'dts-bundler-regression/events.d.ts'), 'import { Json } from "./json";\ndeclare type Json = string | number;\ndeclare type PublishOptions = { name: string; data?: Json; };\nexport { PublishOptions, Json };'],
					[join(cwd, 'dts-bundler-regression/json.d.ts'), 'declare type Json = string | number | boolean | null | object;\nexport { Json };'],
				]),
				entryPoints: { index: join(cwd, 'dts-bundler-regression/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toMatch(/\}Json/);
			expect(content).toContain('type Json$1');
		});
	});

	describe('star re-exports of bundled modules', () => {
		const fixtureDir = join(cwd, 'dts-star');
		const starOptions = (entry: string) => makeOptions({
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(fixtureDir, 'index.d.ts'), entry],
				[join(fixtureDir, 'values.d.ts'), `export * from './deep';
export declare const value: number;
export declare function fn(): void;
declare const _default: number;
export default _default;`],
				[join(fixtureDir, 'deep.d.ts'), 'export interface Deep { id: string; }'],
				[join(fixtureDir, 'types.d.ts'), 'export interface TypeOnly { t: true; }\nexport declare class Klass { k: number; }'],
				[join(fixtureDir, 'conflict-a.d.ts'), 'export declare const clash: number;\nexport declare const fromA: number;'],
				[join(fixtureDir, 'conflict-b.d.ts'), 'export declare const clash: string;'],
				[join(fixtureDir, 'shadow.d.ts'), 'export declare const shadowed: number;'],
				[join(fixtureDir, 'ns-collision.d.ts'), 'export declare const ns: boolean;\nexport declare const typesNs: boolean;'],
			]),
			entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
		});

		/**
		 * Type-checks a consumer of the bundled declaration in an isolated in-memory program.
		 * @param bundle - Bundled declaration text
		 * @param consumer - Consumer module importing from `./index.js`
		 * @returns Diagnostic messages
		 */
		const typeCheck = async (bundle: string, consumer: string) => {
			const { createFileSystemWithLib } = await import('typescript/fs');
			using snapshot = TestHelper.api.createSnapshot({
				fileSystem: createFileSystemWithLib([ [ '/check/index.d.ts', bundle ], [ '/check/consumer.ts', consumer ] ]),
				createPrograms: [ { rootFiles: [ '/check/consumer.ts' ], compilerOptions: { strict: true, module: 99, moduleResolution: 100, noEmit: true, types: [], verbatimModuleSyntax: true } } ]
			});
			const [ program ] = snapshot.operation.createdPrograms;
			return [ ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics() ].map(({ code, text }) => `TS${code}: ${text}`);
		};

		it('re-exports every non-default binding of bundled `export *` and `export type *` modules, transitively', async () => {
			await bundleDeclarations(starOptions(`export * from './values';
export type * from './types';
export * from './conflict-a';
export * from './conflict-b';
export * from './shadow';
export declare const shadowed: string;`));
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));

			expect(content).not.toContain('export {};');
			expect(content).toMatch(/^export \{ fn, fromA, shadowed\$1 as shadowed, value \};$/m);
			expect(content).toMatch(/^export type \{ Deep, Klass, TypeOnly \};$/m);
			expect(await typeCheck(content, `import { value, fn, fromA, shadowed, type Deep, type TypeOnly, type Klass } from './index.js';
fn();
const results: [number, number, string, Deep, TypeOnly, Klass] = [ value, fromA, shadowed, { id: '' }, { t: true }, { k: 1 } ];
export { results };`)).toEqual([]);
			// A name provided by several stars with different bindings is ambiguous and not re-exported; `default` is excluded by the export lines above
			expect(await typeCheck(content, `import { clash } from './index.js';\nexport { clash };`)).toEqual([ `TS2459: Module '"./index.js"' declares 'clash' locally, but it is not exported.` ]);
		});

		it('emits a namespace for bundled `export * as` and `export type * as`, avoiding identifier collisions', async () => {
			await bundleDeclarations(starOptions(`export * as ns from './values';
export type * as typesNs from './types';
export * from './ns-collision';`));
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));

			expect(content).toContain('declare namespace ns$1 {');
			expect(content).toContain('declare namespace typesNs$1 {');
			expect(content).toMatch(/^export \{ ns\$1 as ns \};$/m);
			expect(content).toMatch(/^export type \{ typesNs\$1 as typesNs \};$/m);
			expect(await typeCheck(content, `import { ns, type typesNs } from './index.js';
ns.fn();
const results: [number, number, ns.Deep, typesNs.TypeOnly, typesNs.Klass] = [ ns.value, ns.default, { id: '' }, { t: true }, { k: 1 } ];
export { results };`)).toEqual([]);
		});
	});

	describe('combined import and export forms', () => {
		it('maps default, type-only, missing, and re-exported bindings from a bundled dependency', async () => {
			const fixtureDir = join(cwd, 'dts-export-mapping');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), `import defaultValue, { runtimeValue as localValue, type Shape as LocalShape, type NotThere } from './dependency';
export { localValue, defaultValue, Unknown as unknownPublic };
export type { LocalShape, NotThere };
export type { LocalShape as PublicShape };
export type LocalOnly = boolean;
export type { Shape as RelayedShape } from './dependency';
export { runtimeValue as relayed, Missing as missingRelay } from './dependency';
export { type Shape } from './dependency';
import missingDefault from './no-default';
export { missingDefault };
export as namespace PublicBundle;
export default 123;`],
					[join(fixtureDir, 'dependency.d.ts'), `export interface Shape { id: string; }
export declare const runtimeValue: number;
export default runtimeValue;`],
					[join(fixtureDir, 'no-default.d.ts'), 'export type NoDefault = string;'],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('interface Shape');
			expect(content).toContain('RelayedShape');
			expect(content).toContain('PublicShape');
			expect(content).toContain('LocalOnly');
			expect(content).toContain('relayed');
			expect(content).toContain('unknownPublic');
			expect(content).toContain('missingRelay');
		});

		it('preserves named external imports with aliases and inline type specifiers', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'dts-external-forms/index.d.ts'), `import { value as aliased, type Typed, plain } from 'external-shape';
export declare const output: typeof aliased;`],
				]),
				entryPoints: { index: join(cwd, 'dts-external-forms/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('value as aliased');
			expect(content).toContain('type Typed');
			expect(content).toContain('plain');
		});

		it('preserves import attributes on named external imports and keeps differently attributed imports separate', async () => {
			const fixtureDir = join(cwd, 'dts-import-attributes');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), `import type { Esm } from 'dual-package' with { "resolution-mode": "import" };
import type { Cjs } from 'dual-package' with { "resolution-mode": "require" };
import type { Plain } from 'dual-package';
export { esm2 } from './other.js';
export declare const esm: Esm;
export declare const cjs: Cjs;
export declare const plain: Plain;`],
					[join(fixtureDir, 'other.d.ts'), `import type { Esm2 } from 'dual-package' with { "resolution-mode": "import" };
export declare const esm2: Esm2;`],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('import type { Esm, Esm2 } from "dual-package" with { "resolution-mode": "import" };');
			expect(content).toContain('import type { Cjs } from "dual-package" with { "resolution-mode": "require" };');
			expect(content).toContain('import type { Plain } from "dual-package";');
		});

		it('reuses parsed declarations and resolves the same dependency across entries', async () => {
			const fixtureDir = join(cwd, 'dts-shared-entry-cache');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'first.d.ts'), `import './left'; import './right'; export declare const first: number;`],
					[join(fixtureDir, 'second.d.ts'), `import './shared'; export declare const second: number;`],
					[join(fixtureDir, 'shared.d.ts'), `declare namespace Outer.Inner { interface Item { value: string; } }`],
					[join(fixtureDir, 'left.d.ts'), `import './shared';`],
					[join(fixtureDir, 'right.d.ts'), `import './shared';`],
				]),
				entryPoints: { first: join(fixtureDir, 'first.d.ts') as AbsolutePath, second: join(fixtureDir, 'second.d.ts') as AbsolutePath },
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(3);
			expect(TestHelper.readFile(join(outDir, 'first.d.ts'))).toContain(`import './__tsbuild_shared/0.js'`);
			expect(TestHelper.readFile(join(outDir, 'second.d.ts'))).toContain(`import './__tsbuild_shared/0.js'`);
			expect(TestHelper.readFile(join(outDir, '__tsbuild_shared/0.d.ts'))).toContain('namespace Outer');
		});
	});

	describe('external modules', () => {
		it('preserves external imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { useState } from "react";\nexport declare const a: typeof useState;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				external: [/^react/] as (string | RegExp)[],
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('import { useState } from "react";');
		});

		it('adds reference types directive for node: protocol imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import type { PerformanceEntry } from "node:perf_hooks";\nexport declare const entry: PerformanceEntry;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('/// <reference types="node" />');
			expect(content).toContain('import type { PerformanceEntry } from "node:perf_hooks"');
		});

		it('preserves side-effect imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), "import './styles.css';\nexport declare const foo: string;"],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain("import './styles.css';");
		});

		it('preserves external side-effect imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), "import 'some-side-effect-module';\nexport declare const foo: string;"],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain("import 'some-side-effect-module';");
		});

		it('preserves external re-exports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'export { extFn } from "ext-lib";'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(1);

			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { extFn } from "ext-lib";');
		});
	});

	describe('references', () => {
		it('preserves triple-slash references', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), '/// <reference path="./other.d.ts" />\n/// <reference types="node" />\nexport declare const a: number;'],
					[join(cwd, 'src/other.d.ts'), 'declare const other: string;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('/// <reference types="node" />');
			expect(content).toMatch(/\/\/\/ <reference path=".*other\.d\.ts" \/>/);
		});
	});

	describe('complex type references', () => {
		it('handles namespaces and implements clauses', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), `import { UI, Theme } from './namespaces';
declare const widget: UI.Widget;
type ThemeType = typeof Theme;
declare class MyButton implements UI.Widget { render(): void; }
export { widget, ThemeType, MyButton };`],
					[join(cwd, 'src/namespaces.d.ts'), `export declare namespace UI {
    interface Widget { render(): void; }
    class Button implements Widget { render(): void; }
}
export declare const Theme: { color: string; };`],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('namespace UI');
			expect(content).toContain('interface Widget');
			expect(content).toContain('implements UI.Widget');
		});
	});

	describe('entry point resolution', () => {
		it('throws BundleError when entry point is missing', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), ''],
				]),
				entryPoints: { index: join(cwd, 'src/missing.d.ts') as AbsolutePath },
			});

			await expect(bundleDeclarations(options)).rejects.toThrow(/Entry point declaration file not found/);
		});

		it('handles explicit rootDir in sourceToDeclarationPath', async () => {
			const rootDir = join(cwd, 'src') as AbsolutePath;
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(outDir, 'index.d.ts'), 'export declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.ts') as AbsolutePath },
				compilerOptions: { outDir, rootDir },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { a };');
		});

		it('prefers shortest relative path for stale cache scenario', async () => {
			const stale = join(outDir, 'src/index.d.ts') as AbsolutePath;
			const correct = join(outDir, 'index.d.ts') as AbsolutePath;

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[stale, 'export declare const version: "stale";'],
					[correct, 'export declare const version: "correct";'],
				]),
				entryPoints: { index: join(cwd, 'src/index.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('"correct"');
			expect(content).not.toContain('"stale"');
		});
	});

	describe('unavailable source declarations', () => {
		it('keeps unresolved source-file modules external when declaration resolution is enabled', async () => {
			const fs = await import('node:fs');
			const fixtureDir = join(cwd, 'dts-source-only');
			fs.mkdirSync(fixtureDir, { recursive: true });
			fs.writeFileSync(join(fixtureDir, 'dependency.ts'), 'export type Dependency = string;');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), 'import type { Dependency } from "./dependency";\nexport declare const value: Dependency;'],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
				resolve: true,
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('from "./dependency"');
		});

		it('falls back to the source path when rootDir has no corresponding declaration', async () => {
			const fs = await import('node:fs');
			const fixtureDir = join(cwd, 'dts-root-dir-fallback');
			fs.mkdirSync(join(fixtureDir, 'src'), { recursive: true });
			fs.writeFileSync(join(fixtureDir, 'src/source.ts'), 'export type SourceOnly = string;');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), 'import type { SourceOnly } from "@source";\nexport declare const value: SourceOnly;'],
					[join(fixtureDir, 'dist/other.d.ts'), 'export type Other = number;'],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
				compilerOptions: { outDir: join(fixtureDir, 'dist'), rootDir: join(fixtureDir, 'src'), paths: { '@source': ['./dts-root-dir-fallback/src/source.ts'] }, configFilePath: join(cwd, 'tsconfig.json') },
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(fixtureDir, 'dist/index.d.ts'))).toContain('from "@source"');
		});
	});

	describe('additional declaration shapes', () => {
		it('collects destructured variables and string-literal module names', async () => {
			const fixtureDir = join(cwd, 'dts-declaration-shapes');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), `export declare const { value }: { value: string; };
export declare module 'ambient-module' { interface Options { enabled: boolean; } }`],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('ambient-module');
		});

		it('walks nested module-declaration AST bodies from cached declarations', async () => {
			const filePath = join(cwd, 'dts-nested-module-record/index.d.ts');
			const declarationFiles = new Map([[filePath, {
				code: 'declare namespace Outer.Inner { interface Item { value: string; } }',
				typeReferences: new Set<string>(),
				fileReferences: new Set<string>(),
			}]]);
			const options = makeOptions({ declarationFiles, entryPoints: { index: filePath as AbsolutePath } });

			expect(await bundleDeclarations(options)).toHaveLength(1);
		});

		it('keeps value exports when a type export has the same public name', async () => {
			const fixtureDir = join(cwd, 'dts-same-export-name');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), `export { type Same } from './type';
export { Same } from './value';`],
					[join(fixtureDir, 'type.d.ts'), 'export type Same = string;'],
					[join(fixtureDir, 'value.d.ts'), 'export declare const Same: number;'],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('Same');
		});

		it('exports local types under aliases', async () => {
			const fixtureDir = join(cwd, 'dts-local-type-alias');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), `type Original = string;
export { Original as PublicOriginal };`],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('Original as PublicOriginal');
		});

		it('parses anonymous declarations from an already-cached declaration record', async () => {
			const filePath = join(cwd, 'dts-anonymous-record/index.d.ts');
			const declarationFiles = new Map([[filePath, {
				code: 'export default function() {}',
				typeReferences: new Set<string>(),
				fileReferences: new Set<string>(),
			}]]);
			const options = makeOptions({ declarationFiles, entryPoints: { index: filePath as AbsolutePath } });

			expect(await bundleDeclarations(options)).toHaveLength(1);
		});
	});

	describe('edge entry and output options', () => {
		it('skips source entries without a declaration file', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'dts-entry-edge/other.d.ts'), 'export declare const other: string;'],
				]),
				entryPoints: { script: join(cwd, 'dts-entry-edge/script.ts') as AbsolutePath },
			});

			expect(await bundleDeclarations(options)).toEqual([]);
		});

		it('reports similar files and compiler-option defaults for a missing declaration entry', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'dts-entry-edge/other/missing.d.ts'), 'export {};'],
				]),
				entryPoints: { missing: join(cwd, 'dts-entry-edge/missing.d.ts') as AbsolutePath },
				compilerOptions: { outDir: '' },
			});

			await expect(bundleDeclarations(options)).rejects.toThrow('outDir=dist, rootDir=not set');
		});

		it('yields between entries when parallel transpilation is active', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'dts-parallel/first.d.ts'), 'export declare const first: string;'],
					[join(cwd, 'dts-parallel/second.d.ts'), 'export declare const second: number;'],
				]),
				entryPoints: { first: join(cwd, 'dts-parallel/first.d.ts') as AbsolutePath, second: join(cwd, 'dts-parallel/second.d.ts') as AbsolutePath },
				parallelTranspile: true,
			});

			expect(await bundleDeclarations(options)).toHaveLength(2);
		});
	});

	describe('export handling', () => {
		it('strips empty named exports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'export {};\nexport declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toContain('export {};');
			expect(content).toContain('export { a };');
		});

		it('emits a single module marker when the bundle has no other exports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import "./polyfill";\nexport {};\ndeclare global {\n\tinterface Map<K, V> { foo(): void; }\n}'],
					[join(cwd, 'src/polyfill.d.ts'), 'export {};\ndeclare global {\n\tinterface Set<T> { bar(): void; }\n}'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('interface Map<K, V>');
			expect(content).toContain('interface Set<T>');
			expect(content.match(/export\s*{\s*}/g)?.length).toBe(1);
			expect(content.trimEnd().endsWith('export {};')).toBe(true);
		});

		it('does not write a declaration for entries or dependencies that only contain the module marker', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import "./empty";\nexport declare const a: number;'],
					[join(cwd, 'src/empty.d.ts'), 'export {};'],
					[join(cwd, 'src/cli.d.ts'), 'export {};'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath, cli: join(cwd, 'src/cli.d.ts') as AbsolutePath },
			});

			const result = await bundleDeclarations(options);
			expect(result.map(({ path }) => path)).toEqual([ 'dist/index.d.ts' ]);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toMatch(/export\s*{\s*}/);
			expect(content).toContain('export { a };');
		});

		it('strips default exports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'declare const _default: number;\nexport default _default;\nexport declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { a, _default as default };');
		});

		it('preserves named export aliases and bundled local bindings', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { value as localValue } from "./dependency";\nexport { localValue as publicValue };'],
					[join(cwd, 'src/dependency.d.ts'), 'export declare const value: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { value as publicValue };');
		});

		it('does not expose dependency-only exports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { publicValue } from "./dependency";\nexport { publicValue };'],
					[join(cwd, 'src/dependency.d.ts'), 'export declare const publicValue: number;\nexport declare const privateValue: string;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { publicValue };');
			expect(content).not.toContain('export { privateValue');
		});
	});

	describe('nested entry output', () => {
		it('creates directories for nested entry names', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/feature.d.ts'), 'export declare const feature: boolean;'],
				]),
				entryPoints: { 'features/index': join(cwd, 'src/feature.d.ts') as AbsolutePath },
			});

			const result = await bundleDeclarations(options);
			expect(result[0]?.path).toBe('dist/features/index.d.ts');
			expect(TestHelper.readFile(join(outDir, 'features/index.d.ts'))).toContain('export { feature };');
		});
	});

	describe('circular re-exports', () => {
		it('preserves exports when a cycle is encountered before its export map is available', async () => {
			const fixtureDir = join(cwd, 'dts-circular-reexport');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), `export { A } from './a';`],
					[join(fixtureDir, 'a.d.ts'), `export { B } from './b'; export interface A {}`],
					[join(fixtureDir, 'b.d.ts'), `export { A } from './a'; export interface B {}`],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('interface A');
		});
	});

	describe('circular dependencies', () => {
		it('emits a warning and still produces output', async () => {
			const warnSpy = vi.spyOn(Logger, 'warn');

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { a } from "./a";\nexport { a };'],
					[join(cwd, 'src/a.d.ts'), 'import { b } from "./b";\nexport declare const a: number;'],
					[join(cwd, 'src/b.d.ts'), 'import { a } from "./a";\nexport declare const b: string;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Circular dependency detected/));
			warnSpy.mockRestore();

			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('declare const a: number');
		});
	});

	describe('namespace alias flattening', () => {
		it('flattens bundled namespace alias qualified names from inline import() types', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'type BeforeErrorHook = (error: import("./http-error").HttpError) => import("./http-error").HttpError | void;\nexport type { BeforeErrorHook };'],
					[join(cwd, 'src/http-error.d.ts'), 'export declare class HttpError extends Error { status: number; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toMatch(/___http_error\./);
			expect(content).toContain('HttpError');
			expect(content).toContain('BeforeErrorHook');
			expect(content).not.toMatch(/import \* as ___http_error/);
		});
	});

	describe('path-mapped directories', () => {
		it('bundles types from path-mapped directories', async () => {
			const fs = await import('node:fs');
			fs.mkdirSync(join(cwd, 'src/@types'), { recursive: true });
			fs.writeFileSync(join(cwd, 'src/@types/index.ts'), 'export type CustomType = string;');

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), "import type { CustomType } from './@types';\nexport declare const value: CustomType;\nexport type { CustomType };"],
					[join(cwd, 'src/@types/index.d.ts'), 'export type CustomType = string | number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				compilerOptions: { outDir, paths: { '@types': ['./src/@types'] } },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toContain("from './@types'");
			expect(content).toContain('type CustomType');
		});
	});

	describe('native resolution caching', () => {
		it('reuses resolved module results across entry points and converts path-mapped source files', async () => {
			const fixtureDir = join(cwd, 'dts-resolution-cache');
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'first.d.ts'), 'import type { Mapped } from "@alias/mapped";\nexport declare const first: Mapped;'],
					[join(fixtureDir, 'second.d.ts'), 'import type { Mapped } from "@alias/other";\nexport declare const second: Mapped;'],
					[join(fixtureDir, 'src/mapped.ts'), 'export type Mapped = string;'],
					[join(fixtureDir, 'dist/mapped.d.ts'), 'export type Mapped = string;'],
				]),
				entryPoints: { first: join(fixtureDir, 'first.d.ts') as AbsolutePath, second: join(fixtureDir, 'second.d.ts') as AbsolutePath },
				compilerOptions: { outDir: join(fixtureDir, 'dist'), paths: { '@alias/*': ['./dts-resolution-cache/src/mapped.ts'] }, configFilePath: join(cwd, 'tsconfig.json') },
			});

			const results = await bundleDeclarations(options);
			expect(results).toHaveLength(3);
			expect(results.map(({ path }) => path)).toContain('dts-resolution-cache/dist/__tsbuild_shared/0.d.ts');
			expect(TestHelper.readFile(join(fixtureDir, 'dist/first.d.ts'))).toContain(`from "./__tsbuild_shared/0.js"`);
			expect(TestHelper.readFile(join(fixtureDir, 'dist/second.d.ts'))).toContain(`from "./__tsbuild_shared/0.js"`);
			expect(TestHelper.readFile(join(fixtureDir, 'dist/__tsbuild_shared/0.d.ts'))).toContain('type Mapped = string;');
		});
	});

	describe('unreadable external declarations', () => {
		it('keeps a package import when a host declaration cannot be read through the test filesystem', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'dts-unreadable-external/index.d.ts'), 'import type { BuildOptions } from "esbuild";\nexport declare const options: BuildOptions;'],
				]),
				entryPoints: { index: join(cwd, 'dts-unreadable-external/index.d.ts') as AbsolutePath },
				resolve: true,
				noExternal: ['esbuild'],
			});

			await bundleDeclarations(options);
			expect(TestHelper.readFile(join(outDir, 'index.d.ts'))).toContain('from "esbuild"');
		});
	});

	describe('external node_modules resolution', () => {
		it('loads and bundles node_modules declarations when noExternal matches', async () => {
			const fs = await import('node:fs');
			const fixtureDir = join(cwd, 'dts-node-modules-fixture');
			const packageDir = join(cwd, 'node_modules/native-resolution-lib');
			fs.mkdirSync(packageDir, { recursive: true });
			fs.writeFileSync(join(packageDir, 'index.d.ts'), 'export interface NativeOptions { enabled: boolean; }');

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(fixtureDir, 'index.d.ts'), 'import type { NativeOptions } from "native-resolution-lib";\nexport declare const options: NativeOptions;'],
				]),
				entryPoints: { index: join(fixtureDir, 'index.d.ts') as AbsolutePath },
				resolve: true,
				noExternal: ['native-resolution-lib'],
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('interface NativeOptions { enabled: boolean; }');
			expect(content).not.toContain('from "native-resolution-lib"');
		});

		it('stores externally resolved files separately and cleans up', async () => {
			const fs = await import('node:fs');
			const libDir = join(cwd, 'node_modules/ext-lib');
			fs.mkdirSync(libDir, { recursive: true });
			fs.writeFileSync(join(libDir, 'index.d.ts'), 'export declare const extFn: () => void;');

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { extFn } from "ext-lib";\nexport declare const wrapper: typeof extFn;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(1);

			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('import { extFn } from "ext-lib"');
		});
	});

	describe('multiple conflicts across modules', () => {
		it('handles three modules with same identifier', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { Status } from "./types";\nimport { Status as S1 } from "lib1";\nimport { Status as S2 } from "lib2";\nexport { Status, S1, S2 };'],
					[join(cwd, 'src/types.d.ts'), 'export type Status = "ok";'],
					[join(cwd, 'node_modules/lib1/index.d.ts'), 'export type Status = "pending";'],
					[join(cwd, 'node_modules/lib2/index.d.ts'), 'export type Status = "error";'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
				noExternal: ['lib1', 'lib2'] as (string | RegExp)[],
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('type Status');
			expect(content).toContain('Status$1');
			expect(content).toContain('Status$2');
		});
	});
});
