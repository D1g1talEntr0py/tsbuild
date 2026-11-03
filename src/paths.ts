import { fileURLToPath } from 'node:url';
import { isErrnoException } from './errors';
import { lstat, realpath } from 'node:fs/promises';
import { posix, dirname, basename, relative, resolve, join, type ParsedPath, parse } from 'node:path';
import type { Path, AbsolutePath, RelativePath, ConditionalPath } from './@types';

type PathDescriptor = string | Path;

const isMissingPathError = (error: unknown): boolean => isErrnoException(error) && error.code === 'ENOENT';

class Posix {
	private constructor() { throw new Error('Posix is a static class cannot be instantiated') }

	/**
	 * Computes the relative path from one location to another.
	 * @param from The starting location.
	 * @param to The target location.
	 */
	static relative = posix.relative as (from: PathDescriptor, to: PathDescriptor) => RelativePath;

	/**
	 * Normalizes a path, resolving '..' and '.' segments.
	 * @param path - The path to normalize
	 * @returns The normalized absolute path
	 */
	static normalize = posix.normalize as (path: PathDescriptor) => AbsolutePath;

	/**
	 * Abstract method to get the directory name of a path.
	 * @param path - The path to get the directory name for
	 * @returns The directory name as an absolute path
	 */
	static directoryName = posix.dirname as (path: PathDescriptor) => AbsolutePath;
}

/**
 * Class for path manipulations.
 */
export class Paths {
	private constructor() { throw new Error('Paths is a static class and cannot be instantiated') }

	static Posix: typeof Posix = Posix;

	/**
	 * Computes the absolute path by joining the provided segments.
	 * @param paths Array of path segments to join.
	 */
	static absolute = resolve as (...paths: PathDescriptor[]) => AbsolutePath;

	/**
	 * Computes the relative path from one location to another.
	 * @param from The starting location.
	 * @param to The target location.
	 */
	static relative = relative as (from: PathDescriptor, to: PathDescriptor) => RelativePath;

	/**
	 * Parses a path string into its component parts.
	 * @param path The path to parse.
	 */
	static parse: (path: string) => ParsedPath = parse;

	/**
	 * Joins multiple path segments into a single path.
	 * When the first segment is an AbsolutePath, returns AbsolutePath.
	 * Otherwise, returns RelativePath.
	 * @param first - The first path segment (determines if result is absolute)
	 * @param rest - Additional path segments to join
	 * @returns The joined path
	 */
	static join = join as <T extends PathDescriptor>(first: T, ...rest: PathDescriptor[]) => ConditionalPath<T>;

	/**
	 * Gets the directory name of the given path.
	 * @param path - The path to get the directory name for
	 * @returns The directory name as an absolute path
	 */
	static directoryName = dirname as (path: PathDescriptor) => AbsolutePath;

	/**
	 * Gets the base name of the given path. Often used to extract the file name from a path.
	 * @param path - The path to get the base name for
	 * @param suffix - Optional file extension to remove from the base name
	 * @returns The base name as a string
	 */
	static baseName = basename as (path: PathDescriptor, suffix?: string) => string;

	/**
	 * Resolves existing symlink components while preserving non-existent suffixes.
	 * @param path - The path to canonicalize
	 * @returns The canonical path, including any non-existent trailing components
	 */
	static async canonical(path: PathDescriptor): Promise<AbsolutePath> {
		const absolutePath = Paths.absolute(path);
		const missingParts: string[] = [];
		let currentPath = absolutePath;

		while (true) {
			try { return Paths.absolute(await realpath(currentPath), ...missingParts.reverse()) } catch (error) {
				if (!isMissingPathError(error)) { throw error }

				const parentPath = Paths.directoryName(currentPath);

				if (parentPath === currentPath) { return absolutePath }

				missingParts.push(currentPath.slice(parentPath.length + (parentPath === '/' ? 0 : 1)));
				currentPath = parentPath;
			}
		}
	}

	/**
	 * Classifies a path with a single filesystem lookup without following symbolic links.
	 * @param path - The path to inspect
	 * @returns The entry type, or undefined for missing paths, symbolic links, and special entries
	 */
	static async getType(path: Path | string): Promise<'file' | 'directory' | undefined> {
		try {
			const stats = await lstat(path);

			return stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : undefined;
		} catch (error) {
			if (isMissingPathError(error)) { return undefined }
			throw error;
		}
	}

	/**
	 * Checks if the given path is a directory.
	 * Returns false if the path does not exist.
	 * @param path - The path to check
	 */
	static async isDirectory<T extends Path>(path: T | string): Promise<boolean> {
		try { return (await lstat(path)).isDirectory() } catch (error) {
			if (isMissingPathError(error)) { return false }
			throw error;
		}
	}

	/**
	 * Checks if the given path is a file.
	 * Returns false if the path does not exist.
	 * @param path - The path to check
	 */
	static async isFile<T extends Path>(path: T | string): Promise<boolean> {
		try { return (await lstat(path)).isFile() } catch (error) {
			if (isMissingPathError(error)) { return false }
			throw error;
		}
	}

	/**
	 * Checks if a module specifier represents a local path (not a bare specifier).
	 * Local paths start with '/', './', '../', '.', or '..'.
	 * @param path - The module specifier to check
	 * @returns True if the path is a local/relative path, false if it's a bare specifier (node module)
	 */
	static isPath<T extends Path>(path: T | string): path is T {
		if (path.length === 0) { return false }

		return path.startsWith('/') || path.startsWith('./') || path.startsWith('../') || path === '.' || path === '..';
	}

	/**
	 * Normalize a file path to an absolute path.
	 * @param path The file path to normalize.
	 * @returns The normalized absolute path.
	 * @throws {TypeError} if path is relative and not a valid URL
	 */
	static normalize(path: Path): AbsolutePath {
		if (path.startsWith('file://')) { return fileURLToPath(path) as AbsolutePath }

		if (path.startsWith('/')) { return path as AbsolutePath }

		// Paths that don't start with / or file:// must be valid URLs or else they're invalid relative paths
		if (!path.includes('://')) { throw new TypeError(`Paths.normalize requires an absolute path, got: ${path}`) }

		return new URL(path, import.meta.url).pathname as AbsolutePath;
	}
}