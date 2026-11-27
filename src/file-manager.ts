import { Files } from './files';
import { defaultEntryPoint } from './constants';
import { DeclarationProcessor } from './dts/declaration-processor';
import { ConfigurationError } from './errors';
import { parseSourceFiles } from './dts/source-file-batches';
import type { API } from 'typescript/sync';
import type { SourceText } from './dts/source-file-batches';
import type { AbsolutePath, CachedDeclaration, Closable, WrittenFile } from './@types';

const localFileIdentifier = /\.[a-z]+$/i;
const relativeSpecifierPattern = /((?:from|import)\s*['"])(\.\.?\/[^'"]*?)(['"])/g;

/**
 * Rewrites extension-less relative specifiers in declaration output to include `.js`.
 * @param code The declaration file content to rewrite.
 * @returns The content with `.js` appended to bare relative specifiers.
 */
function rewriteRelativeSpecifiers(code: string): string {
	return code.replace(relativeSpecifierPattern, (_, before: string, path: string, after: string) =>
		localFileIdentifier.test(path) ? before + path + after : `${before}${path}.js${after}`);
}

/**
 * Manages in-memory storage and preprocessing of TypeScript declaration output.
 *
 * This class provides a clean separation of concerns:
 * - In-memory storage of pre-processed declaration files
 * - Disk I/O for writing declaration files
 * - Entry point resolution for declaration bundling
 *
 * Emitted declarations arrive as plain text from {@link CompilationContext.compile} and are pre-processed in {@link FileManager.ingest}.
 * Declarations whose text is unchanged since the previous ingest reuse their pre-processed result.
 *
 * @example
 * ```typescript
 * const manager = new FileManager(api);
 * manager.ingest(context.compile().declarations);
 * ```
 */
export class FileManager implements Closable {
	readonly #declarationFiles = new Map<AbsolutePath, CachedDeclaration>();
	/** Raw emitted text of each stored declaration, used to skip re-processing unchanged output across watch rebuilds */
	readonly #emittedText = new Map<AbsolutePath, string>();
	readonly #api: API;

	/**
	 * Creates a new file manager.
	 * @param api - TypeScript API used to parse emitted declarations
	 */
	constructor(api: API) {
		this.#api = api;
	}

	/**
	 * Replaces stored declarations with exactly the emitted set, so declarations of deleted sources do not linger.
	 * Unchanged declaration text reuses the previous pre-processed result; changed text is parsed in bounded API batches.
	 * If parsing or pre-processing fails, the stored declarations are left unchanged and every parse lease is released.
	 * @param declarations - Emitted declaration text keyed by absolute output path
	 */
	ingest(declarations: ReadonlyMap<AbsolutePath, string>): void {
		const reused = new Map<AbsolutePath, CachedDeclaration>();
		const changed: SourceText[] = [];

		for (const [ path, text ] of declarations) {
			const cached = this.#declarationFiles.get(path);
			if (cached !== undefined && this.#emittedText.get(path) === text) {
				reused.set(path, cached);
			} else {
				changed.push([ path, text ]);
			}
		}

		// Parse changed declarations in bounded batches; stored state is only replaced once every declaration was processed
		const processed = parseSourceFiles(this.#api, changed, (sourceFile) => DeclarationProcessor.preProcess(sourceFile));

		this.#declarationFiles.clear();

		let index = 0;
		for (const [ path, text ] of declarations) {
			const cached = reused.get(path);
			if (cached !== undefined) {
				this.#declarationFiles.set(path, cached);
				continue;
			}

			this.#emittedText.set(path, text);

			const result = processed[index++];
			// Skip declarations with no meaningful content (e.g. CLI entry points with no exports)
			if (result.code.length > 0) { this.#declarationFiles.set(path, result) }
		}

		for (const path of this.#emittedText.keys()) {
			if (!declarations.has(path)) { this.#emittedText.delete(path) }
		}
	}

	/**
	 * Retrieves all stored declaration files.
	 * Files are already pre-processed and ready for bundling or writing to disk.
	 * This is a pure getter with no side effects.
	 *
	 * @returns A read-only map of file paths to their pre-processed content with extracted references
	 */
	getDeclarationFiles(): ReadonlyMap<AbsolutePath, CachedDeclaration> {
		return this.#declarationFiles;
	}

	/**
	 * Writes all stored declaration files to disk.
	 * Files are already pre-processed, so this just writes them directly.
	 *
	 * @param projectDirectory - Project root for calculating relative paths
	 * @returns Array of written file metadata
	 */
	async writeFiles(projectDirectory: AbsolutePath): Promise<WrittenFile[]> {
		if (this.#declarationFiles.size === 0) { return [] }

		const writeEntries: Array<{ path: AbsolutePath; data: string; size: number }> = [];
		for (const [ filePath, { code } ] of this.#declarationFiles) {
			// Skip writing empty declaration files
			if (code.length > 0) {
				const rewritten = rewriteRelativeSpecifiers(code);
				writeEntries.push({ path: filePath, data: rewritten, size: rewritten.length });
			}
		}

		return Files.writeFiles(projectDirectory, writeEntries);
	}

	/**
	 * Resolves entry points for declaration bundling.
	 * This is a utility method that filters project entry points based on DTS configuration.
	 *
	 * @param projectEntryPoints - All entry points from project configuration
	 * @param dtsEntryPoints - Optional list of entry point names to include for DTS bundling
	 * @returns Filtered entry points for declaration bundling
	 */
	resolveEntryPoints(projectEntryPoints: Record<string, AbsolutePath>, dtsEntryPoints?: string[]): Record<string, AbsolutePath> {
		// If no DTS entry points specified, use default entry point if it exists, otherwise use all
		if (!dtsEntryPoints) {
			return defaultEntryPoint in projectEntryPoints ? { [defaultEntryPoint]: projectEntryPoints[defaultEntryPoint] } : projectEntryPoints;
		}

		const isEntryPointUnknown = (name: string) => !Object.hasOwn(projectEntryPoints, name);
		const unknownEntryPoints = dtsEntryPoints.filter(isEntryPointUnknown);

		if (unknownEntryPoints.length > 0) {
			const validEntryPointNames = Object.keys(projectEntryPoints);
			throw new ConfigurationError(`Unknown dts.entryPoints: ${unknownEntryPoints.join(', ')}. Valid entry points: ${validEntryPointNames.length > 0 ? validEntryPointNames.join(', ') : '(none)'}.`);
		}

		const result: Record<string, AbsolutePath> = {};
		const allowedEntryPoints = new Set(dtsEntryPoints);

		// Filter to only the specified entry points
		for (const [ name, path ] of Object.entries(projectEntryPoints)) {
			if (allowedEntryPoints.has(name)) { result[name] = path }
		}

		return result;
	}

	/**
	 * Closes the file manager and releases resources.
	 * Clears all stored declaration files.
	 */
	close(): void {
		this.#declarationFiles.clear();
		this.#emittedText.clear();
	}


	/**
	 * Custom inspection method for better type representation.
	 * @returns The string 'FileManager'
	 */
	get [Symbol.toStringTag]() {
		return 'FileManager';
	}
}
