import { vol } from 'memfs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncrementalBuildCache } from '../src/incremental-build-cache';
import { writeFile, mkdir, utimes } from 'node:fs/promises';
import { defaultDirOptions, dtsCacheFile } from '../src/constants';
import { TestHelper } from './scripts/test-helper';
import type { AbsolutePath, CachedDeclaration } from '../src/@types';

// Helper to create a simple CachedDeclaration from code
const createDecl = (code: string): CachedDeclaration => ({
	code,
	typeReferences: new Set(),
	fileReferences: new Set()
});

// Mock node:fs and node:fs/promises with memfs
vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

describe('BuildCache', () => {
	const tempDir = '/test' as AbsolutePath;
	const tsBuildInfoFile = 'tsconfig.tsbuildinfo';

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		vol.mkdirSync(tempDir, defaultDirOptions);
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	describe('cache restoration', () => {
		it('should restore cache successfully', async () => {
			const cacheDir = join(tempDir, '.tsbuild');
			await mkdir(cacheDir, defaultDirOptions);

			// Save cache first
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const testData = new Map([['test.d.ts', createDecl('export const value: string;')]]);
			await cache1.save(testData);

			// Create new instance to read saved cache
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);

			expect(target.size).toBe(1);
			expect(target.get('test.d.ts')?.code).toBe('export const value: string;');
		});

		it('should always restore cache regardless of timestamps (TypeScript handles staleness)', async () => {
			const cacheDir = join(tempDir, '.tsbuild');
			const buildInfoPath = join(tempDir, tsBuildInfoFile);

			await mkdir(cacheDir, defaultDirOptions);

			// Save cache
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const testData = new Map([['test.d.ts', createDecl('export const value: string;')]]);
			await cache1.save(testData);

			// Set old timestamp on cache file
			const oldTime = new Date('2024-01-01');
			const cachePath = join(cacheDir, dtsCacheFile);
			await utimes(cachePath, oldTime, oldTime);

			// Create .tsbuildinfo with newer timestamp
			await writeFile(buildInfoPath, '{"version":"5.0"}');

			// Create new cache instance - should still restore regardless of timestamps
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);

			expect(target.size).toBe(1);
			expect(target.get('test.d.ts')?.code).toBe('export const value: string;');
		});

		it('should restore cache even when .tsbuildinfo does not exist', async () => {
			const cacheDir = join(tempDir, '.tsbuild');
			await mkdir(cacheDir, defaultDirOptions);

			// Save cache without .tsbuildinfo (simulating first build after clean)
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const testData = new Map([['test.d.ts', createDecl('export const value: string;')]]);
			await cache1.save(testData);

			// Create new instance to restore
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);

			expect(target.size).toBe(1);
			expect(target.get('test.d.ts')?.code).toBe('export const value: string;');
		});

		it('should not restore cache when cache file does not exist', async () => {
			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);

			// No cache file exists
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);

			expect(target.size).toBe(0);
		});

		it('should restore cache with multiple files', async () => {
			const cacheDir = join(tempDir, '.tsbuild');
			await mkdir(cacheDir, defaultDirOptions);

			// Save cache with multiple files
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const testData = new Map([
				['file1.d.ts', createDecl('export const a: number;')],
				['file2.d.ts', createDecl('export interface B {}')],
				['file3.d.ts', createDecl('export type C = string;')]
			]);
			await cache1.save(testData);

			// Create new instance to restore
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);

			expect(target.size).toBe(3);
			expect(target.get('file1.d.ts')?.code).toBe('export const a: number;');
			expect(target.get('file2.d.ts')?.code).toBe('export interface B {}');
			expect(target.get('file3.d.ts')?.code).toBe('export type C = string;');
		});

		it('should handle corrupted cache file gracefully', async () => {
			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const cacheDir = join(tempDir, '.tsbuild');
			const buildInfoPath = join(tempDir, tsBuildInfoFile);

			await mkdir(cacheDir, defaultDirOptions);

			// Create .tsbuildinfo
			await writeFile(buildInfoPath, '{"version":"5.0"}');

			// Create corrupted cache file
			await writeFile(join(cacheDir, dtsCacheFile), 'invalid brotli data');

			// Restore should fail silently
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);

			expect(target.size).toBe(0);
		});

		it('should reject cache with incompatible version', async () => {
			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const cacheDir = join(tempDir, '.tsbuild');

			await mkdir(cacheDir, defaultDirOptions);

			// Create cache with old version format using V8 serialization (no version field)
			const { serialize } = await import('node:v8');
			const { brotliCompressSync } = await import('node:zlib');
			const oldFormatCache = { 'test.d.ts': 'export const value: string;' };
			const serialized = serialize(oldFormatCache);
			const compressed = brotliCompressSync(serialized);
			await writeFile(join(cacheDir, dtsCacheFile), compressed);

			// Restore should fail silently due to missing version
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);

			expect(target.size).toBe(0);
		});

		it('should reject cache with outdated version number', async () => {
			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const cacheDir = join(tempDir, '.tsbuild');

			await mkdir(cacheDir, defaultDirOptions);

			// Create cache with outdated version number using V8 serialization
			const { serialize } = await import('node:v8');
			const { brotliCompressSync } = await import('node:zlib');
			const outdatedCache = { version: 1, files: { 'test.d.ts': 'export const value: string;' } };
			const serialized = serialize(outdatedCache);
			const compressed = brotliCompressSync(serialized);
			await writeFile(join(cacheDir, dtsCacheFile), compressed);

			// Restore should fail silently due to outdated version
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);

			expect(target.size).toBe(0);
		});
	});

	describe('isBuildInfoFile', () => {
		it('should correctly identify build info file', () => {
			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const buildInfoPath = join(tempDir, tsBuildInfoFile) as AbsolutePath;

			expect(cache.isBuildInfoFile(buildInfoPath)).toBe(true);
			expect(cache.isBuildInfoFile('/other/path/file.ts' as AbsolutePath)).toBe(false);
		});
	});

	describe('save', () => {
		it('should save declaration files to compressed cache', async () => {
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const testData = new Map([
				['file1.d.ts', createDecl('export const a: number;')],
				['file2.d.ts', createDecl('export interface B {}')]
			]);

			await cache1.save(testData);

			// Verify cache file was created
			const cacheDir = join(tempDir, '.tsbuild');
			const cachePath = join(cacheDir, dtsCacheFile);
			expect(vol.existsSync(cachePath)).toBe(true);

			// Create new instance to verify we can restore it
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);

			expect(target.size).toBe(2);
			expect(target.get('file1.d.ts')?.code).toBe('export const a: number;');
			expect(target.get('file2.d.ts')?.code).toBe('export interface B {}');
		});

		it('should overwrite existing cache file', async () => {
			// Save first version
			const cache1 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			await cache1.save(new Map([['test.d.ts', createDecl('old content')]]));

			// Save second version
			const cache2 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			await cache2.save(new Map([['test.d.ts', createDecl('new content')]]));

			// Create new instance to verify new content
			const cache3 = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache3.restore(target);

			expect(target.get('test.d.ts')?.code).toBe('new content');
		});
	});

	describe('toStringTag', () => {
		it('should return correct string tag', () => {
			const cache = new IncrementalBuildCache(tempDir, tsBuildInfoFile);
			expect(Object.prototype.toString.call(cache)).toBe('[object IncrementalBuildCache]');
		});
	});
});
