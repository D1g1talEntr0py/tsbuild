import { Files } from 'src/files';
import { Paths } from 'src/paths';
import { defaultEntryPoint } from 'src/constants';
import { DeclarationProcessor } from './dts/declaration-processor';
import { sys, createSourceFile, ScriptTarget } from 'typescript';
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
 * Declaration files are pre-processed immediately when emitted by TypeScript,
 * ensuring the cache stores ready-to-use declarations and avoiding duplicate
 * processing on subsequent builds.
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
		// Reset emit flag
		this.hasEmittedFiles = false;

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
	 * const hasEmitted = await manager.finalize();
	 * if (hasEmitted) { // Continue with build }
	 * ```
	 */
	async finalize(): Promise<boolean> {
		if (this.cache && this.hasEmittedFiles) { await this.cache.save(this.declarationFiles) }

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
		this.declarationFiles.clear();
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
	 * Declaration files are pre-processed and stored in memory, while .tsbuildinfo is written to disk.
	 * Pre-processing happens immediately so the cache stores ready-to-use declarations.
	 * @param filePath - The path of the file being written
	 * @param text - The content of the file being written
	 */
	fileWriter = (filePath: string, text: string): void => {
		if (this.cache?.isBuildInfoFile(filePath as AbsolutePath)) {
			// Let .tsbuildinfo through to disk for incremental compilation
			sys.writeFile(filePath, text);
		} else {
			// Pre-process declarations immediately and store in memory
			// This ensures the cache stores ready-to-use declarations with extracted references
			this.declarationFiles.set(filePath as AbsolutePath, DeclarationProcessor.preProcess(createSourceFile(filePath, text, ScriptTarget.Latest, true)));
		}

		// Any file write indicates TypeScript detected changes
		if (!this.hasEmittedFiles) { this.hasEmittedFiles = true }
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
