import { Files } from './files';
import { Paths } from './paths';
import { rmSync } from 'node:fs';
import { cacheDirectory, defaultCleanOptions, dtsCacheFile, dtsCacheVersion as version } from './constants';
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
	/** Pre-loading promise started in constructor for async cache restoration */
	private readonly cacheLoaded: Promise<VersionedCache | undefined>;

	/**
	 * Creates a new build cache instance and begins pre-loading the cache asynchronously.
	 * @param projectRoot - Root directory of the project
	 * @param tsBuildInfoFile - Path to the TypeScript build info file
	 */
	constructor(projectRoot: AbsolutePath, tsBuildInfoFile: string) {
		this.buildInfoPath = Paths.join(projectRoot, tsBuildInfoFile);
		this.cacheDirectoryPath = Paths.join(projectRoot, cacheDirectory);
		this.cacheFilePath = Paths.join(this.cacheDirectoryPath, dtsCacheFile);
		// Start pre-loading the cache immediately - this runs in parallel with TypeScript program creation
		this.cacheLoaded = this.loadCache();
	}

	/**
	 * Loads the cache file asynchronously using V8 deserialization.
	 * @returns The cache or undefined if cache doesn't exist, is corrupted, or has incompatible version.
	 */
	private async loadCache(): Promise<VersionedCache | undefined> {
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
		const cache = await this.cacheLoaded;

		if (cache === undefined) { return }

		for (const [ fileName, content ] of Object.entries(cache.files)) {
			target.set(fileName, content);
		}
	}

	/**
	 * Saves declaration files to the compressed cache file with version information.
	 * Uses V8 serialization for faster read performance on subsequent builds.
	 * @param source - The declaration files to cache
	 */
	async save(source: ReadonlyMap<string, CachedDeclaration>): Promise<void> {
		await Files.writeCompressed(this.cacheFilePath, { version, files: Object.fromEntries(source) });
	}

	/** Invalidates the build cache by removing the cache directory. */
	invalidate(): void {
		try { rmSync(this.cacheDirectoryPath, defaultCleanOptions) } catch { /* Ignore */ }
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
	 * Custom inspection tag for type.
	 * @returns The string 'IncrementalBuildCache'
	 */
	get [Symbol.toStringTag](): string {
		return 'IncrementalBuildCache';
	}
}