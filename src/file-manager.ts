import { Files } from 'src/files';
import { Paths } from 'src/paths';
import { defaultEntryPoint } from 'src/constants';
import { DeclarationProcessor } from './dts/declaration-processor';
import { createSourceFile, ScriptTarget } from 'typescript';
import type { AbsolutePath, BuildCache, CachedDeclaration, Closable, WrittenFile } from 'src/@types';

/**
 * Manages in-memory storage and caching of TypeScript emit output files.
 *
 * This class provides a clean separation of concerns:
 * - In-memory storage of pre-processed declaration files during compilation
 * - Tracking of .tsbuildinfo writes for incremental build detection
 * - Optional persistent caching for incremental builds
 * - Disk I/O for writing declaration files
 * - Entry point resolution for declaration bundling
 *
 * Declaration files are stored as raw text during TypeScript emit (to minimize
 * work inside the synchronous emit callback) and pre-processed lazily in
 * {@link FileManager.processEmittedFiles} before cache persistence.
 *
 * @example Basic usage (no caching)
 * ```typescript
 * const manager = new FileManager();
 * await manager.initialize();
 * program.emit(undefined, manager.fileWriter, undefined, true);
 * const hasEmitted = await manager.finalize();
 * ```
 *
 * @example With incremental caching
 * ```typescript
 * const manager = new FileManager({
 *   projectRoot: '/path/to/project',
 *   tsBuildInfoFile: 'tsconfig.tsbuildinfo'
 * });
 * await manager.initialize();
 * program.emit(undefined, manager.fileWriter, undefined, true);
 * const hasEmitted = await manager.finalize(); // Saves cache if files emitted
 * ```
 */
export class FileManager implements Closable {
	private hasEmittedFiles: boolean = false;
	private readonly declarationFiles = new Map<AbsolutePath, CachedDeclaration>();
	private readonly cache: BuildCache | undefined;
	/** Raw declaration text captured during emit, pending pre-processing */
	private readonly pendingFiles: { path: AbsolutePath; text: string }[] = [];
	/** Buffered .tsbuildinfo content for async write (avoids sync I/O during emit) */
	private pendingBuildInfo: { path: string; text: string } | undefined;
	/** Background cache save promise — awaited in initialize() and close() */
	private pendingSave: Promise<void> | undefined;

	/**
	 * Creates a new file manager.
	 * @param buildCache - Optional build cache for incremental builds
	 */
	constructor(buildCache?: BuildCache) {
		this.cache = buildCache;
	}

	/**
	 * Prepares the manager for a new TypeScript emit operation.
	 * For incremental builds, restores cached (pre-processed) declarations before emit.
	 * For non-incremental builds, clears all stored files.
	 *
	 * @example
	 * ```typescript
	 * await manager.initialize();
	 * program.emit(undefined, manager.fileWriter, undefined, true);
	 * await manager.finalize();
	 * ```
	 */
	async initialize(): Promise<void> {
		// Ensure any in-flight cache save from the previous build completes before restoring
		if (this.pendingSave) { await this.pendingSave; this.pendingSave = undefined }

		// Reset emit state
		this.hasEmittedFiles = false;
		this.pendingFiles.length = 0;
		this.pendingBuildInfo = undefined;

		if (this.cache) {
			// For incremental builds, restore cache and let TypeScript update only changed files
			await this.cache.restore(this.declarationFiles);
		} else {
			// For non-incremental builds, start fresh
			this.declarationFiles.clear();
		}
	}

	/**
	 * Finalizes the emit operation by saving the cache if files were emitted.
	 * Must be called after program.emit() to ensure cache is properly saved.
	 *
	 * @returns True if files were emitted (or non-incremental build), false if no changes detected
	 * @example
	 * ```typescript
	 * await manager.initialize();
	 * program.emit(undefined, manager.fileWriter, undefined, true);
	 * const hasEmitted = manager.finalize();
	 * if (hasEmitted) { // Continue with build }
	 * ```
	 */
	finalize(): boolean {
		// Pre-process all declaration files captured during emit.
		// This work was deferred from the synchronous fileWriter callback to
		// reduce the time spent inside TypeScript's synchronous emit() call.
		this.processEmittedFiles();

		// Write .tsbuildinfo asynchronously (was sync sys.writeFile during emit)
		const buildInfoWrite = this.pendingBuildInfo ? Files.write(this.pendingBuildInfo.path, this.pendingBuildInfo.text) : undefined;
		this.pendingBuildInfo = undefined;

		// Fire-and-forget cache save — the cache is only needed on the *next* build,
		// so we don't block the current build's parallel phases (transpile + dts bundling).
		// The promise is awaited in initialize() (watch mode) and close() (process exit).
		// Suppress unhandled rejection warnings — errors are handled when awaited.
		if (this.cache && this.hasEmittedFiles) {
			this.pendingSave = Promise.all([ buildInfoWrite, this.cache.save(this.declarationFiles) ]).then(() => {});
		} else if (buildInfoWrite) {
			this.pendingSave = buildInfoWrite;
		}

		this.pendingSave?.catch(() => {});

		// For non-incremental builds (no cache), always assume files were emitted
		// For incremental builds, hasEmittedFiles tracks actual emission
		return this.cache === undefined || this.hasEmittedFiles;
	}

