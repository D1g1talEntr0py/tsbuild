import { Files } from './files';
import { alwaysUndefined, defaultEntryPoint } from './constants';
import { DeclarationProcessor } from './dts/declaration-processor';
import { ConfigurationError } from './errors';
import { parseSourceFiles } from './dts/source-file-batches';
import type { API } from 'typescript/sync';
import type { SourceText } from './dts/source-file-batches';
import type { AbsolutePath, BuildCacheManager, BuildInputManifest, CachedDeclaration, Closable, WrittenFile } from './@types';

const noop = (): void => { /* no-op */ };
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
 * Manages in-memory storage and caching of TypeScript declaration output.
 *
 * This class provides a clean separation of concerns:
 * - In-memory storage of pre-processed declaration files
 * - Optional persistent caching for incremental builds, including the compiler input manifest
 * - Disk I/O for writing declaration files
 * - Entry point resolution for declaration bundling
 *
 * Emitted declarations arrive as plain text from {@link CompilationContext.compile} and are pre-processed in {@link FileManager.ingest}.
 * Declarations whose text is unchanged since the previous ingest reuse their pre-processed result.
 *
 * @example
 * ```typescript
 * const manager = new FileManager(api, buildCache);
 * await manager.initialize();
 * if (await buildCache.isUpToDate(context.manifestKey)) { await manager.restore() } else { manager.ingest(context.compile().declarations) }
 * const hasEmitted = manager.finalize();
 * ```
 */
export class FileManager implements Closable, AsyncDisposable {
	#hasEmittedFiles: boolean = false;
	/** Manifest of the last error-free compilation, persisted with the declarations */
	#manifest: BuildInputManifest | undefined;
	/** Background cache save promise — awaited before a later build or async disposal */
	#pendingSave: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;
	readonly #declarationFiles = new Map<AbsolutePath, CachedDeclaration>();
	/** Raw emitted text of each stored declaration, used to skip re-processing unchanged output across watch rebuilds */
	readonly #emittedText = new Map<AbsolutePath, string>();
	readonly #api: API;
	readonly #cache: BuildCacheManager | undefined;

	/**
	 * Creates a new file manager.
	 * @param api - TypeScript API used to parse emitted declarations
	 * @param buildCache - Optional build cache for incremental builds
	 */
	constructor(api: API, buildCache?: BuildCacheManager) {
		this.#api = api;
		this.#cache = buildCache;
	}

	/**
	 * Prepares the manager for a new build by waiting for any in-flight cache save and resetting emit state.
	 */
	async initialize(): Promise<void> {
		// Ensure any in-flight cache save from the previous build completes before the next one reads or replaces declarations
		if (this.#pendingSave) { await this.#pendingSave; this.#pendingSave = undefined }

		this.#hasEmittedFiles = false;
	}

	/**
	 * Restores pre-processed declarations from the persistent cache, for builds whose compiler inputs are unchanged.
	 */
	async restore(): Promise<void> {
		if (this.#cache === undefined || this.#declarationFiles.size > 0) { return }

		await this.#cache.restore(this.#declarationFiles);
	}

	/**
	 * Replaces stored declarations with exactly the emitted set, so declarations of deleted sources do not linger.
	 * Unchanged declaration text reuses the previous pre-processed result; changed text is parsed in bounded API batches.
	 * If parsing or pre-processing fails, the stored declarations are left unchanged and every parse lease is released.
	 * @param declarations - Emitted declaration text keyed by absolute output path
	 * @param manifest - Input manifest of the compilation, when it was error-free
	 */
	ingest(declarations: ReadonlyMap<AbsolutePath, string>, manifest?: BuildInputManifest): void {
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

		this.#hasEmittedFiles = true;
		this.#manifest = manifest;
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
	 * Reports whether the compiler ran this build, which means outputs may have changed.
	 * Cache persistence is deferred to {@link persistCache} so Brotli compression does not compete with esbuild.
	 * @returns True if the compiler ran (or there is no cache), false when the cached build was reused
	 */
	finalize(): boolean {
		return this.#cache === undefined || this.#hasEmittedFiles;
	}

	/**
	 * Persists the dts cache to disk in the background. Call this
	 * AFTER the build's parallel phases (transpile + dts bundling) have completed so the writes
	 * (and Brotli compression for the dts cache) don't compete with esbuild for libuv thread pool slots.
	 * @param fingerprint Build configuration fingerprint for cache invalidation on config change
	 * @param configChanged True when the build configuration fingerprint changed — forces the new
	 *   fingerprint to be saved even when TypeScript did not re-emit any files, preventing the
	 *   mismatch from triggering unnecessary forced rebuilds on every subsequent build.
	 */
	persistCache(fingerprint: string, configChanged = false): void {
		if (this.#cache === undefined || !(this.#hasEmittedFiles || configChanged)) { return }

		// When the compiler did not run, the cache keeps its current manifest
		const save = this.#hasEmittedFiles ? this.#cache.save(this.#declarationFiles, fingerprint, this.#manifest) : this.#cache.save(this.#declarationFiles, fingerprint);
		void save.catch(noop);

		const pendingSave = this.#pendingSave === undefined ? save : Promise.all([ this.#pendingSave, save ]).then(alwaysUndefined);
		void pendingSave.catch(noop);

		this.#pendingSave = pendingSave;
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
		// ProcessManager calls close() synchronously, so pending saves are best-effort on that fallback path.
		this.#pendingSave?.catch(noop);
		this.#pendingSave = undefined;
		this.#manifest = undefined;
		this.#declarationFiles.clear();
		this.#emittedText.clear();
	}

	/** Waits for pending cache writes before releasing declaration buffers. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.#disposePromise ??= this.flush().finally(() => this.close());
	}

	/**
	 * Awaits any in-flight background cache save.
	 * Call this when you need to guarantee all pending writes have completed,
	 * e.g., before reading the cache file from a different instance.
	 */
	async flush(): Promise<void> {
		if (this.#pendingSave) {
			await this.#pendingSave;
			this.#pendingSave = undefined;
		}
	}

	/**
	 * Custom inspection method for better type representation.
	 * @returns The string 'FileManager'
	 */
	get [Symbol.toStringTag]() {
		return 'FileManager';
	}
}
