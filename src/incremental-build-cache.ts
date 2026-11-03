import { Files } from './files';
import { Paths } from './paths';
import { everyOutputInBatches } from './project/output-checks';
import { rmSync, statSync } from 'node:fs';
import { cacheDirectory, defaultCleanOptions, dtsCacheFile, isString, dtsCacheVersion as version } from './constants';
import type { AbsolutePath, BuildCache, BuildCacheManager, BuildInputManifest, CachedDeclaration } from './@types';

interface PersistedBuildCache extends BuildCache {
	outputArtifacts?: string[];
}

/** Handles persistent caching of pre-processed declaration files for incremental builds. */
export class IncrementalBuildCache implements BuildCacheManager {
	/** Set to true when invalidate() is called to prevent stale cache from being restored */
	#invalidated = false;
	/** Updated synchronously in save() so fingerprintMatches() sees fresh data without re-reading from disk. */
	#savedFingerprint: string | undefined;
	/** Output artifacts from the last successful build, persisted with the declaration cache. */
	#expectedOutputArtifacts: string[] | undefined;
	/** Compiler inputs of the last successful build, persisted with the declaration cache. */
	#manifest: BuildInputManifest | undefined;
	readonly #cacheDirectoryPath: AbsolutePath;
	readonly #cacheFilePath: AbsolutePath;
	/** Pre-loading promise started in constructor for async cache restoration */
	readonly #cacheLoaded: Promise<PersistedBuildCache | undefined>;

	/**
	 * Creates a new build cache instance and begins pre-loading the cache asynchronously.
	 * @param projectRoot - Root directory of the project
	 */
	constructor(projectRoot: AbsolutePath) {
		this.#cacheDirectoryPath = Paths.join(projectRoot, cacheDirectory);
		this.#cacheFilePath = Paths.join(this.#cacheDirectoryPath, dtsCacheFile);
		// Start pre-loading the cache immediately - this runs in parallel with configuration resolution
		this.#cacheLoaded = this.#loadCache();
	}

	/**
	 * Checks if the cache is valid (not invalidated).
	 * @returns True if the cache is valid, false if it has been invalidated
	 */
	isValid(): boolean {
		return !this.#invalidated;
	}

	/** Invalidates the build cache by removing the cache directory. */
	invalidate(): void {
		this.#invalidated = true;

		try { rmSync(this.#cacheDirectoryPath, defaultCleanOptions) } catch { /* Ignore */ }
	}

	/**
	 * Checks whether the compiler inputs are unchanged since the last successful build.
	 * The manifest is only persisted after an error-free type-check, so an up-to-date manifest proves the compiler would report no errors and emit the cached declarations.
	 * Stats are read synchronously: hundreds of small `stat` calls finish faster inline than through the libuv thread pool.
	 * @param key - Deterministic key of the current root names, compiler options and TypeScript version
	 * @returns The manifest when the key matches and every recorded input has the same modification time and size, otherwise undefined
	 */
	async upToDateManifest(key: string): Promise<BuildInputManifest | undefined> {
		if (this.#invalidated) { return undefined }

		await this.#cacheLoaded;
		const manifest = this.#manifest;

		if (manifest?.key !== key) { return undefined }

		for (const [ path, mtimeMs, size ] of manifest.files) {
			const stats = statSync(path, { throwIfNoEntry: false });

			if (stats?.mtimeMs !== mtimeMs || stats.size !== size) { return undefined }
		}

		return manifest;
	}

	/**
	 * Records the output paths produced by a successful build.
	 * @param outputArtifacts - Absolute paths that must exist for the cache to be reusable
	 */
	setExpectedOutputArtifacts(outputArtifacts: ReadonlyArray<AbsolutePath>): void {
		this.#expectedOutputArtifacts = Array.from(outputArtifacts);
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

		for (const [ fileName, content ] of cache.files) { target.set(fileName, content) }
	}

	/**
	 * Saves declaration files to the compressed cache file with version and fingerprint information.
	 * Uses V8 serialization for faster read performance on subsequent builds.
	 * @param source - The declaration files to cache
	 * @param fingerprint - Deterministic hash of build configuration for cache invalidation on config change
	 * @param manifest - Compiler inputs of the build that produced `source`; defaults to the current manifest when the compiler did not run
	 */
	async save(source: ReadonlyMap<string, CachedDeclaration>, fingerprint: string, manifest: BuildInputManifest | undefined = this.#manifest): Promise<void> {
		// set before await so fingerprintMatches() sees it immediately
		this.#savedFingerprint = fingerprint;
		this.#manifest = manifest;

		await Files.writeCompressed(this.#cacheFilePath, { version, files: source, fingerprint, manifest, outputArtifacts: this.#expectedOutputArtifacts });
	}

	/**
	 * Checks that the cache has a recorded artifact set and every artifact still exists.
	 * @returns True when the cached output set is complete on disk, false otherwise
	 */
	async expectedOutputsExist(): Promise<boolean> {
		if (this.#invalidated) { return false }

		await this.#cacheLoaded;
		const outputArtifacts = this.#expectedOutputArtifacts;

		if (outputArtifacts === undefined) { return false }

		return everyOutputInBatches(outputArtifacts, (path) => Files.exists(path));
	}

	/**
	 * Checks whether the build configuration has changed since the cache was last saved.
	 * Returns true if the cache is valid and fingerprints match, false if config changed or cache is invalid.
	 * @param currentFingerprint - The fingerprint of the current build configuration
	 * @returns True if the cached configuration matches the current configuration
	 */
	async fingerprintMatches(currentFingerprint: string): Promise<boolean> {
		if (this.#invalidated) { return false }

		return (this.#savedFingerprint ?? (await this.#cacheLoaded)?.fingerprint) === currentFingerprint;
	}

	/**
	 * Custom inspection tag for type.
	 * @returns The string 'IncrementalBuildCache'
	 */
	get [Symbol.toStringTag](): string {
		return 'IncrementalBuildCache';
	}

	/**
	 * Loads the cache file asynchronously using V8 deserialization.
	 * The cache filename is version-stamped, so a present file is always structurally compatible —
	 * a stale cache from an older format simply has a different filename and is never read.
	 * @returns The cache, or undefined if the cache doesn't exist or couldn't be read.
	 */
	async #loadCache() {
		try {
			const cache = await Files.readCompressed<PersistedBuildCache>(this.#cacheFilePath);

			if (cache.version !== version || !(cache.files instanceof Map) || cache.outputArtifacts !== undefined && (!Array.isArray(cache.outputArtifacts) || !cache.outputArtifacts.every(isString))) {
				return undefined;
			}

			this.#expectedOutputArtifacts = cache.outputArtifacts;
			this.#manifest ??= cache.manifest;

			return cache;
		} catch {
			// Cache doesn't exist or couldn't be read - this is fine for first build
			return undefined;
		}
	}
}