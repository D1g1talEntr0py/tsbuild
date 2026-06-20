import { Files } from './files';
import { Paths } from './paths';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { cacheDirectory, defaultCleanOptions, defaultDirOptions, dtsCacheFile, dtsCacheVersion as version, outputManifestFile } from './constants';
import type { AbsolutePath, BuildCache, BuildCacheManager, CachedDeclaration } from './@types';

/**
 * Handles persistent caching of pre-processed declaration files for incremental builds.
 * Uses V8 serialization for faster deserialization than JSON, and pre-loads
 * the cache asynchronously during construction to overlap I/O with other initialization.
 */
export class IncrementalBuildCache implements BuildCacheManager {
	readonly #buildInfoPath: AbsolutePath;
	readonly #cacheDirectoryPath: AbsolutePath;
	readonly #cacheFilePath: AbsolutePath;
	readonly #outputsManifestPath: AbsolutePath;
	/** Pre-loading promise started in constructor for async cache restoration */
	readonly #cacheLoaded: Promise<BuildCache | undefined>;
	/**
	 * Manifest snapshot captured synchronously at construction. Held in memory so it survives
	 * `invalidate()` (which deletes the on-disk manifest as part of clearing `.tsbuild`) and so
	 * subsequent in-process reads are race-free.
	 */
	#outputsSnapshot: readonly string[] | undefined;
	/** Set to true when invalidate() is called to prevent stale cache from being restored */
	#invalidated = false;
	/** Updated synchronously in save() so fingerprintMatches() sees fresh data without re-reading from disk. */
	#savedFingerprint: string | undefined;

	/**
	 * Creates a new build cache instance and begins pre-loading the cache asynchronously.
	 * @param projectRoot - Root directory of the project
	 * @param tsBuildInfoFile - Path to the TypeScript build info file
	 */
	constructor(projectRoot: AbsolutePath, tsBuildInfoFile: string) {
		this.#buildInfoPath = Paths.join(projectRoot, tsBuildInfoFile);
		this.#cacheDirectoryPath = Paths.join(projectRoot, cacheDirectory);
		this.#cacheFilePath = Paths.join(this.#cacheDirectoryPath, dtsCacheFile);
		this.#outputsManifestPath = Paths.join(this.#cacheDirectoryPath, outputManifestFile);
		// Enforce consistency BEFORE the TypeScript program reads .tsbuildinfo. An orphaned
		// build-info (present without a matching dts cache) would let the incremental program
		// skip emit while no cached declarations exist, producing broken bundles.
		this.#enforceIncrementalConsistency();
		// Start pre-loading the cache immediately - this runs in parallel with TypeScript program creation
		this.#cacheLoaded = this.#loadCache();
		// Capture the manifest synchronously so it survives invalidate() and downstream code can
		// read it without awaiting. The file is small (a JSON array of paths) so sync I/O is fine.
		this.#outputsSnapshot = IncrementalBuildCache.#loadOutputsSync(this.#outputsManifestPath);
	}

