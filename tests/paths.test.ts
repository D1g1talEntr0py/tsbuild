import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', async () => {
	const memfs = await import('memfs');
	return memfs.fs.promises;
});

import { vol } from 'memfs';
import { Paths } from 'src/paths';
import { resolve, relative, parse } from 'node:path';
import type { Path } from 'src/@types';

beforeEach(() => { vol.reset() });
afterEach(() => { vol.reset() });

describe('Paths', () => {
	it('cannot be instantiated', () => {
		expect(() => Reflect.construct(Paths, [])).toThrow('cannot be instantiated');
	});

	describe('Posix', () => {
		it('cannot be instantiated', () => {
			expect(() => new Paths.Posix()).toThrow('cannot be instantiated');
		});

		describe('relative', () => {
			it('computes a relative path using POSIX separators', () => {
				expect(Paths.Posix.relative('/data/orandea/test/aaa', '/data/orandea/impl/bbb')).toBe('../../impl/bbb');
			});

			it('returns an empty path for the same location', () => {
				expect(Paths.Posix.relative('/foo/bar', '/foo/bar')).toBe('');
			});
		});

		describe('normalize', () => {
			it('removes redundant separators and resolves dot segments', () => {
				expect(Paths.Posix.normalize('/foo//bar/../baz/.')).toBe('/foo/baz');
			});

			it('normalizes relative paths', () => {
				expect(Paths.Posix.normalize('foo/../bar')).toBe('bar');
			});
		});

		describe('directoryName', () => {
			it('returns the parent directory of a nested path', () => {
				expect(Paths.Posix.directoryName('/foo/bar/file.ts')).toBe('/foo/bar');
			});

			it('handles a trailing separator', () => {
				expect(Paths.Posix.directoryName('/foo/bar/')).toBe('/foo');
			});

			it('returns the current directory for a filename without a parent', () => {
				expect(Paths.Posix.directoryName('file.ts')).toBe('.');
			});
		});
	});

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

	describe('normalize', () => {
		it('returns absolute paths as-is', () => {
			expect(Paths.normalize('/absolute/path' as Path)).toBe('/absolute/path');
		});

		it('returns file:// URLs converted to a plain filesystem path', () => {
			expect(Paths.normalize('file:///absolute/path' as Path)).toBe('/absolute/path');
		});

		it('decodes encoded characters in file:// URLs', () => {
			expect(Paths.normalize('file:///absolute/path%20with%20spaces' as Path)).toBe('/absolute/path with spaces');
		});

		it('resolves the pathname of a non-file URL', () => {
			expect(Paths.normalize('https://example.com/some/path' as Path)).toBe('/some/path');
		});

		it('throws a TypeError for relative non-URL paths', () => {
			expect(() => Paths.normalize('relative/path' as Path)).toThrow(new TypeError('Paths.normalize requires an absolute path, got: relative/path'));
		});
	});

	describe('canonical', () => {
		it('resolves existing symlink ancestors for a non-existent target', async () => {
			vol.mkdirSync('/protected', { recursive: true });
			vol.symlinkSync('/protected', '/alias');

			expect(await Paths.canonical('/alias/new/output')).toBe('/protected/new/output');
		});

		it('preserves ordinary non-existent paths', async () => {
			expect(await Paths.canonical('/new/output')).toBe('/new/output');
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
			['lodash',    false],
			['@types/node', false],
			['fs',        false],
			['node:fs',   false],
			['esbuild',   false],
			['',          false],
			['.ts',       false],
			['..foo',     false],
		];

		it.each(pathMatrix)('"%s" → %s', (input, expected) => {
			expect(Paths.isPath(input)).toBe(expected);
		});
	});

	describe('getType', () => {
		it.each<[string, 'file' | 'directory' | undefined]>([
			[ '/test/file.txt', 'file' ],
			[ '/test', 'directory' ],
			[ '/missing', undefined ],
			[ '/file-link', undefined ],
			[ '/directory-link', undefined ],
			[ '/broken-link', undefined ],
		])('classifies %s as %s with one filesystem lookup', async (path, expected) => {
			vol.fromJSON({ '/test/file.txt': 'content' });
			vol.symlinkSync('/test/file.txt', '/file-link');
			vol.symlinkSync('/test', '/directory-link');
			vol.symlinkSync('/missing', '/broken-link');
			const fsp = await import('node:fs/promises');
			const lstatSpy = vi.spyOn(fsp, 'lstat');

			try {
				expect(await Paths.getType(path)).toBe(expected);
				expect(lstatSpy).toHaveBeenCalledExactlyOnceWith(path);
			} finally {
				lstatSpy.mockRestore();
			}
		});

		it('re-throws non-ENOENT errors', async () => {
			const fsp = await import('node:fs/promises');
			const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
			const lstatSpy = vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(error);

			try {
				await expect(Paths.getType('/any-path')).rejects.toBe(error);
			} finally {
				lstatSpy.mockRestore();
			}
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
