import { dirname, join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { defaultCleanOptions, defaultDirOptions, Encoding, FileExtension } from './constants';
import { brotliDecompress, brotliCompress, constants as brotliConstants } from 'node:zlib';
import { Paths } from './paths';
import { fileURLToPath } from 'node:url';
import { access, chmod, constants as fsConstants, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { LanguageVariant, ScriptTarget, SyntaxKind, createScanner } from 'typescript';
import type { WriteFileOptions } from 'node:fs';
import type { AbsolutePath, Path, WrittenFile } from './@types';

type WritableData = string | NodeJS.ArrayBufferView | Iterable<string | NodeJS.ArrayBufferView> | AsyncIterable<string | NodeJS.ArrayBufferView>;
type WriteEntry = { path: AbsolutePath | string; data: WritableData; options?: WriteFileOptions; size?: number };

const removalBatchSize = 32;
const writeBatchSize = 32;
const windowsDrivePathRegex = /^[A-Za-z]:[\\/]/;
const makeDirMapper = (directory: string) => mkdir(directory, defaultDirOptions);

/**
 * A class for handling file operations such as reading, writing, compressing, and decompressing files.
 */
export class Files {
	private constructor() { /* Static class - no instantiation */ }

	/**
	 * Check if a file exists.
	 * @param filePath The path to the file.
	 */
	static async exists(filePath: Path | string): Promise<boolean> {
		try {
			await access(filePath, fsConstants.F_OK);
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
	 * Uses readdir + parallel rm so libuv's thread pool can unlink subtrees concurrently,
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

		// Keep removal concurrency bounded to avoid thread pool thrash on very large trees.
		for (let i = 0, length = entries.length; i < length; i += removalBatchSize) {
			const batch = entries.slice(i, i + removalBatchSize);
			await Promise.all(batch.map((entry) => rm(join(directory, entry), defaultCleanOptions)));
		}
	}

	/**
	 * Write data to a file.
	 * Ensures the directory exists before writing.
	 * @param filePath The path to the file.
	 * @param data The data to write to the file.
	 * @param options Optional write file options.
	 */
	static async write(filePath: Path | string, data: WritableData, options: WriteFileOptions = { encoding: Encoding.utf8 }): Promise<void> {
		await mkdir(dirname(filePath), defaultDirOptions);

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
		const directories = new Set<string>();

		for (const { path, data, size } of entries) {
			writtenFiles.push({ path: Paths.relative(projectDirectory, path), size: Files.#resolveFileSize(data, size) });
			directories.add(dirname(path));
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
	 * Rewrites extension-less relative import/export/dynamic-import specifiers to include `.js`.
	 * @param code The JavaScript output content to rewrite
	 */
	static rewriteRelativeSpecifiers(code: string): string {
		type Replacement = { start: number; end: number; content: string };

		const appendJsExtension = (specifier: string) => {
			const hashIndex = specifier.indexOf('#');
			const queryIndex = specifier.indexOf('?');
			let suffixStart = specifier.length;

			if (hashIndex !== -1) { suffixStart = Math.min(suffixStart, hashIndex) }
			if (queryIndex !== -1) { suffixStart = Math.min(suffixStart, queryIndex) }

			return `${specifier.slice(0, suffixStart)}${FileExtension.JS}${specifier.slice(suffixStart)}`;
		};

		const scanner = createScanner(ScriptTarget.Latest, true, LanguageVariant.Standard, code);

		const replacements: Replacement[] = [];
		const addSpecifierRewrite = (start: number, end: number, tokenText: string) => {
			const quote = tokenText[0];
			const specifier = tokenText.slice(1, -1);
			replacements.push({ start, end, content: `${quote}${appendJsExtension(specifier)}${quote}` });
		};

		let seenImportOrExport = false;
		let importOrExportDepth = 0;
		let expectSpecifierAfterFrom = false;
		let expectSideEffectImportSpecifier = false;
		let maybeDynamicImport = false;
		let expectDynamicImportSpecifier = false;

		for (let token = scanner.scan(); token !== SyntaxKind.EndOfFileToken; token = scanner.scan()) {
			switch (token) {
				case SyntaxKind.ImportKeyword: {
					seenImportOrExport = true;
					importOrExportDepth = 0;
					expectSpecifierAfterFrom = false;
					expectSideEffectImportSpecifier = true;
					maybeDynamicImport = true;
					expectDynamicImportSpecifier = false;
					break;
				}
				case SyntaxKind.ExportKeyword: {
					seenImportOrExport = true;
					importOrExportDepth = 0;
					expectSpecifierAfterFrom = false;
					expectSideEffectImportSpecifier = false;
					maybeDynamicImport = false;
					expectDynamicImportSpecifier = false;
					break;
				}
				case SyntaxKind.OpenParenToken: {
					if (maybeDynamicImport) {
						expectDynamicImportSpecifier = true;
						maybeDynamicImport = false;
					}
					if (seenImportOrExport) { importOrExportDepth += 1 }
					break;
				}
				case SyntaxKind.CloseParenToken: {
					if (seenImportOrExport && importOrExportDepth > 0) { importOrExportDepth -= 1 }
					break;
				}
				case SyntaxKind.FromKeyword: {
					if (seenImportOrExport) {
						expectSpecifierAfterFrom = true;
						expectSideEffectImportSpecifier = false;
					}
					break;
				}
				case SyntaxKind.StringLiteral:
				case SyntaxKind.NoSubstitutionTemplateLiteral: {
					if (expectDynamicImportSpecifier || expectSpecifierAfterFrom || expectSideEffectImportSpecifier) {
						addSpecifierRewrite(scanner.getTokenPos(), scanner.getTextPos(), scanner.getTokenText());
						expectDynamicImportSpecifier = false;
						expectSpecifierAfterFrom = false;
						expectSideEffectImportSpecifier = false;
					}
					break;
				}
				case SyntaxKind.SemicolonToken: {
					seenImportOrExport = false;
					importOrExportDepth = 0;
					expectSpecifierAfterFrom = false;
					expectSideEffectImportSpecifier = false;
					maybeDynamicImport = false;
					expectDynamicImportSpecifier = false;
					break;
				}
				case SyntaxKind.OpenBraceToken:
				case SyntaxKind.OpenBracketToken:
				case SyntaxKind.LessThanToken:
				case SyntaxKind.Identifier:
				case SyntaxKind.AsteriskToken:
				case SyntaxKind.TypeKeyword:
				case SyntaxKind.DefaultKeyword:
				case SyntaxKind.AsKeyword: {
					maybeDynamicImport = false;
					break;
				}
				default: break;
			}

			if (seenImportOrExport && importOrExportDepth === 0 && token === SyntaxKind.CloseBraceToken) {
				// End `import { ... }` / `export { ... }` clause where semicolon may be omitted.
				expectSideEffectImportSpecifier = false;
			}
		}

		if (replacements.length === 0) { return code }

		// Single forward pass; repeated slice-and-concat is O(n * replacements) on large bundles.
		replacements.sort((left, right) => left.start - right.start);

		let cursor = 0;
		const segments: string[] = [];
		for (const { start, content, end } of replacements) {
			segments.push(code.slice(cursor, start), content);
			cursor = end;
		}

		segments.push(code.slice(cursor));

		return segments.join('');
	}

	/**
	 * Returns true when JavaScript output begins with a shebang line.
	 * @param output JavaScript output text to inspect
	 */
	static hasShebang(output: string | Uint8Array): boolean {
		if (output.length < 2) { return false }

		return typeof output === 'string' ? output.charCodeAt(0) === 0x23 && output.charCodeAt(1) === 0x21 : output[0] === 0x23 && output[1] === 0x21;
	}

	/**
	 * Change mode bits on a file.
	 * @param filePath The file path.
	 * @param mode Numeric mode bits (e.g. `0o755`).
	 */
	static async chmod(filePath: Path | string, mode: number): Promise<void> {
		return chmod(filePath, mode);
	}

	/**
	 * Load a file and return its contents as a string.
	 * @param filePath The path to the file.
	 * @param encoding The encoding to use when reading the file. Default is UTF-8.
	 * @returns The file contents as a string.
	 */
	static async read<T extends string | Buffer = string>(filePath: Path, encoding: BufferEncoding = Encoding.utf8): Promise<T> {
		return readFile(this.normalizePath(filePath), { encoding }) as Promise<T>;
	}

	/**
	 * Reads the contents of a directory.
	 * @param directoryPath The path to the directory.
	 * @returns An array of file and directory names within the specified directory.
	 */
	static async readDirectory(directoryPath: Path): Promise<string[]> {
		return readdir(directoryPath);
	}

	/**
	 * Normalize a file path to an absolute path.
	 * @param path The file path to normalize.
	 * @returns The normalized absolute path.
	 * @throws {TypeError} if path is relative and not a valid URL
	 */
	static normalizePath(path: Path): AbsolutePath {
		if (path.startsWith('file://')) { return fileURLToPath(path) as AbsolutePath }
		if (path.startsWith('/') || windowsDrivePathRegex.test(path)) { return path as AbsolutePath }
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
		const params: Record<number, number> = {
			[brotliConstants.BROTLI_PARAM_QUALITY]: 5
		};
		const sizeHintParam = brotliConstants.BROTLI_PARAM_SIZE_HINT;
		if (sizeHintParam !== undefined) { params[sizeHintParam] = buffer.length }

		return new Promise<Buffer>((resolve, reject) => brotliCompress(
			buffer,
			{ params },
			(error, result) => error ? reject(error) : resolve(result)
		));
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
		return writeFile(normalizedPath, await this.compressBuffer(serialize(data)));
	}

	/**
	 * Resolves the size of the data to be written to a file.
	 * @param data The data to be written.
	 * @param size Optional size of the data. If provided, it will be used directly.
	 * @returns The resolved size of the data.
	 */
	static #resolveFileSize(data: WritableData, size?: number): number {
		switch (true) {
			case size !== undefined: return size;
			case typeof data === 'string': return Buffer.byteLength(data);
			case ArrayBuffer.isView(data): return data.byteLength;
			default: return 0;
		}
	}
}