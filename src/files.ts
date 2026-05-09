import { dirname, join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { defaultCleanOptions, defaultDirOptions, Encoding } from 'src/constants';
import { brotliDecompress, brotliCompress } from 'node:zlib';
import { access, constants, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Stream } from 'node:stream';
import type { WriteFileOptions } from 'node:fs';
import type { AbsolutePath, Path } from 'src/@types';

type WritableData = string | NodeJS.ArrayBufferView | Iterable<string | NodeJS.ArrayBufferView> | AsyncIterable<string | NodeJS.ArrayBufferView> | Stream;

const windowsDrivePathRegex = /^[A-Za-z]:[\\/]/;

/**
 * A class for handling file operations such as reading, writing, compressing, and decompressing files.
 * @author D1g1talEntr0py (Jason DiMeo)
 */
export class Files {
	private constructor() { /* Static class - no instantiation */ }

	/**
	 * Check if a file exists.
	 * @param filePath The path to the file.
	 * @returns True if the file exists, false otherwise.
	 */
	static async exists(filePath: Path | string): Promise<boolean> {
		try {
			await access(filePath, constants.F_OK);
			return true;
		} catch (error) {
			// File does not exist - check for any error with ENOENT code
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return false }
			// Other errors (e.g., permissions issues)
			throw error;
		}
	}

	/**
	 * Clear a directory by removing all of its entries in parallel.
	 * Uses readdir + parallel rm so libuv's threadpool can unlink subtrees concurrently,
	 * which is significantly faster than a single recursive `rm` for large output trees.
	 * The directory itself is preserved (no mkdir needed afterward).
	 * @param directory The path to the directory to clear.
	 */
	static async empty(directory: Path | string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch (error) {
			// Directory doesn't exist - create it so callers can write into it
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				await mkdir(directory, defaultDirOptions);
				return;
			}
			throw error;
		}

		if (entries.length === 0) { return }

		const removals = new Array<Promise<void>>(entries.length);
		for (let i = 0, length = entries.length; i < length; i++) {
			removals[i] = rm(join(directory, entries[i]), defaultCleanOptions);
		}

		await Promise.all(removals);
	}

	/**
	 * Write data to a file.
	 * Ensures the directory exists before writing
	 * @param filePath The path to the file.
	 * @param data The data to write to the file.
	 * @param options Optional write file options.
	 */
	static async write(filePath: Path | string, data: WritableData, options: WriteFileOptions = { encoding: Encoding.utf8 }): Promise<void> {
		// Ensure the directory exists before writing
		await mkdir(dirname(filePath), defaultDirOptions);
		await writeFile(filePath, data, options);
	}

	/**
	 * Load a file and return its contents as a string.
	 * @param filePath The path to the file.
	 * @param encoding The encoding to use when reading the file. Default is UTF-8.
	 * @returns The file contents as a string.
	 */
	static async read<T extends string | Buffer = string>(filePath: Path, encoding: BufferEncoding = Encoding.utf8): Promise<T> {
		return await readFile(this.normalizePath(filePath), { encoding }) as T;
	}

	/**
	 * Reads the contents of a directory.
	 * @param directoryPath The path to the directory.
	 * @returns An array of file and directory names within the specified directory.
	 */
	static async readDirectory(directoryPath: Path): Promise<string[]> {
		return await readdir(directoryPath);
	}

	/**
	 * Normalize a file path to an absolute path.
	 * @param path The file path to normalize.
	 * @returns The normalized absolute path.
	 * @throws {TypeError} if path is relative and not a valid URL
	 */
	static normalizePath(path: Path): AbsolutePath {
		if (path.startsWith('/') || path.startsWith('file://') || windowsDrivePathRegex.test(path)) { return path as AbsolutePath }
		// Paths that don't start with /, file://, or a Windows drive letter must be valid URLs
		// or else they're invalid relative paths
		if (!path.includes('://')) { throw new TypeError(`Files.normalizePath requires an absolute path, got: ${path}`) }
		return new URL(path, import.meta.url).pathname as AbsolutePath;
	}

	/**
	 * Decompress a Brotli-compressed buffer.
	 * Uses callback-based API wrapped in a Promise for faster performance than streaming.
	 * @param buffer The compressed buffer to decompress.
	 * @returns The decompressed buffer.
	 */
	static decompressBuffer(buffer: Buffer): Promise<Buffer> {
		return new Promise<Buffer>((resolve, reject) => brotliDecompress(buffer, (error, result) => error ? reject(error) : resolve(result)));
	}

	/**
	 * Compress data using Brotli compression.
	 * Uses callback-based API wrapped in a Promise for faster performance than streaming.
	 * @param buffer The buffer to compress.
	 * @returns The compressed buffer.
	 */
	static compressBuffer(buffer: Buffer): Promise<Buffer> {
		return new Promise<Buffer>((resolve, reject) => brotliCompress(buffer, (error, result) => error ? reject(error) : resolve(result)));
	}

	/**
	 * Load a file and deserialize it using V8 deserialization.
	 * Faster than JSON.parse for complex objects.
	 * @param path The path to the file.
	 * @returns The deserialized object.
	 */
	static async readCompressed<T = unknown>(path: Path): Promise<T> {
		return deserialize(await this.decompressBuffer(await readFile(this.normalizePath(path)))) as T;
	}

	/**
	 * Serialize an object using V8 serialization and save to a Brotli-compressed file.
	 * Faster than JSON.stringify for complex objects.
	 * @param path The path to the file.
	 * @param data The object to serialize and save.
	 */
	static async writeCompressed<T>(path: Path, data: T): Promise<void> {
		const normalizedPath = this.normalizePath(path);
		await mkdir(dirname(normalizedPath), defaultDirOptions);
		await writeFile(normalizedPath, await this.compressBuffer(serialize(data)));
	}
}