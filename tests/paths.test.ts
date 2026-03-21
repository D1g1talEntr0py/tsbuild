import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', async () => {
	const memfs = await import('memfs');
	return memfs.fs.promises;
});

import { vol } from 'memfs';
import { Paths } from 'src/paths';
import { resolve, relative, parse } from 'node:path';

beforeEach(() => { vol.reset() });
afterEach(() => { vol.reset() });

describe('Paths', () => {
	describe('absolute', () => {
		it('resolves a single path to absolute', () => {
			const result = Paths.absolute('/foo/bar');
			expect(result).toBe('/foo/bar');
		});

		it('joins multiple segments into absolute path', () => {
			const result = Paths.absolute('/foo', 'bar', 'baz');
			expect(result).toBe(resolve('/foo', 'bar', 'baz'));
		});

		it('resolves relative path against cwd', () => {
			const result = Paths.absolute('relative');
			expect(result).toBe(resolve('relative'));
		});
	});

	describe('relative', () => {
		it('computes relative path between two locations', () => {
			const result = Paths.relative('/foo/bar', '/foo/baz');
			expect(result).toBe(relative('/foo/bar', '/foo/baz'));
		});

		it('handles same directory', () => {
			expect(Paths.relative('/foo', '/foo')).toBe('');
		});
	});

	describe('parse', () => {
		it('parses a path into its components', () => {
			const result = Paths.parse('/home/user/file.ts');
			expect(result).toEqual(parse('/home/user/file.ts'));
			expect(result.base).toBe('file.ts');
			expect(result.ext).toBe('.ts');
			expect(result.name).toBe('file');
		});

		it('handles path without extension', () => {
			const result = Paths.parse('/home/user/file');
			expect(result.ext).toBe('');
			expect(result.name).toBe('file');
		});
	});

	describe('isPath', () => {
		const pathMatrix: [string, boolean][] = [
			['/',         true],
			['./',        true],
			['../',       true],
			['.',         true],
			['..',        true],
			['./foo',     true],
			['../foo',    true],
			['/foo/bar',  true],
			['C:/',       true],
			['C:\\foo',   true],
			['D:/bar',    true],
			['lodash',    false],
			['@types/node', false],
			['fs',        false],
			['node:fs',   false],
			['esbuild',   false],
			['',          false],
			['.ts',       false],
			['..foo',     false],
			['a:/test',   false],
		];

		it.each(pathMatrix)('"%s" → %s', (input, expected) => {
			expect(Paths.isPath(input)).toBe(expected);
		});
	});

	describe('isDirectory', () => {
		it('returns true for a directory', async () => {
			vol.mkdirSync('/test-dir', { recursive: true });
			expect(await Paths.isDirectory('/test-dir')).toBe(true);
		});

		it('returns false for a file', async () => {
			vol.mkdirSync('/parent', { recursive: true });
			vol.writeFileSync('/parent/file.txt', 'content');
			expect(await Paths.isDirectory('/parent/file.txt')).toBe(false);
		});

		it('returns false for non-existent path', async () => {
			expect(await Paths.isDirectory('/non-existent')).toBe(false);
		});

		it('re-throws non-ENOENT errors', async () => {
			const { lstat } = await import('node:fs/promises');
			const spy = vi.spyOn({ lstat }, 'lstat').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
			// Need to mock at module level
			const fsp = await import('node:fs/promises');
			const lstatSpy = vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
			await expect(Paths.isDirectory('/any-path')).rejects.toThrow('EACCES');
			lstatSpy.mockRestore();
			spy.mockRestore();
		});
	});

	describe('isFile', () => {
		it('returns true for a file', async () => {
			vol.mkdirSync('/parent', { recursive: true });
			vol.writeFileSync('/parent/file.txt', 'content');
			expect(await Paths.isFile('/parent/file.txt')).toBe(true);
		});

		it('returns false for a directory', async () => {
			vol.mkdirSync('/test-dir', { recursive: true });
			expect(await Paths.isFile('/test-dir')).toBe(false);
		});

		it('returns false for non-existent path', async () => {
			expect(await Paths.isFile('/non-existent')).toBe(false);
		});

		it('re-throws non-ENOENT errors', async () => {
			const fsp = await import('node:fs/promises');
			const lstatSpy = vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
			await expect(Paths.isFile('/any-path')).rejects.toThrow('EACCES');
			lstatSpy.mockRestore();
		});
	});

	describe('join', () => {
		it('joins path segments', () => {
			expect(Paths.join('/foo', 'bar', 'baz')).toBe('/foo/bar/baz');
		});

		it('normalizes redundant separators', () => {
			expect(Paths.join('/foo/', '/bar')).toBe('/foo/bar');
		});

		it('resolves parent references', () => {
			expect(Paths.join('/foo/bar', '..', 'baz')).toBe('/foo/baz');
		});
	});
});
