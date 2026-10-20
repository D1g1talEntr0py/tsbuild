import { isErrnoException } from './errors';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, join, type ParsedPath, parse } from 'node:path';
import type { Path, AbsolutePath, RelativePath, ConditionalPath } from './@types';

const isMissingPathError = (error: unknown): boolean => isErrnoException(error) && error.code === 'ENOENT';

/**
 * Class for path manipulations.
 */
export class Paths {
	private constructor() { throw new Error('Static class - cannot be instantiated') }

	/**
	 * Computes the absolute path by joining the provided segments.
	 * @param paths Array of path segments to join.
	 */
	static absolute = resolve as (...paths: string[] | Path[]) => AbsolutePath;

	/**
	 * Computes the relative path from one location to another.
	 * @param from The starting location.
	 * @param to The target location.
	 */
	static relative = relative as (from: string, to: string) => RelativePath;

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
	static join = join as <T extends string | Path>(first: T, ...rest: (string | Path)[]) => ConditionalPath<T>;

	/**
	 * Gets the directory name of the given path.
	 * @param path - The path to get the directory name for
	 * @returns The directory name as an absolute path
	 */
	static directoryName = dirname as (path: string | Path) => AbsolutePath;

	/**
	 * Resolves existing symlink components while preserving non-existent suffixes.
	 * @param path - The path to canonicalize
	 * @returns The canonical path, including any non-existent trailing components
	 */
	static async canonical(path: string | Path): Promise<AbsolutePath> {
		const absolutePath = Paths.absolute(path);
		const missingParts: string[] = [];
		let currentPath = absolutePath;

		while (true) {
			try {
				return Paths.absolute(await realpath(currentPath), ...missingParts.reverse());
			} catch (error) {
				if (!isMissingPathError(error)) { throw error }

				const parentPath = Paths.directoryName(currentPath);
				if (parentPath === currentPath) { return absolutePath }

				missingParts.push(currentPath.slice(parentPath.length + (parentPath === '/' ? 0 : 1)));
				currentPath = parentPath;
			}
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
}