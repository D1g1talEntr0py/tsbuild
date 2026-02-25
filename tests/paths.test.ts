import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Paths } from '../src/paths';
import { resolve, relative, join } from 'node:path';
import { vol } from 'memfs';
import { TestHelper } from './scripts/test-helper';

vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

describe('Paths', () => {
	beforeEach(async () => {
		await TestHelper.setupMemfs();
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	describe('absolute', () => {
		it('should resolve to an absolute path', () => {
			const path = Paths.absolute('src', 'index.ts');
			expect(path).toBe(resolve('src', 'index.ts'));
		});

		it('should handle multiple segments', () => {
			const path = Paths.absolute('a', 'b', 'c');
			expect(path).toBe(resolve('a', 'b', 'c'));
		});
	});

	describe('relative', () => {
		it('should return relative path', () => {
			const from = '/a/b';
			const to = '/a/b/c/d';
			const path = Paths.relative(from, to);
			expect(path).toBe(relative(from, to));
		});
	});

	describe('join', () => {
		it('should join paths', () => {
			const path = Paths.join('a', 'b', 'c');
			expect(path).toBe(join('a', 'b', 'c'));
		});

		it('should handle absolute first segment', () => {
			const path = Paths.join('/a', 'b');
			expect(path).toBe(join('/a', 'b'));
		});
	});

	describe('isPath', () => {
		it('should return false for empty string', () => {
			expect(Paths.isPath('')).toBe(false);
		});

		it('should return true for absolute paths starting with /', () => {
			expect(Paths.isPath('/path/to/file')).toBe(true);
			expect(Paths.isPath('/file.ts')).toBe(true);
		});

		it('should return true for relative path "."', () => {
			expect(Paths.isPath('.')).toBe(true);
		});

		it('should return true for relative path ".."', () => {
			expect(Paths.isPath('..')).toBe(true);
		});

		it('should return true for paths starting with "./"', () => {
			expect(Paths.isPath('./file')).toBe(true);
			expect(Paths.isPath('./path/to/file')).toBe(true);
		});

		it('should return true for paths starting with "../"', () => {
			expect(Paths.isPath('../file')).toBe(true);
			expect(Paths.isPath('../path/to/file')).toBe(true);
		});

		it('should return true for Windows absolute paths', () => {
			expect(Paths.isPath('C:/path/to/file')).toBe(true);
			expect(Paths.isPath('C:\\path\\to\\file')).toBe(true);
			expect(Paths.isPath('D:/file')).toBe(true);
			expect(Paths.isPath('Z:\\file')).toBe(true);
		});

		it('should return false for bare specifiers (node modules)', () => {
			expect(Paths.isPath('lodash')).toBe(false);
			expect(Paths.isPath('react')).toBe(false);
			expect(Paths.isPath('@types/node')).toBe(false);
			expect(Paths.isPath('react/jsx-runtime')).toBe(false);
		});

		it('should return false for paths that start with dot but are not relative', () => {
			expect(Paths.isPath('.hidden')).toBe(false);
			expect(Paths.isPath('..something')).toBe(false);
		});

		it('should handle edge cases', () => {
			// Single characters
			expect(Paths.isPath('/')).toBe(true);
			// Lowercase drive letters are not Windows paths (only A-Z)
			expect(Paths.isPath('c:/file')).toBe(false);
			// Drive letter without proper separator
			expect(Paths.isPath('C:file')).toBe(false);
		});
	});

	describe('isDirectory', () => {
		it('should return true for an existing directory', async () => {
			vol.mkdirSync('/test-dir', { recursive: true });
			expect(await Paths.isDirectory('/test-dir')).toBe(true);
		});

		it('should return false for an existing file', async () => {
			vol.writeFileSync('/test-file.ts', 'content');
			expect(await Paths.isDirectory('/test-file.ts')).toBe(false);
		});

		it('should return false for a non-existent path', async () => {
			expect(await Paths.isDirectory('/non-existent')).toBe(false);
		});
	});

	describe('isFile', () => {
		it('should return true for an existing file', async () => {
			vol.writeFileSync('/test-file.ts', 'content');
			expect(await Paths.isFile('/test-file.ts')).toBe(true);
		});

		it('should return false for an existing directory', async () => {
			vol.mkdirSync('/test-dir', { recursive: true });
			expect(await Paths.isFile('/test-dir')).toBe(false);
		});

		it('should return false for a non-existent path', async () => {
			expect(await Paths.isFile('/non-existent')).toBe(false);
		});
	});
});
