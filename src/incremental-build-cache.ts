import { Files } from './files';
import { Paths } from './paths';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { cacheDirectory, defaultCleanOptions, defaultDirOptions, dtsCacheFile, dtsCacheVersion as version, outputManifestFile } from './constants';
import type { VersionedCache } from './dts/@types';
import type { AbsolutePath, BuildCache, CachedDeclaration } from './@types';

/**
 * Handles persistent caching of pre-processed declaration files for incremental builds.
 * Uses V8 serialization for faster deserialization than JSON, and pre-loads
 * the cache asynchronously during construction to overlap I/O with other initialization.
 */
export class IncrementalBuildCache implements BuildCache {
	private readonly buildInfoPath: AbsolutePath;
	private readonly cacheDirectoryPath: AbsolutePath;
	private readonly cacheFilePath: AbsolutePath;
	private readonly outputsManifestPath: AbsolutePath;
	/** Pre-loading promise started in constructor for async cache restoration */
	private readonly cacheLoaded: Promise<VersionedCache | undefined>;
	/**
	 * Manifest snapshot captured synchronously at construction. Held in memory so it survives
	 * `invalidate()` (which deletes the on-disk manifest as part of clearing `.tsbuild`) and so
	 * subsequent in-process reads are race-free.
	 */
	private outputsSnapshot: readonly string[] | undefined;
	/** Set to true when invalidate() is called to prevent stale cache from being restored */
	private invalidated = false;

	/**
	 * Creates a new build cache instance and begins pre-loading the cache asynchronously.
	 * @param projectRoot - Root directory of the project
	 * @param tsBuildInfoFile - Path to the TypeScript build info file
	 */
	constructor(projectRoot: AbsolutePath, tsBuildInfoFile: string) {
		this.buildInfoPath = Paths.join(projectRoot, tsBuildInfoFile);
		this.cacheDirectoryPath = Paths.join(projectRoot, cacheDirectory);
		this.cacheFilePath = Paths.join(this.cacheDirectoryPath, dtsCacheFile);
		this.outputsManifestPath = Paths.join(this.cacheDirectoryPath, outputManifestFile);
		// Start pre-loading the cache immediately - this runs in parallel with TypeScript program creation
		this.cacheLoaded = this.loadCache();
		// Capture the manifest synchronously so it survives invalidate() and downstream code can
		// read it without awaiting. The file is small (a JSON array of paths) so sync I/O is fine.
		this.outputsSnapshot = IncrementalBuildCache.loadOutputsSync(this.outputsManifestPath);
	}

	/**
	 * Loads the cache file asynchronously using V8 deserialization.
	 * @returns The cache or undefined if cache doesn't exist, is corrupted, or has incompatible version.
	 */
	private async loadCache() {
		try {
			const cache = await Files.readCompressed<VersionedCache>(this.cacheFilePath);

			// Validate cache version - silently ignore incompatible caches
			return cache.version === version ? cache : undefined;
		} catch {
			// Cache doesn't exist or couldn't be read - this is fine for first build
			return undefined;
		}
	}

	/**
	 * Restores cached declaration files into the provided map.
	 * Waits for the pre-load promise started in constructor to complete.
	 * TypeScript's incremental compilation handles staleness - it re-emits only changed files,
	 * which overwrite cached entries. Unchanged files remain valid and skip re-emission.
	 * @param target - The map to populate with cached declarations
	 */
	async restore(target: Map<string, CachedDeclaration>): Promise<void> {
		// If the cache was invalidated, skip restoration even if the pre-load completed before invalidation
		if (this.invalidated) { return }

		const cache = await this.cacheLoaded;

		if (cache === undefined) { return }

		for (const [ fileName, content ] of cache.files) {
			target.set(fileName, content);
		}
	}

	/**
	 * Saves declaration files to the compressed cache file with version information.
	 * Uses V8 serialization for faster read performance on subsequent builds.
	 * @param source - The declaration files to cache
	 */
	async save(source: ReadonlyMap<string, CachedDeclaration>): Promise<void> {
		await Files.writeCompressed(this.cacheFilePath, { version, files: source });
	}

	/**
	 * Loads the previous build's output manifest synchronously.
	 * @param manifestPath - Absolute path to the manifest file
	 * @returns The recorded outputs, or undefined when missing/unreadable/malformed.
	 */
	private static loadOutputsSync(manifestPath: AbsolutePath): readonly string[] | undefined {
		try {
			const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
			return Array.isArray(parsed) ? parsed as string[] : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Returns the project-relative output paths recorded by the previous build, or undefined if none.
	 * The snapshot is captured at construction time and survives `invalidate()`.
	 * @returns The recorded outputs from the prior build, or undefined when unavailable.
	 */
	getPreviousOutputs(): readonly string[] | undefined {
		return this.outputsSnapshot;
	}

	/**
	 * Persists the project-relative output paths produced by the current build.
	 * Updates the in-memory snapshot immediately so subsequent getPreviousOutputs() calls
	 * (in watch mode) return the freshly written list without re-reading disk.
	 * @param outputs - Project-relative output paths
	 */
	async saveOutputs(outputs: readonly string[]): Promise<void> {
		this.outputsSnapshot = outputs.slice();
		await mkdir(this.cacheDirectoryPath, defaultDirOptions);
		await writeFile(this.outputsManifestPath, JSON.stringify(this.outputsSnapshot), 'utf8');
	}

	/** Invalidates the build cache by removing the cache directory. */
	invalidate(): void {
		this.invalidated = true;
		try { rmSync(this.cacheDirectoryPath, defaultCleanOptions) } catch { /* Ignore */ }
		// Note: outputsSnapshot is intentionally preserved. The manifest describes outputs in
		// `outDir` (not under `.tsbuild`) and is needed to remove stale outputs after this build,
		// keeping clean() off the critical path on --clearCache / --force runs.
	}

	/**
	 * Checks if a file path is the TypeScript build info file.
	 * @param filePath - The file path to check
	 * @returns True if the path matches the build info file
	 */
	isBuildInfoFile(filePath: AbsolutePath): boolean {
		return filePath === this.buildInfoPath;
	}

	/**
	 * Checks if the cache is valid (not invalidated).
	 * @returns True if the cache is valid, false if it has been invalidated
	 */
	isValid(): boolean {
		return !this.invalidated;
	}

	/**
	 * Synchronously checks whether persisted incremental state exists on disk.
	 * When the .tsbuildinfo file is missing, the next typecheck will perform a full emit,
	 * making it safe to clean the output directory eagerly in parallel with type checking.
	 * @returns True when the .tsbuildinfo file is present and the cache hasn't been invalidated.
	 */
	hasPersistedState(): boolean {
		return !this.invalidated && existsSync(this.buildInfoPath);
	}

	/**
	 * Synchronously checks whether a manifest snapshot from a prior build is available.
	 * Survives `invalidate()` so the manifest-driven cleanup path can be used on
	 * `--clearCache` and `--force` runs as well.
	 * @returns True when an output manifest snapshot is held in memory.
	 */
	hasPersistedManifest(): boolean {
		return this.outputsSnapshot !== undefined;
	}

	/**
	 * Custom inspection tag for type.
	 * @returns The string 'IncrementalBuildCache'
	 */
	get [Symbol.toStringTag](): string {
		return 'IncrementalBuildCache';
	}
}