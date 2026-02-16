import { vol } from 'memfs';
import { Files } from '../src/files';
import { defaultDirOptions, Encoding } from '../src/constants';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestHelper } from './scripts/test-helper';

// Mock node:fs and node:fs/promises with memfs
vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

describe('files', () => {
	beforeEach(async () => {
		await TestHelper.setupMemfs();
		// Create /test directory for tests
		vol.mkdirSync('/test', defaultDirOptions);
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	describe('fileExists', () => {
		it('should return true for existing files', async () => {
			vol.writeFileSync('/test/existing.txt', 'content');

			const result = await Files.exists('/test/existing.txt');
			expect(result).toBe(true);
		});

		it('should return true for existing directories', async () => {
			vol.mkdirSync('/test/dir', defaultDirOptions);
			vol.writeFileSync('/test/dir/file.txt', 'content');

			const result = await Files.exists('/test/dir');
			expect(result).toBe(true);
		});

		it('should return false for non-existent files', async () => {
			const result = await Files.exists('/test/nonexistent.txt');
			expect(result).toBe(false);
		});

		it('should return false for non-existent paths', async () => {
			const result = await Files.exists('/completely/nonexistent/path/file.txt');
			expect(result).toBe(false);
		});

	it('should handle nested directory checks', async () => {
		vol.mkdirSync('/test/deep/nested/dir', defaultDirOptions);
		vol.writeFileSync('/test/deep/nested/dir/file.txt', 'content');

		expect(await Files.exists('/test/deep')).toBe(true);
		expect(await Files.exists('/test/deep/nested')).toBe(true);
		expect(await Files.exists('/test/deep/nested/dir')).toBe(true);
		expect(await Files.exists('/test/deep/nested/dir/file.txt')).toBe(true);
		expect(await Files.exists('/test/deep/nonexistent')).toBe(false);
	});

	it('should throw non-ENOENT errors', async () => {
		// Mock access to throw a permission error
		const { fs } = await import('memfs');
		const originalAccess = fs.promises.access;
		const permError = new Error('Permission denied') as NodeJS.ErrnoException;
		permError.code = 'EACCES';

		vi.spyOn(fs.promises, 'access').mockRejectedValueOnce(permError);

		await expect(Files.exists('/test/file.txt')).rejects.toThrow('Permission denied');

		// Restore original
		fs.promises.access = originalAccess;
	});
});

	describe('read', () => {
		it('should read a file as string', async () => {
			vol.writeFileSync('/test/file.txt', 'hello world');
			const content = await Files.read('/test/file.txt');
			expect(content).toBe('hello world');
		});
	});

	describe('write', () => {
		it('should write a string to a file', async () => {
			await Files.write('/test/output.txt', 'hello world');
			expect(vol.readFileSync('/test/output.txt', 'utf8')).toBe('hello world');
		});
	});

	describe('normalizePath', () => {
		it('should return absolute paths as is', () => {
			expect(Files.normalizePath('/abs/path')).toBe('/abs/path');
		});

		it('should resolve relative paths', () => {
			// This depends on where the test is running, but we can check it returns an absolute path
			const normalized = Files.normalizePath('./rel/path');
			expect(normalized.startsWith('/')).toBe(true);
			expect(normalized).toContain('rel/path');
		});
	});
});