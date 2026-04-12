import { vol } from 'memfs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultDirOptions } from '../src/constants';
import { FileManager } from '../src/file-manager';
import { IncrementalBuildCache } from '../src/incremental-build-cache';
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { TestHelper } from './scripts/test-helper';
import type { AbsolutePath, CachedDeclaration } from '../src/@types';

vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

describe('FileManager', () => {
	const tempDir = '/test' as AbsolutePath;

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		vol.mkdirSync(tempDir, defaultDirOptions);
	});

	afterEach(() => { TestHelper.teardownMemfs() });

	describe('constructor', () => {
		it('initializes without caching when no cache provided', () => {
			const manager = new FileManager();
			expect(manager).toBeDefined();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('initializes with caching when cache provided', async () => {
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);
			const cache = new IncrementalBuildCache(tempDir, 'tsconfig.tsbuildinfo');
			const manager = new FileManager(cache);
			expect(manager).toBeDefined();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});
	});

	describe('initialize', () => {
		it('prepares fileWriter for emit', async () => {
			const manager = new FileManager();
			await manager.initialize();
			expect(typeof manager.fileWriter).toBe('function');
		});

		it('clears files when caching is disabled', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('test.d.ts', 'content');
			manager.finalize();
			expect(manager.getDeclarationFiles().size).toBe(1);

			await manager.initialize();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('resets emit flag on each initialize', async () => {
			const manager = new FileManager();

			await manager.initialize();
			manager.fileWriter('file1.d.ts', 'content1');
			expect(manager.finalize()).toBe(true);

			await manager.initialize();
			expect(manager.finalize()).toBe(true); // Non-incremental always true
		});

		it('loads cache when caching is enabled', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			manager1.finalize();
			await manager1.flush();

			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			expect(manager2.getDeclarationFiles().size).toBe(1);
			const cached = manager2.getDeclarationFiles().get('test.d.ts' as AbsolutePath) as CachedDeclaration;
			expect(cached.code).toContain('declare const hello: string;');
			expect(cached.code).toContain('export { hello }');
		});

		it('handles corrupt cache file gracefully', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			const cacheDir = join(tempDir, '.tsbuild');
			await mkdir(cacheDir, defaultDirOptions);
			await fsWriteFile(join(cacheDir, 'dts_cache.json.br'), 'invalid brotli data');

			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager = new FileManager(cache);
			await expect(manager.initialize()).resolves.toBeUndefined();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});
	});

	describe('finalize', () => {
		it('returns true when files were written', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('file1.d.ts', 'content1');
			manager.fileWriter('file2.d.ts', 'content2');
			expect(manager.finalize()).toBe(true);
		});

		it('returns true for non-incremental builds even when no files written', async () => {
			const manager = new FileManager();
			await manager.initialize();
			expect(manager.finalize()).toBe(true);
		});

		it('returns false for incremental builds when no files written', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			manager1.finalize();
			await manager1.flush();

			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			expect(manager2.finalize()).toBe(false);
		});

		it('returns false for incremental builds when only .tsbuildinfo is written', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			manager1.finalize();
			await manager1.flush();

			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			manager2.fileWriter(`${tempDir}/${tsBuildInfoFile}`, '{"version":"5.0"}');
			expect(manager2.finalize()).toBe(false);
		});

		it('saves cache when caching is enabled', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			manager1.finalize();
			await manager1.flush();

			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			const cached = manager2.getDeclarationFiles().get('test.d.ts' as AbsolutePath) as CachedDeclaration;
			expect(cached.code).toContain('declare const hello: string;');
		});

		it('updates cached files on subsequent emits', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			manager1.finalize();
			await manager1.flush();

			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			manager2.fileWriter('test.d.ts', 'export const hello: number;');
			manager2.finalize();
			await manager2.flush();

			const cache3 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager3 = new FileManager(cache3);
			await manager3.initialize();
			const cached = manager3.getDeclarationFiles().get('test.d.ts' as AbsolutePath) as CachedDeclaration;
			expect(cached.code).toContain('declare const hello: number;');
		});
	});

	describe('getDeclarationFiles', () => {
		it('returns empty map initially', () => {
			const manager = new FileManager();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('returns all stored files', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('file1.d.ts', 'content1');
			manager.fileWriter('file2.d.ts', 'content2');
			manager.finalize();

			const files = manager.getDeclarationFiles();
			expect(files.size).toBe(2);
			expect((files.get('file1.d.ts' as AbsolutePath) as CachedDeclaration).code).toBe('content1');
			expect((files.get('file2.d.ts' as AbsolutePath) as CachedDeclaration).code).toBe('content2');
		});
	});

	describe('fileWriter', () => {
		it('stores declaration files in memory with pre-processing', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('test.d.ts', 'export const hello: string;');
			manager.finalize();

			const cached = manager.getDeclarationFiles().get('test.d.ts' as AbsolutePath) as CachedDeclaration;
			expect(cached.code).toContain('declare const hello: string;');
			expect(cached.code).toContain('export { hello }');
		});

		it('stores all file types when caching is disabled', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('test.js', 'console.log("hello")');
			manager.fileWriter('test.d.ts', 'export const hello: string;');
			manager.fileWriter('tsconfig.tsbuildinfo', '{}');
			manager.finalize();

			expect(manager.getDeclarationFiles().size).toBe(3);
		});
	});

	describe('writeFiles', () => {
		it('returns empty array when no files to write', async () => {
			const manager = new FileManager();
			const result = await manager.writeFiles(tempDir);
			expect(result).toEqual([]);
		});

		it('rewrites extension-less relative specifiers when writing declarations', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('types.d.ts', 'export { Foo } from "./foo";\nexport { Bar } from "./bar.js";\nexport { baz } from "pkg";');
			manager.finalize();

			await manager.writeFiles(tempDir);

			const written = await fsReadFile('types.d.ts', 'utf8');
			expect(written).toContain('from "./foo.js"');
			expect(written).toContain('from "./bar.js"');
			expect(written).toContain('from "pkg"');
		});
	});

	describe('resolveEntryPoints', () => {
		it('returns index entry point when no dtsEntryPoints and index exists', () => {
			const manager = new FileManager();
			const result = manager.resolveEntryPoints({ index: './src/index.ts', main: './src/main.ts' } as unknown as Record<string, AbsolutePath>);
			expect(result).toEqual({ index: './src/index.ts' });
		});

		it('returns all entry points when no dtsEntryPoints and no index exists', () => {
			const manager = new FileManager();
			const pts = { main: './src/main.ts', utils: './src/utils.ts' } as unknown as Record<string, AbsolutePath>;
			const result = manager.resolveEntryPoints(pts);
			expect(result).toEqual(pts);
		});

		it('filters entry points when dtsEntryPoints array is provided', () => {
			const manager = new FileManager();
			const result = manager.resolveEntryPoints(
				{ index: './src/index.ts', main: './src/main.ts', utils: './src/utils.ts' } as unknown as Record<string, AbsolutePath>,
				['index', 'utils']
			);
			expect(result).toEqual({ index: './src/index.ts', utils: './src/utils.ts' });
		});

		it('returns empty object when dtsEntryPoints has no matches', () => {
			const manager = new FileManager();
			const result = manager.resolveEntryPoints(
				{ index: './src/index.ts' } as unknown as Record<string, AbsolutePath>,
				['nonexistent']
			);
			expect(result).toEqual({});
		});

		it('returns empty object for empty dtsEntryPoints array', () => {
			const manager = new FileManager();
			const result = manager.resolveEntryPoints(
				{ index: './src/index.ts' } as unknown as Record<string, AbsolutePath>,
				[]
			);
			expect(result).toEqual({});
		});
	});

	describe('[Symbol.toStringTag]', () => {
		it('returns FileManager', () => {
			const manager = new FileManager();
			expect(Object.prototype.toString.call(manager)).toBe('[object FileManager]');
		});
	});

	describe('close', () => {
		it('clears all stored files', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('file.d.ts', 'export const x: number;');
			manager.finalize();
			expect(manager.getDeclarationFiles().size).toBe(1);

			manager.close();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});
	});

	describe('flush', () => {
		it('awaits pending save operations', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager = new FileManager(cache);
			await manager.initialize();
			manager.fileWriter('test.d.ts', 'export const hello: string;');
			manager.finalize();

			// flush should resolve without error
			await expect(manager.flush()).resolves.toBeUndefined();
		});

		it('is a no-op when no pending save exists', async () => {
			const manager = new FileManager();
			await expect(manager.flush()).resolves.toBeUndefined();
		});
	});
});
