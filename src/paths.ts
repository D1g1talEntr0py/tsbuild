import { lstat } from 'node:fs/promises';
import { relative, resolve, join, type ParsedPath, parse } from 'node:path';
import type { Path, AbsolutePath, RelativePath, ConditionalPath } from './@types';

const windowsDrivePathPattern = /^[A-Z]:[\\/]/;
const isMissingPathError = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Class for path manipulations.
 */
export class Paths {
	private constructor() { /* Static class - no instantiation */ }

	/**
	 * Computes the absolute path by joining the provided segments.
	 * @param paths Array of path segments to join.
	 */
	static absolute(...paths: string[] | Path[]): AbsolutePath {
		return resolve(...paths) as AbsolutePath;
	}

	/**
	 * Computes the relative path from one location to another.
	 * @param from The starting location.
	 * @param to The target location.
	 */
	static relative(from: string, to: string): RelativePath {
		return relative(from, to) as RelativePath;
	}

	/**
	 * Parses a path string into its component parts.
	 * @param path The path to parse.
	 */
	static parse(path: string): ParsedPath {
		return parse(path);
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
	 * Local paths start with '/', './', '../', '.', '..', or Windows drive letters (e.g., 'C:\').
	 * @param path - The module specifier to check
	 * @returns True if the path is a local/relative path, false if it's a bare specifier (node module)
	 */
	static isPath<T extends Path>(path: T | string): path is T {
		if (path.length === 0) { return false }

		if (path.startsWith('/') || path === '.' || path === '..') { return true }

		if (path.startsWith('./') || path.startsWith('../')) { return true }

		return windowsDrivePathPattern.test(path);
	}

	/**
	 * Joins multiple path segments into a single path.
	 * When the first segment is an AbsolutePath, returns AbsolutePath.
	 * Otherwise, returns RelativePath.
	 * @param first - The first path segment (determines if result is absolute)
	 * @param rest - Additional path segments to join
	 * @returns The joined path
	 */
	static join<T extends string | Path>(first: T, ...rest: (string | Path)[]): ConditionalPath<T> {
		return join(first, ...rest) as ConditionalPath<T>;
	}
}