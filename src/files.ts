import { Paths } from './paths';
import { isErrnoException } from './errors';
import { defaultCleanOptions, defaultDirOptions, Encoding } from './constants';
import { access, chmod, constants as fsConstants, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { type TypeGuard, guard, TypeDefinition } from './type-definition';
import { type Dirent, type WriteFileOptions, existsSync } from 'node:fs';
import type { AbsolutePath, Path, RelativePath, WrittenFile } from './@types';

/** Options for {@link Files.readDirectory}. */
export type ReadDirectoryOptions = {
	/** Encoding of entry names. `'buffer'` returns names as `Buffer` objects. Default is `'utf8'`. */
	encoding?: BufferEncoding | 'buffer';
	/** Return `Dirent` objects instead of entry names. Default is `false`. */
	withFileTypes?: boolean;
	/** Include entries from all subdirectories. Default is `false`. */
	recursive?: boolean;
};

/** Entry name type of {@link Files.readDirectory}, inferred from the `encoding` option. */
type DirectoryEntryName<O extends ReadDirectoryOptions> = O['encoding'] extends 'buffer' ? Buffer<ArrayBuffer> : O['encoding'] extends BufferEncoding | undefined ? RelativePath : RelativePath | Buffer<ArrayBuffer>;

/** Result of {@link Files.readDirectory}, inferred from the `encoding` and `withFileTypes` options. */
export type DirectoryEntries<O extends ReadDirectoryOptions> = O['withFileTypes'] extends true ? Dirent<DirectoryEntryName<O>>[] : O['withFileTypes'] extends false | undefined ? DirectoryEntryName<O>[] : DirectoryEntryName<O>[] | Dirent<DirectoryEntryName<O>>[];

type WritableData = string | NodeJS.ArrayBufferView | Iterable<string | NodeJS.ArrayBufferView> | AsyncIterable<string | NodeJS.ArrayBufferView>;
type WriteEntry = { path: AbsolutePath; data: WritableData; options?: WriteFileOptions; size?: number };

const removalBatchSize = 32;
const writeBatchSize = 32;

/**
 * Creates a directory if it does not exist.
 * @param directory The path to the directory to create.
 */
const makeDirMapper = (directory: AbsolutePath) => mkdir(directory, defaultDirOptions);

/** A class for handling file operations such as reading, writing, compressing, and decompressing files. */
export class Files {
	private constructor() { throw new Error('Static class - no instantiation') }

	/**
	 * Check if a file exists.
	 * @param filePath Absolute filesystem path to the file.
	 */
	static async exists(filePath: Path): Promise<boolean> {
		try {
			await access(filePath, fsConstants.F_OK);
			return true;
		} catch (error) {
			// File does not exist - check for any error with ENOENT code
			if (isErrnoException(error) && error.code === 'ENOENT') { return false }
			// Other errors (e.g., permissions issues)
			throw error;
		}
	}

	/**
	 * Check if a file exists synchronously.
	 * @param path The path to the file.
	 */
	static existsSync: (path: Path) => boolean = existsSync;

	/**
	 * Clear a directory by removing all of its entries in parallel.
	 * Uses readdir + parallel rm so libuv's thread pool can unlink subtrees concurrently,
	 * which is significantly faster than a single recursive `rm` for large output trees.
	 * The directory itself is preserved (no mkdir needed afterward).
	 * @param directory The path to the directory to clear.
	 */
	static async empty(directory: Path): Promise<void> {
		let entries: RelativePath[];

		try { entries = await Files.readDirectory(directory) } catch (error) {
			// Directory doesn't exist - create it so callers can write into it
			if (isErrnoException(error) && error.code === 'ENOENT') {
				await mkdir(directory, defaultDirOptions);

				return;
			}

			throw error;
		}

		if (entries.length === 0) { return }

		const removalMapper = (entry: RelativePath) => rm(Paths.join(directory, entry), defaultCleanOptions);

		// Keep removal concurrency bounded to avoid thread pool thrash on very large trees.
		for (let i = 0, length = entries.length; i < length; i += removalBatchSize) {
			await Promise.all(entries.slice(i, i + removalBatchSize).map(removalMapper));
		}
	}

	/**
	 * Write data to a file.
	 * Ensures the directory exists before writing.
	 * @param filePath The path to the file.
	 * @param data The data to write to the file.
	 * @param options Optional write file options.
	 */
	static async write(filePath: Path, data: WritableData, options: WriteFileOptions = { encoding: Encoding.utf8 }): Promise<void> {
		await mkdir(Paths.directoryName(filePath), defaultDirOptions);

		return writeFile(filePath, data, options);
	}

	/**
	 * Write multiple files with bounded concurrency and return write metadata.
	 * Ensures each distinct target directory exists once before writing.
	 * The returned sizes use the provided entry `size` when available, otherwise they
	 * are inferred for strings/ArrayBufferView and default to 0 for iterables.
	 * @param projectDirectory Base directory for relative output paths.
	 * @param entries File write entries containing path/data/options.
	 * @returns Metadata for all written files.
	 */
	static async writeFiles(projectDirectory: AbsolutePath, entries: ReadonlyArray<WriteEntry>): Promise<WrittenFile[]> {
		if (entries.length === 0) { return [] }

		const writtenFiles: WrittenFile[] = [];
		const directories = new Set<AbsolutePath>();

		for (const { path, data, size } of entries) {
			writtenFiles.push({ path: Paths.relative(projectDirectory, path), size: Files.#resolveFileSize(data, size) });
			directories.add(Paths.directoryName(path));
		}

		const uniqueDirectories = Array.from(directories);

		for (let i = 0, length = uniqueDirectories.length; i < length; i += writeBatchSize) {
			await Promise.all(uniqueDirectories.slice(i, i + writeBatchSize).map(makeDirMapper));
		}

		for (let i = 0, length = entries.length; i < length; i += writeBatchSize) {
			const writes: Promise<void>[] = [];
			for (let j = i; j < Math.min(i + writeBatchSize, length); j++) {
				const { path, data, options } = entries[j];
				writes.push(writeFile(path, data, options ?? { encoding: Encoding.utf8 }));
			}
			await Promise.all(writes);
		}

		return writtenFiles;
	}

	/**
	 * Checks if the given array contains only WrittenFile objects.
	 * @param data The value to check.
	 * @returns True if all elements in the array are WrittenFile objects, false otherwise.
	 */
	static isWrittenFiles: TypeGuard<WrittenFile[]> = TypeDefinition.typeGuardOfArray({ path: guard(Paths.isRelativePath), size: Number });

	/**
	 * Returns true when JavaScript output begins with a shebang line.
	 * @param output JavaScript output text to inspect
	 */
	static hasShebang(output: string | Uint8Array): boolean {
		if (output.length < 2) { return false }

		// A shebang line starts with "#!" at the very beginning of the file. Comparing the character codes is faster than slicing the string.
		return typeof output === 'string' ? output.charCodeAt(0) === 0x23 && output.charCodeAt(1) === 0x21 : output[0] === 0x23 && output[1] === 0x21;
	}

	/**
	 * Change mode bits on a file.
	 * @param filePath The file path.
	 * @param mode Numeric mode bits (e.g. `0o755`).
	 */
	static chmod: (filePath: Path, mode: number) => Promise<void> = chmod;

	/**
	 * Load a file and return its contents as a string.
	 * @param filePath The path to the file.
	 * @param encoding The encoding to use when reading the file. Default is UTF-8.
	 * @returns The file contents as a string.
	 */
	static read<T extends string = string>(filePath: AbsolutePath, encoding: BufferEncoding = Encoding.utf8): Promise<T> {
		// Brand the result as T (e.g. JsonString<X>) — encoding is always set, so this always reads as a string
		return readFile(filePath, { encoding }) as Promise<T>;
	}

	/**
	 * Reads the contents of a directory.
	 * @param directoryPath The path to the directory.
	 * @param options The name encoding, whether to return `Dirent` objects, and whether to recurse into subdirectories.
	 * @returns Entry names, or `Dirent` objects when `withFileTypes` is `true`.
	 */
	static readDirectory<O extends ReadDirectoryOptions = { encoding?: BufferEncoding; withFileTypes?: false }>(directoryPath: Path, { encoding = Encoding.utf8, withFileTypes = false, recursive = false }: O = {} as O): Promise<DirectoryEntries<O>> {
		// readdir's overloads cannot accept runtime-variable options, and the conditional return type cannot be narrowed, so both are asserted
		return (readdir as (path: Path, options: Required<ReadDirectoryOptions>) => Promise<DirectoryEntries<ReadDirectoryOptions>>)(directoryPath, { encoding, withFileTypes, recursive }) as Promise<DirectoryEntries<O>>;
	}

	/**
	 * Resolves the size of the data to be written to a file.
	 * @param data The data to be written.
	 * @param size Optional size of the data. If provided, it will be used directly.
	 * @returns The resolved size of the data.
	 */
	static #resolveFileSize(data: WritableData, size?: number) {
		switch (true) {
			case size !== undefined: { return size }
			case typeof data === 'string': { return Buffer.byteLength(data) }
			case ArrayBuffer.isView(data): { return data.byteLength }
			default: { return 0 }
		}
	}
}