	/**
	 * Retrieves all stored declaration files.
	 * Files are already pre-processed and ready for bundling or writing to disk.
	 * This is a pure getter with no side effects.
	 *
	 * @returns A read-only map of file paths to their pre-processed content with extracted references
	 */
	getDeclarationFiles(): ReadonlyMap<AbsolutePath, CachedDeclaration> {
		return this.declarationFiles;
	}

	/**
	 * Writes all stored declaration files to disk.
	 * Files are already pre-processed, so this just writes them directly.
	 *
	 * @param projectDirectory - Project root for calculating relative paths
	 * @returns Array of written file metadata
	 */
	async writeFiles(projectDirectory: AbsolutePath): Promise<WrittenFile[]> {
		if (this.declarationFiles.size === 0) { return [] }

		const writeTasks: Promise<WrittenFile>[] = [];
		for (const [ filePath, { code } ] of this.declarationFiles) {
			writeTasks.push(this.writeFile(projectDirectory, filePath, code));
		}

		return Promise.all(writeTasks);
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

		// Filter to only the specified entry points
		const result: Record<string, AbsolutePath> = {};
		for (const [ name, path ] of Object.entries(projectEntryPoints)) {
			if (dtsEntryPoints.includes(name)) { result[name] = path }
		}

		return result;
	}

	/**
	 * Closes the file manager and releases resources.
	 * Clears all stored declaration files.
	 */
	close(): void {
		// Await any in-flight cache save to prevent data loss on exit.
		// ProcessManager calls close() synchronously, so we can only best-effort here.
		// The pendingSave promise is lightweight (already running), so this is safe.
		this.pendingSave?.then(() => {}, () => {});
		this.pendingSave = undefined;
		this.pendingFiles.length = 0;
		this.pendingBuildInfo = undefined;
		this.declarationFiles.clear();
	}

	/**
	 * Awaits any in-flight background I/O (cache save, .tsbuildinfo write).
	 * Call this when you need to guarantee all pending writes have completed,
	 * e.g., before reading the cache file from a different instance.
	 */
	async flush(): Promise<void> {
		if (this.pendingSave) { await this.pendingSave; this.pendingSave = undefined }
	}

	/**
	 * Writes a single declaration file to disk.
	 * @param projectDirectory - Project root for calculating relative paths
	 * @param filePath - The full path of the declaration file to write
	 * @param content - The pre-processed content of the declaration file
	 * @returns Metadata of the written file
	 */
	private async writeFile(projectDirectory: AbsolutePath, filePath: AbsolutePath, content: string): Promise<WrittenFile> {
		await Files.write(filePath, content);
		return { path: Paths.relative(projectDirectory, filePath), size: content.length };
	}

	/**
	 * Function that intercepts file writes during TypeScript emit.
	 * Captures raw text for deferred pre-processing and buffers .tsbuildinfo for async I/O.
	 * Designed to be as fast as possible since it runs inside TypeScript's synchronous emit() call.
	 * @param filePath - The path of the file being written
	 * @param text - The content of the file being written
	 */
	fileWriter = (filePath: string, text: string): void => {
		if (this.cache?.isBuildInfoFile(filePath as AbsolutePath)) {
			// Buffer .tsbuildinfo for async write in finalize() instead of blocking emit with sync I/O
			this.pendingBuildInfo = { path: filePath, text };
		} else {
			// Defer pre-processing — raw text is stored and processed in finalize()
			this.pendingFiles.push({ path: filePath as AbsolutePath, text });
			// Only non-buildinfo writes indicate TypeScript detected source changes —
			// .tsbuildinfo is always written by TypeScript even when nothing changed
			if (!this.hasEmittedFiles) { this.hasEmittedFiles = true }
		}
	};

	/**
	 * Pre-processes all declaration files captured during emit.
	 * Runs createSourceFile + DeclarationProcessor.preProcess for each pending file,
	 * then clears the pending queue.
	 */
	private processEmittedFiles(): void {
		for (const { path, text } of this.pendingFiles) {
			this.declarationFiles.set(path, DeclarationProcessor.preProcess(createSourceFile(path, text, ScriptTarget.Latest, true)));
		}

		this.pendingFiles.length = 0;
	};

	/**
	 * Custom inspection method for better type representation.
	 * @returns The string 'FileManager'
	 * @internal
	 */
	get [Symbol.toStringTag](): string {
		return 'FileManager';
	}
}
