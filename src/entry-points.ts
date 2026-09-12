import { FileExtension } from './constants';
import { ConfigurationError } from './errors';
import { Files } from './files';
import { Paths } from './paths';
import type { AbsolutePath, EntryPoints, RelativePath } from './@types/index';

type PackageJsonExportValue = string | null | PackageJsonExportValue[] | { [key: string]: PackageJsonExportValue | undefined };
type PackageJsonExports = PackageJsonExportValue;

/** Minimal package.json shape for entry point inference */
type PackageJson = {
	name?: string;
	main?: string;
	module?: string;
	exports?: PackageJsonExports;
	bin?: string | Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

/** Conditional export keys tried in priority order */
const importConditions = [ 'import', 'node', 'module', 'default' ] as const;
const endsWithSlash = /\/$/;
const startsWithDotSlash = /^\.\//;
/** Output → source file extension mapping */
const outputToSourceExtension: ReadonlyMap<string, string> = new Map([
	[ FileExtension.JS, FileExtension.TS ],
	[ FileExtension.JSX, FileExtension.TSX ],
	[ FileExtension.DTS, FileExtension.TS ]
]);

/**
 * Extracts the filename stem from a path (e.g., `'./src/index.ts'` → `'index'`).
 * @param filePath A file path
 * @returns The stem of the filename
 */
function stemOf(filePath: string) {
	const base = filePath.split('/').at(-1) ?? '';
	const dot = base.indexOf('.');

	return dot === -1 ? base : base.slice(0, dot);
}

/**
 * Normalizes array entry points to a stable output-name map.
 * @param entryPoints Array of source paths
 * @returns Entry points keyed by source filename stem
 */
function normalizeEntryPoints(entryPoints: EntryPoints<RelativePath> | RelativePath[]): EntryPoints<RelativePath> {
	if (!Array.isArray(entryPoints)) { return entryPoints }

	const normalized: EntryPoints<RelativePath> = {};
	for (const entryPoint of entryPoints) {
		const name = stemOf(entryPoint);
		if (normalized[name] !== undefined) { throw new ConfigurationError(`Duplicate entry point stem: ${name}`) }

		normalized[name] = entryPoint;
	}

	return normalized;
}

/**
 * Strips the npm scope prefix from a package name (e.g., `'@scope/pkg'` → `'pkg'`).
 * @param name The package name, optionally scoped
 * @returns The unscoped name
 */
function unscope(name: string) {
	const slash = name.indexOf('/');

	return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * Converts an output file path to its corresponding source file path by reversing the outDir → rootDir mapping and swapping the file extension.
 * @param outputPath The output path (e.g., `./dist/index.js`)
 * @param outDir The output directory (e.g., `dist`)
 * @param sourceDir The source directory (e.g., `src`)
 * @returns The source path (e.g., `./src/index.ts`), or undefined if the path cannot be reverse-mapped
 */
function outputToSourcePath(outputPath: string, outDir: string, sourceDir: string): RelativePath | undefined {
	const normalizedOutput = outputPath.replace(startsWithDotSlash, '');
	const normalizedOutDir = outDir.replace(startsWithDotSlash, '').replace(endsWithSlash, '');

	if (!normalizedOutput.startsWith(normalizedOutDir + '/') && normalizedOutput !== normalizedOutDir) { return undefined }

	const relativePortion = normalizedOutput.slice(normalizedOutDir.length + 1);

	for (const [ outExt, srcExt ] of outputToSourceExtension) {
		if (relativePortion.endsWith(outExt)) {
			return `./${sourceDir}/${relativePortion.slice(0, -outExt.length)}${srcExt}` as RelativePath;
		}
	}

	return undefined;
}

/**
 * Extracts the output path string from a conditional export value. Tries `import`, `node`, `module`,
 * then `default` conditions, recursing into nested condition objects.
 * @param exportValue String shorthand or conditional export object
 * @returns The resolved output path, or undefined if no supported condition is found
 */
function resolveConditionalExport(exportValue: PackageJsonExportValue): string | undefined {
	if (typeof exportValue === 'string') { return exportValue }

	if (exportValue === null) { return undefined }

	if (Array.isArray(exportValue)) {
		for (const value of exportValue) {
			const resolved = resolveConditionalExport(value);
			if (resolved !== undefined) { return resolved }
		}

		return undefined;
	}

	for (const condition of importConditions) {
		const value = exportValue[condition];

		if (value === undefined) { continue }

		const resolved = resolveConditionalExport(value);

		if (resolved !== undefined) { return resolved }
	}

	return undefined;
}

/**
 * Derives the entry point name from a subpath export key. `"."` → package name or `"index"`, `"./foo"` → `"foo"`, `"./utils/bar"` → `"bar"`.
 * @param subpath The exports key (e.g., `"."`, `"./foo"`)
 * @param packageName The package name used for the root export
 * @returns The derived entry point name (e.g., `"index"`, `"foo"`), or the package name for the root export if subpath is `"."`
 */
function subpathToEntryName(subpath: string, packageName?: string): string {
	if (subpath === '.') { return packageName !== undefined ? unscope(packageName) : 'index' }

	const withoutPrefix = subpath.replace(startsWithDotSlash, '');
	const lastSegment = withoutPrefix.lastIndexOf('/');

	return lastSegment === -1 ? withoutPrefix : withoutPrefix.slice(lastSegment + 1);
}

/**
 * Infers entry points from package.json `exports`, `bin`, `main`, and `module` fields by reverse-mapping output paths to source paths.
 * Resolution order: `exports` → `bin` → `main`/`module`. Wildcard subpath patterns are skipped.
 * @param packageJson The parsed package.json content
 * @param outDir The output directory (e.g., `"dist"`)
 * @param sourceDir The source directory (defaults to `"src"`)
 * @returns Inferred entry points, or undefined if none could be determined
 */
function inferEntryPoints(packageJson: PackageJson, outDir: string, sourceDir: string = 'src'): EntryPoints<RelativePath> | undefined {
	const entryPoints: EntryPoints<RelativePath> = {};

	if (packageJson.exports !== undefined) {
		if (typeof packageJson.exports === 'string' || Array.isArray(packageJson.exports)) {
			const outputPath = resolveConditionalExport(packageJson.exports);
			if (outputPath !== undefined) {
				const resolvedSourcePath = outputToSourcePath(outputPath, outDir, sourceDir);
				if (resolvedSourcePath) { entryPoints[stemOf(resolvedSourcePath)] = resolvedSourcePath }
			}
		} else if (packageJson.exports !== null) {
			const exportEntries = Object.keys(packageJson.exports).some((key) => key === '.' || key.startsWith('./')) ? Object.entries(packageJson.exports) : [[ '.', packageJson.exports ] as const];

			for (const [ subpath, exportValue ] of exportEntries) {
				if (subpath.includes('*') || exportValue === undefined) { continue }

				const outputPath = resolveConditionalExport(exportValue);
				if (outputPath === undefined) { continue }

				const sourcePath = outputToSourcePath(outputPath, outDir, sourceDir);
				if (sourcePath) { entryPoints[subpath === '.' ? stemOf(sourcePath) : subpathToEntryName(subpath, packageJson.name)] = sourcePath }
			}
		}
	}

	if (packageJson.bin !== undefined) {
		const binEntries = typeof packageJson.bin === 'string' ? { [packageJson.name ?? 'cli']: packageJson.bin } : packageJson.bin;

		for (const [ name, outputPath ] of Object.entries(binEntries)) {
			if (entryPoints[name] === undefined) {
				const sourcePath = outputToSourcePath(outputPath, outDir, sourceDir);
				if (sourcePath) { entryPoints[name] = sourcePath }
			}
		}
	}

	let hasEntries = Object.keys(entryPoints).length > 0;

	if (!hasEntries) {
		const legacyPath = packageJson.module ?? packageJson.main;
		if (legacyPath !== undefined) {
			const sourcePath = outputToSourcePath(legacyPath, outDir, sourceDir);
			if (sourcePath) {
				entryPoints['index'] = sourcePath;
				hasEntries = true;
			}
		}
	}

	return hasEntries ? entryPoints : undefined;
}

/**
 * Updates a cached entry-point map when a source file is renamed.
 * @param entryPoints - Mutable entry point snapshot
 * @param path - Previous absolute path
 * @param nextPath - New absolute path
 */
function updateEntryPoints(entryPoints: EntryPoints<AbsolutePath> | undefined, path: AbsolutePath, nextPath: AbsolutePath): void {
	if (entryPoints === undefined) { return }

	for (const entryName of Object.keys(entryPoints)) {
		if (entryPoints[entryName] === path) { entryPoints[entryName] = nextPath }
	}
}

/**
 * Resolves configured entry points sequentially, expanding directories into file-stem entries.
 * @param directory - Project directory
 * @param entries - Configured entry point paths keyed by output name
 * @returns Absolute entry points with later collisions overwriting earlier entries
 */
async function resolveEntryPoints(directory: AbsolutePath, entries: Record<string, string>): Promise<EntryPoints<AbsolutePath>> {
	const expandedEntryPoints: EntryPoints<AbsolutePath> = {};

	for (const [ name, entryPoint ] of Object.entries(entries)) {
		for (const [ resolvedName, resolvedPath ] of Object.entries(await resolveEntryPoint(directory, name, entryPoint))) {
			expandedEntryPoints[resolvedName] = resolvedPath;
		}
	}

	return expandedEntryPoints;
}

/**
 * Resolves a single configured entry point to one or more absolute file entries.
 * @param directory - Project directory
 * @param name - Entry point key from config
 * @param entryPoint - Configured entry path
 * @returns Expanded entry mapping for this entry
 */
async function resolveEntryPoint(directory: AbsolutePath, name: string, entryPoint: string) {
	const resolvedPath = Paths.absolute(directory, entryPoint);

	if (await Paths.isDirectory(resolvedPath)) { return expandDirectoryEntryPoints(resolvedPath) }

	if (await Paths.isFile(resolvedPath)) { return { [name]: resolvedPath } }

	throw new ConfigurationError(`Entry point does not exist: ${entryPoint}. Add explicit entryPoints to your tsconfig.json tsbuild configuration.`);
}

/**
 * Expands a directory entry into per-file entries using file stem names.
 * @param directory - Absolute directory path
 * @returns Entry mapping with one key per file in the directory
 */
async function expandDirectoryEntryPoints(directory: AbsolutePath) {
	const entries: EntryPoints<AbsolutePath> = {};

	for (const file of (await Files.readDirectory(directory)).sort()) {
		const filePath = Paths.join(directory, file);
		if (await Paths.isFile(filePath)) { entries[Paths.parse(file).name] = filePath }
	}

	return entries;
}

export { inferEntryPoints, normalizeEntryPoints, outputToSourcePath, resolveConditionalExport, resolveEntryPoints, subpathToEntryName, updateEntryPoints };
export type { PackageJson };
