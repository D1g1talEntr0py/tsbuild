import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', async () => {
	const memfs = await import('memfs');
	return memfs.fs.promises;
});

import { vol } from 'memfs';
import { Files } from 'src/files';
import type { AbsolutePath, Path } from 'src/@types';

beforeEach(() => { vol.reset() });
afterEach(() => { vol.reset() });

describe('Files', () => {
	describe('exists', () => {
		it('returns true for an existing file', async () => {
			vol.mkdirSync('/test', { recursive: true });
			vol.writeFileSync('/test/file.txt', 'content');
			expect(await Files.exists('/test/file.txt' as Path)).toBe(true);
		});

		it('returns true for an existing directory', async () => {
			vol.mkdirSync('/test/dir', { recursive: true });
			expect(await Files.exists('/test/dir' as Path)).toBe(true);
		});

		it('returns false for non-existent path', async () => {
			expect(await Files.exists('/non-existent' as Path)).toBe(false);
		});

		it('returns true for nested paths', async () => {
			vol.mkdirSync('/a/b/c', { recursive: true });
			vol.writeFileSync('/a/b/c/file.txt', 'content');
			expect(await Files.exists('/a/b/c/file.txt' as Path)).toBe(true);
		});

		it('re-throws non-ENOENT errors', async () => {
			const fsp = await import('node:fs/promises');
			const accessSpy = vi.spyOn(fsp, 'access').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
			await expect(Files.exists('/any' as Path)).rejects.toThrow('EACCES');
			accessSpy.mockRestore();
		});
	});

	describe('empty', () => {
		it('removes all files in a directory', async () => {
			vol.fromJSON({
				'/dir/file1.txt': 'a',
				'/dir/file2.txt': 'b',
				'/dir/sub/file3.txt': 'c',
			});
			await Files.empty('/dir' as Path);
			const remaining = vol.readdirSync('/dir');
			expect(remaining).toHaveLength(0);
		});

		it('does nothing if directory does not exist', async () => {
			await expect(Files.empty('/non-existent' as Path)).resolves.toBeUndefined();
		});

		it('creates the directory when it does not exist', async () => {
			await Files.empty('/fresh-dir' as Path);
			expect(vol.existsSync('/fresh-dir')).toBe(true);
		});

		it('returns early for an already empty directory', async () => {
			vol.mkdirSync('/empty-dir', { recursive: true });
			await expect(Files.empty('/empty-dir' as Path)).resolves.toBeUndefined();
			expect(vol.existsSync('/empty-dir')).toBe(true);
		});

		it('re-throws non-ENOENT errors from readdir', async () => {
			const fsp = await import('node:fs/promises');
			const readdirSpy = vi.spyOn(fsp, 'readdir').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
			await expect(Files.empty('/any' as Path)).rejects.toThrow('EACCES');
			readdirSpy.mockRestore();
		});
	});

	describe('write', () => {
		it('writes data to a file', async () => {
			vol.mkdirSync('/output', { recursive: true });
			await Files.write('/output/file.txt' as Path, 'hello world');
			expect(vol.readFileSync('/output/file.txt', 'utf8')).toBe('hello world');
		});

		it('creates parent directories if they do not exist', async () => {
			vol.mkdirSync('/', { recursive: true });
			await Files.write('/deep/nested/dir/file.txt' as Path, 'data');
			expect(vol.readFileSync('/deep/nested/dir/file.txt', 'utf8')).toBe('data');
		});
	});

	describe('read', () => {
		it('reads file contents as string', async () => {
			vol.fromJSON({ '/test/file.txt': 'hello world' });
			const result = await Files.read('/test/file.txt' as AbsolutePath);
			expect(result).toBe('hello world');
		});
	});

	describe('readDirectory', () => {
		it('lists directory contents', async () => {
			vol.fromJSON({
				'/dir/a.txt': 'a',
				'/dir/b.txt': 'b',
				'/dir/c.txt': 'c',
			});
			const result = await Files.readDirectory('/dir' as AbsolutePath);
			expect(result.sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
		});
	});

	describe('normalizePath', () => {
		it('returns absolute paths as-is', () => {
			expect(Files.normalizePath('/absolute/path' as Path)).toBe('/absolute/path');
		});

		it('returns file:// URIs as-is', () => {
			expect(Files.normalizePath('file:///absolute/path' as Path)).toBe('file:///absolute/path');
		});

		it('resolves the pathname of a non-file URL', () => {
			expect(Files.normalizePath('https://example.com/some/path' as Path)).toBe('/some/path');
		});

		it('throws a TypeError for relative non-URL paths', () => {
			expect(() => Files.normalizePath('relative/path' as Path)).toThrow(TypeError);
		});
	});

	describe('compressBuffer / decompressBuffer', () => {
		it('round-trips Brotli compression', async () => {
			const original = Buffer.from('Hello, Brotli compression test! '.repeat(100));
			const compressed = await Files.compressBuffer(original);
			expect(compressed.length).toBeLessThan(original.length);
			const decompressed = await Files.decompressBuffer(compressed);
			expect(decompressed).toEqual(original);
		});

		it('handles empty buffer', async () => {
			const original = Buffer.from('');
			const compressed = await Files.compressBuffer(original);
			const decompressed = await Files.decompressBuffer(compressed);
			expect(decompressed).toEqual(original);
		});
	});

	describe('readCompressed / writeCompressed', () => {
		it('round-trips V8 serialized + Brotli compressed data', async () => {
			vol.mkdirSync('/cache', { recursive: true });
			const data = { version: 2, files: { 'a.d.ts': { code: 'declare const a: string;' } } };
			await Files.writeCompressed('/cache/data.br' as AbsolutePath, data);
			const result = await Files.readCompressed<typeof data>('/cache/data.br' as AbsolutePath);
			expect(result).toEqual(data);
		});

		it('creates parent directories for writeCompressed', async () => {
			vol.mkdirSync('/', { recursive: true });
			await Files.writeCompressed('/deep/nested/cache.br' as AbsolutePath, { test: true });
			expect(vol.existsSync('/deep/nested/cache.br')).toBe(true);
		});
	});
});
