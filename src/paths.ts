import { lstat } from 'node:fs/promises';
import { relative, resolve, join, type ParsedPath, parse } from 'node:path';
import type { Path, AbsolutePath, RelativePath, ConditionalPath } from 'src/@types';

/**
 * Class for path manipulations.
 */
export class Paths {
	private constructor() { /* Static class - no instantiation */ }

	/**
	 * Computes the absolute path by joining the provided segments.
	 * @param paths Array of path segments to join
	 * @returns The absolute path
	 */
	static absolute(...paths: string[] | Path[]): AbsolutePath {
		return resolve(...paths) as AbsolutePath;
	}

	/**
	 * Computes the relative path from one location to another.
	 * @param from The starting location
	 * @param to The target location
	 * @returns The relative path
	 */
	static relative(from: string, to: string): RelativePath {
		return relative(from, to) as RelativePath;
	}

	/**
	 * Returns the directory name of a path.
	 * @param path - The path to evaluate
	 * @returns The directory name of the path
	 */
	static parse(path: string): ParsedPath {
		return parse(path);
	}

	/**
	 * Checks if the given path is a directory.
	 * @param path - The path to check
	 * @returns True if the path is a directory, false otherwise
	 */
	static async isDirectory<T extends Path>(path: T | string): Promise<boolean> {
		return (await lstat(path)).isDirectory();
	}

	/**
	 * Checks if the given path is a file.
	 * @param path - The path to check
	 * @returns True if the path is a file, false otherwise
	 */
	static async isFile<T extends Path>(path: T | string): Promise<boolean> {
		return (await lstat(path)).isFile();
	}

	/**
	 * Checks if a module specifier represents a local path (not a bare specifier).
	 * Local paths start with '/', './', '../', '.', '..', or Windows drive letters (e.g., 'C:\').
	 * @param path - The module specifier to check
	 * @returns True if the path is a local/relative path, false if it's a bare specifier (node module)
	 */
	static isPath<T extends Path>(path: T | string): path is T {
		if (path.length === 0) { return false }

		const firstCharacter = path.charCodeAt(0);

		// Check '/' (absolute path)
		if (firstCharacter === 47) { return true }

		// Check '.' (relative path: ., .., ./, ../)
		if (firstCharacter === 46) {
			// "."
			if (path.length === 1) { return true }

			const c1 = path.charCodeAt(1);
			// "./"
			if (c1 === 47) { return true }
			// ".." or "../"
			if (c1 === 46) { return path.length === 2 || path.charCodeAt(2) === 47 }

			return false;
		}

		// Check Windows drive letter (A-Z): followed by ":\" or ":/"
		if (firstCharacter >= 65 && firstCharacter <= 90 && path.length >= 3 && path.charCodeAt(1) === 58) {
			const c2 = path.charCodeAt(2);
			// "/" or "\"
			return c2 === 47 || c2 === 92;
		}

		return false;
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