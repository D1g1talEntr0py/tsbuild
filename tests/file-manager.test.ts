import { vol } from 'memfs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultDirOptions } from '../src/constants';
import { FileManager } from '../src/file-manager';
import { IncrementalBuildCache } from '../src/incremental-build-cache';
import { mkdir, writeFile as fsWriteFile, chmod } from 'node:fs/promises';
import { TestHelper } from './scripts/test-helper';
import type { AbsolutePath, CachedDeclaration } from '../src/@types';

// Mock node:fs and node:fs/promises with memfs
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

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	describe('constructor', () => {
		it('should initialize without caching when no options provided', async () => {
			const manager = new FileManager();
			expect(manager).toBeDefined();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('should initialize with caching when options provided', async () => {
			// Create .tsbuild directory before initializing manager
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache = new IncrementalBuildCache(tempDir, 'tsconfig.tsbuildinfo');
			const manager = new FileManager(cache);
			expect(manager).toBeDefined();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('should handle errors when deleting tsbuildinfo file during cache verification', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';

			// Create tsbuildinfo file and make it read-only to simulate deletion error
			await fsWriteFile(join(tempDir, tsBuildInfoFile), '{"version":"5.0"}');
			await chmod(join(tempDir, tsBuildInfoFile), 0o444);

			try {
				// Constructor calls verifyCache which should handle deletion error gracefully (line 122)
				const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
				const manager = new FileManager(cache);

				expect(manager).toBeDefined();
			} finally {
				// Clean up: restore write permissions
				await chmod(join(tempDir, tsBuildInfoFile), 0o644).catch(() => {});
			}
		});
	});

	describe('initialize', () => {
		it('should prepare manager for emit', async () => {
			const manager = new FileManager();
			await manager.initialize();
			expect(manager.fileWriter).toBeDefined();
			expect(typeof manager.fileWriter).toBe('function');
		});

		it('should clear files when caching is disabled', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('test.d.ts', 'content');
			expect(manager.getDeclarationFiles().size).toBe(1);

			// Second initialize should clear files
			await manager.initialize();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('should reset emit flag on each initialize', async () => {
			const manager = new FileManager();

			// First emit
			await manager.initialize();
			manager.fileWriter('file1.d.ts', 'content1');
			let hasEmitted = await manager.finalize();
			expect(hasEmitted).toBe(true);

			// Second initialize should reset flag
			await manager.initialize();
			hasEmitted = await manager.finalize();
			expect(hasEmitted).toBe(true); // Non-incremental always returns true
		});

		it('should load cache when caching is enabled', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			// First manager: write and save
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			const hasEmitted = await manager1.finalize();
			expect(hasEmitted).toBe(true);

			// Second manager: should load from cache
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			expect(manager2.getDeclarationFiles().size).toBe(1);
			const cached = manager2.getDeclarationFiles().get('test.d.ts') as CachedDeclaration;
			// Content is pre-processed: export const -> declare const + export {}
			expect(cached.code).toContain('declare const hello: string;');
			expect(cached.code).toContain('export { hello }');
		});

		it('should handle corrupt cache file gracefully', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			const cacheDir = join(tempDir, '.tsbuild');

			// Write invalid brotli data to cache file
			await mkdir(cacheDir, defaultDirOptions);
			await fsWriteFile(join(cacheDir, 'dts_cache.json.br'), 'invalid brotli data');

			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager = new FileManager(cache);

			// Should handle corrupt cache gracefully (catch block coverage)
			await expect(manager.initialize()).resolves.toBeUndefined();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('should handle early return when caching is disabled', async () => {
			const manager = new FileManager();

			await manager.initialize();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});
	});

	describe('finalize', () => {
		it('should return true when files were written', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('file1.d.ts', 'content1');
			manager.fileWriter('file2.d.ts', 'content2');

			const hasEmitted = await manager.finalize();
			expect(hasEmitted).toBe(true);
		});

		it('should return true for non-incremental builds even when no files written', async () => {
			const manager = new FileManager();
			await manager.initialize();

			// Non-incremental (no cache) always returns true
			const hasEmitted = await manager.finalize();
			expect(hasEmitted).toBe(true);
		});

		it('should return false for incremental builds when no files written', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager = new FileManager(cache);
			await manager.initialize();

			// Incremental build with no files written should return false
			const hasEmitted = await manager.finalize();
			expect(hasEmitted).toBe(false);
		});

		it('should save cache when caching is enabled', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			// Write and save
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			let hasEmitted = await manager1.finalize();
			expect(hasEmitted).toBe(true);

			// Verify cache was saved by loading in new instance
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			const cached = manager2.getDeclarationFiles().get('test.d.ts') as CachedDeclaration;
			// Content is pre-processed: export const -> declare const + export {}
			expect(cached.code).toContain('declare const hello: string;');
			expect(cached.code).toContain('export { hello }');
		});

		it('should update cached files on subsequent emits', async () => {
			const tsBuildInfoFile = 'tsconfig.tsbuildinfo';
			await mkdir(join(tempDir, '.tsbuild'), defaultDirOptions);

			// First emit
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager1 = new FileManager(cache1);
			await manager1.initialize();
			manager1.fileWriter('test.d.ts', 'export const hello: string;');
			let hasEmitted = await manager1.finalize();
			expect(hasEmitted).toBe(true);

			// Second emit with updated content
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager2 = new FileManager(cache2);
			await manager2.initialize();
			manager2.fileWriter('test.d.ts', 'export const hello: number;');
			hasEmitted = await manager2.finalize();
			expect(hasEmitted).toBe(true);

			// Verify updated content
			const cache3 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const manager3 = new FileManager(cache3);
			await manager3.initialize();
			const cached = manager3.getDeclarationFiles().get('test.d.ts') as CachedDeclaration;
			// Content is pre-processed: export const -> declare const + export {}
			expect(cached.code).toContain('declare const hello: number;');
			expect(cached.code).toContain('export { hello }');
		});

		it('should handle early return when caching is disabled (saveCache branch)', async () => {
			const manager = new FileManager();

			await manager.initialize();
			manager.fileWriter('test.d.ts', 'content');

			// finalize calls saveCache which should early return
			const hasEmitted = await manager.finalize();
			expect(hasEmitted).toBe(true);
		});
	});

	describe('getFiles', () => {
		it('should return empty map initially', async () => {
			const manager = new FileManager();
			expect(manager.getDeclarationFiles().size).toBe(0);
		});

		it('should return all stored files', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('file1.d.ts', 'content1');
			manager.fileWriter('file2.d.ts', 'content2');

			const files = manager.getDeclarationFiles();
			expect(files.size).toBe(2);
			// Content is pre-processed and stored as CachedDeclaration
			const file1 = files.get('file1.d.ts') as CachedDeclaration;
			const file2 = files.get('file2.d.ts') as CachedDeclaration;
			expect(file1.code).toBe('content1');
			expect(file2.code).toBe('content2');
		});
	});

	describe('fileWriter (WriteFileCallback)', () => {
		it('should store declaration files in memory', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('test.d.ts', 'export const hello: string;');

			expect(manager.getDeclarationFiles().size).toBe(1);
			const cached = manager.getDeclarationFiles().get('test.d.ts') as CachedDeclaration;
			// Content is pre-processed: export const -> declare const + export {}
			expect(cached.code).toContain('declare const hello: string;');
			expect(cached.code).toContain('export { hello }');
		});

		it('should store all file types when caching is disabled', async () => {
			const manager = new FileManager();
			await manager.initialize();
			manager.fileWriter('test.js', 'console.log("hello")');
			manager.fileWriter('test.d.ts', 'export const hello: string;');
			manager.fileWriter('tsconfig.tsbuildinfo', '{}');

			expect(manager.getDeclarationFiles().size).toBe(3);
			expect(manager.getDeclarationFiles().has('test.js')).toBe(true);
			expect(manager.getDeclarationFiles().has('test.d.ts')).toBe(true);
			expect(manager.getDeclarationFiles().has('tsconfig.tsbuildinfo')).toBe(true);
		});
	});

	describe('writeFiles', () => {
		it('should return empty array when no files to write', async () => {
			const manager = new FileManager();
			const result = await manager.writeFiles(tempDir);
			expect(result).toEqual([]);
		});
	});

	describe('resolveEntryPoints', () => {
		it('should return index entry point when no dtsEntryPoints specified and index exists', () => {
			const manager = new FileManager();
			const projectEntryPoints = {
				index: './src/index.ts',
				main: './src/main.ts',
				utils: './src/utils.ts'
			};

			const result = manager.resolveEntryPoints(projectEntryPoints);

			expect(result).toEqual({ index: './src/index.ts' });
		});

		it('should return all entry points when no dtsEntryPoints specified and no index exists', () => {
			const manager = new FileManager();
			const projectEntryPoints = {
				main: './src/main.ts',
				utils: './src/utils.ts',
				helper: './src/helper.ts'
			};

			const result = manager.resolveEntryPoints(projectEntryPoints);

			expect(result).toEqual(projectEntryPoints);
		});

		it('should filter entry points when dtsEntryPoints array is provided', () => {
			const manager = new FileManager();
			const projectEntryPoints = {
				index: './src/index.ts',
				main: './src/main.ts',
				utils: './src/utils.ts',
				internal: './src/internal.ts'
			};
			const dtsEntryPoints = ['index', 'utils'];

			const result = manager.resolveEntryPoints(projectEntryPoints, dtsEntryPoints);

			expect(result).toEqual({
				index: './src/index.ts',
				utils: './src/utils.ts'
			});
		});

		it('should return empty object when dtsEntryPoints is provided but no matches found', () => {
			const manager = new FileManager();
			const projectEntryPoints = {
				index: './src/index.ts',
				main: './src/main.ts'
			};
			const dtsEntryPoints = ['nonexistent', 'other'];

			const result = manager.resolveEntryPoints(projectEntryPoints, dtsEntryPoints);

			expect(result).toEqual({});
		});

		it('should handle empty dtsEntryPoints array', () => {
			const manager = new FileManager();
			const projectEntryPoints = {
				index: './src/index.ts',
				main: './src/main.ts'
			};
			const dtsEntryPoints: string[] = [];

			const result = manager.resolveEntryPoints(projectEntryPoints, dtsEntryPoints);

			expect(result).toEqual({});
		});

		it('should handle single entry point in projectEntryPoints', () => {
			const manager = new FileManager();
			const projectEntryPoints = {
				index: './src/index.ts'
			};

			const result = manager.resolveEntryPoints(projectEntryPoints);

			expect(result).toEqual({ index: './src/index.ts' });
		});

		it('should handle partial matches in dtsEntryPoints', () => {
			const manager = new FileManager();
			const projectEntryPoints = {
				index: './src/index.ts',
				main: './src/main.ts',
				utils: './src/utils.ts'
			};
			const dtsEntryPoints = ['index', 'nonexistent'];

			const result = manager.resolveEntryPoints(projectEntryPoints, dtsEntryPoints);

			expect(result).toEqual({
				index: './src/index.ts'
			});
		});
	});

	describe('[Symbol.toStringTag]', () => {
		it('should return FileManager', () => {
			const manager = new FileManager();
			expect(manager.toString()).toBe('[object FileManager]');
			expect(Object.prototype.toString.call(manager)).toBe('[object FileManager]');
		});
	});
});