	/**
	 * Loads the cache file asynchronously using V8 deserialization.
	 * The cache filename is version-stamped, so a present file is always structurally compatible —
	 * a stale cache from an older format simply has a different filename and is never read.
	 * @returns The cache, or undefined if the cache doesn't exist or couldn't be read.
	 */
	async #loadCache() {
		try {
			return await Files.readCompressed<BuildCache>(this.#cacheFilePath);
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
		if (this.#invalidated) { return }

		const cache = await this.#cacheLoaded;

		if (cache === undefined) { return }

		for (const [ fileName, content ] of cache.files) {
			target.set(fileName, content);
		}
	}

	/**
	 * Saves declaration files to the compressed cache file with version and fingerprint information.
	 * Uses V8 serialization for faster read performance on subsequent builds.
	 * @param source - The declaration files to cache
	 * @param fingerprint - Deterministic hash of build configuration for cache invalidation on config change
	 */
	async save(source: ReadonlyMap<string, CachedDeclaration>, fingerprint: string): Promise<void> {
		this.#savedFingerprint = fingerprint; // set before await so fingerprintMatches() sees it immediately
		await Files.writeCompressed(this.#cacheFilePath, { version, files: source, fingerprint });
	}

	/**
	 * Checks whether the build configuration has changed since the cache was last saved.
	 * Returns true if the cache is valid and fingerprints match, false if config changed or cache is invalid.
	 * @param currentFingerprint - The fingerprint of the current build configuration
	 * @returns True if the cached configuration matches the current configuration
	 */
	async fingerprintMatches(currentFingerprint: string): Promise<boolean> {
		if (this.#invalidated) { return false }
		if (!this.hasPersistedState()) { return false }

		if (this.#savedFingerprint !== undefined) { return this.#savedFingerprint === currentFingerprint }

		const cache = await this.#cacheLoaded;
		return cache?.fingerprint === currentFingerprint;
	}

	/**
	 * Loads the previous build's output manifest synchronously.
	 * @param manifestPath - Absolute path to the manifest file
	 * @returns The recorded outputs, or undefined when missing/unreadable/malformed.
	 */
	static #loadOutputsSync(manifestPath: AbsolutePath): readonly string[] | undefined {
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
		return this.#outputsSnapshot;
	}

	/**
	 * Persists the project-relative output paths produced by the current build.
	 * Updates the in-memory snapshot immediately so subsequent getPreviousOutputs() calls
	 * (in watch mode) return the freshly written list without re-reading disk.
	 * @param outputs - Project-relative output paths
	 */
	async saveOutputs(outputs: readonly string[]): Promise<void> {
		this.#outputsSnapshot = outputs.slice();
		await mkdir(this.#cacheDirectoryPath, defaultDirOptions);
		await writeFile(this.#outputsManifestPath, JSON.stringify(this.#outputsSnapshot), 'utf8');
	}

	/**
	 * Checks if the cache is valid (not invalidated).
	 * @returns True if the cache is valid, false if it has been invalidated
	 */
	isValid(): boolean {
		return !this.#invalidated;
	}

	/**
	 * Enforces consistency between TypeScript's incremental state (`.tsbuildinfo`) and the
	 * versioned declaration cache. Both must be valid together: when the build-info file
	 * exists but the matching dts cache is absent — manually deleted, partially cleared, or
	 * left behind after a cache-version bump (the versioned filename no longer matches) — the
	 * incremental program would skip emit while no cached declarations exist, yielding broken
	 * bundles with unresolved internal imports. Removing the orphaned build-info forces the
	 * next program to perform a full emit, restoring a consistent state.
	 */
	#enforceIncrementalConsistency(): void {
		// Cold build: no incremental state to couple.
		if (!existsSync(this.#buildInfoPath)) { return }
		// Versioned cache present: the filename encodes the structure version, so existence
		// implies a compatible cache. State is consistent — keep the incremental build-info.
		if (existsSync(this.#cacheFilePath)) { return }
		// Orphaned build-info without a matching declaration cache — drop it to force a full emit.
		try { rmSync(this.#buildInfoPath) } catch { /* best-effort: a failed unlink only risks a redundant rebuild */ }
	}

	/** Invalidates the build cache by removing the cache directory. */
	invalidate(): void {
		this.#invalidated = true;
		try { rmSync(this.#cacheDirectoryPath, defaultCleanOptions) } catch { /* Ignore */ }
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
		return filePath === this.#buildInfoPath;
	}

	/**
	 * Synchronously checks whether persisted incremental state exists on disk.
	 * When the .tsbuildinfo file is missing, the next typecheck will perform a full emit,
	 * making it safe to clean the output directory eagerly in parallel with type checking.
	 * @returns True when the .tsbuildinfo file is present and the cache hasn't been invalidated.
	 */
	hasPersistedState(): boolean {
		return !this.#invalidated && existsSync(this.#buildInfoPath);
	}

	/**
	 * Synchronously checks whether a manifest snapshot from a prior build is available.
	 * Survives `invalidate()` so the manifest-driven cleanup path can be used on
	 * `--clearCache` and `--force` runs as well.
	 * @returns True when an output manifest snapshot is held in memory.
	 */
	hasPersistedManifest(): boolean {
		return this.#outputsSnapshot !== undefined;
	}

	/**
	 * Custom inspection tag for type.
	 * @returns The string 'IncrementalBuildCache'
	 */
	get [Symbol.toStringTag](): string {
		return 'IncrementalBuildCache';
	}
}