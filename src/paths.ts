import { fileURLToPath } from 'node:url';
import { isErrnoException } from './errors';
import { lstat, realpath } from 'node:fs/promises';
import { type ParsedPath, posix, dirname, basename, relative, resolve, join, isAbsolute, parse } from 'node:path';
import type { TypeGuard } from './type-definition';
import type { AbsolutePath, RelativePath, ConditionalPath, JoinedPath, AppendedPath, PathDescriptor, Path } from './@types';

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
	 * @returns A normalized path with the same absolute/relative kind as a branded input
	 */
	static normalize = posix.normalize as <T extends PathDescriptor>(path: T) => ConditionalPath<T>;

	/**
	 * Gets the directory name of a path.
	 * @param path - The path to get the directory name for
	 * @returns A path with the same absolute/relative kind as a branded input
	 */
	static directoryName = posix.dirname as <T extends PathDescriptor>(path: T) => ConditionalPath<T>;
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
	 * Branded absolute inputs stay absolute; a relative input may produce an absolute result when empty.
	 * @param first - The first path segment (determines if result is absolute)
	 * @param rest - Additional path segments to join
	 * @returns The joined path
	 */
	static join = join as <T extends PathDescriptor>(first: T, ...rest: PathDescriptor[]) => JoinedPath<T>;

	/**
	 * Gets the directory name of the given path.
	 * @param path - The path to get the directory name for
	 * @returns A path with the same absolute/relative kind as a branded input
	 */
	static directoryName = dirname as <T extends PathDescriptor>(path: T) => ConditionalPath<T>;

	/**
	 * Gets the base name of the given path. Often used to extract the file name from a path.
	 * @param path - The path to get the base name for
	 * @param suffix - Optional file extension to remove from the base name
	 * @returns The base name as a string
	 */
	static baseName = basename as (path: PathDescriptor, suffix?: string) => string;

	/**
	 * Removes any query string or fragment from a module specifier.
	 * @param specifier The module specifier to inspect.
	 * @returns The path before any query string or fragment.
	 */
	static pathWithoutQueryOrFragment<T extends PathDescriptor>(specifier: T): ConditionalPath<T> {
		const hashIndex = specifier.indexOf('#');
		const queryIndex = specifier.indexOf('?');

		return specifier.slice(0, Math.min(specifier.length, hashIndex !== -1 ? hashIndex : specifier.length, queryIndex !== -1 ? queryIndex : specifier.length)) as ConditionalPath<T>;
	}

	/**
	 * Appends an extension to a module specifier before any query string or fragment.
	 * @param specifier The module specifier to update.
	 * @param extension The extension to append, including its leading dot.
	 * @returns The specifier with the extension inserted before its suffix.
	 */
	static appendExtension<T extends PathDescriptor>(specifier: T, extension: string): AppendedPath<T> {
		const path = Paths.pathWithoutQueryOrFragment(specifier);

		return `${path}${extension}${specifier.slice(path.length)}` as AppendedPath<T>;
	}

	/**
	 * Determines if a value is an absolute path.
	 * @param value The value to check.
	 * @returns True if the value is an absolute path, false otherwise.
	 */
	static isAbsolutePath: TypeGuard<AbsolutePath> = (value: unknown): value is AbsolutePath => typeof value === 'string' && isAbsolute(value);

	/**
	 * Determines if a value is a relative path.
	 * @param value The value to check.
	 * @returns True if the value is a relative path, false otherwise.
	 */
	static isRelativePath: TypeGuard<RelativePath> = (value: unknown): value is RelativePath => typeof value === 'string' && !isAbsolute(value);

	/**
	 * Determines if a module specifier is a relative path without an extension.
	 * @param specifier The module specifier to inspect.
	 * @returns True if the specifier is a relative path without an extension, false otherwise.
	 */
	static isRelativePathWithoutExtension(specifier: PathDescriptor): boolean {
		if (!specifier.startsWith('./') && !specifier.startsWith('../')) { return false }

		const path = Paths.pathWithoutQueryOrFragment(specifier);
		if (path.endsWith('/')) { return false }

		return !path.slice(path.lastIndexOf('/') + 1).includes('.');
	}

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
	static async getType(path: PathDescriptor): Promise<'file' | 'directory' | undefined> {
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
	static async isDirectory<T extends PathDescriptor>(path: T): Promise<boolean> {
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
	static async isFile<T extends PathDescriptor>(path: T): Promise<boolean> {
		try { return (await lstat(path)).isFile() } catch (error) {
			if (isMissingPathError(error)) { return false }
			throw error;
		}
	}

	/**
	 * Checks if a candidate path is the same as or a descendant of a parent path.
	 * @param parent The parent directory to check against
	 * @param candidate The candidate path to check if it is the same as or a descendant of the parent
	 * @returns `true` if the candidate is the same as or a descendant of the parent, `false` otherwise
	 */
	static isSameOrDescendant(parent: AbsolutePath, candidate: AbsolutePath): boolean {
		const path = Paths.relative(parent, candidate);

		return path.length === 0 || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
	}

	/**
	 * Checks if a module specifier represents a local path (not a bare specifier).
	 * Local paths start with '/', './', '../', '.', or '..'.
	 * @param path - The module specifier to check
	 * @returns True if the path is a local/relative path, false if it's a bare specifier (node module)
	 */
	static isLocalSpecifier(path: PathDescriptor): path is Path {
		if (path.length === 0) { return false }

		return path === '.' || path === '..' || path.startsWith('/') || path.startsWith('./') || path.startsWith('../');
	}

	/**
	 * Converts an absolute filesystem path or URL pathname to an absolute filesystem path.
	 * @param path The file path to normalize.
	 * @returns The absolute filesystem path.
	 * @throws {TypeError} if path is relative or a URL without an absolute pathname
	 */
	static normalize(path: PathDescriptor): AbsolutePath {
		if (path.startsWith('file://')) { return fileURLToPath(path) as AbsolutePath }

		if (Paths.isAbsolutePath(path)) { return path }

		// Paths that don't start with / or file:// must be valid URLs or else they're invalid relative paths
		if (!path.includes('://')) { throw new TypeError(`Paths.normalize requires an absolute path, got: ${path}`) }

		const pathname = new URL(path).pathname as AbsolutePath;

		if (!pathname.startsWith('/')) { throw new TypeError(`Paths.normalize requires a URL with an absolute pathname, got: ${path}`) }

		return pathname;
	}
}