import type { EntryPoints, RelativePath } from './@types/index.js';

/** Conditional export keys tried in priority order */
const importConditions = [ 'import', 'node', 'module', 'default' ] as const;

/**
 * Extracts the filename stem from a path (e.g., `'./src/index.ts'` → `'index'`).
 * @param filePath A file path
 * @returns The stem of the filename
 */
function stemOf(filePath: string): string {
	const base = filePath.split('/').at(-1) ?? '';
	const dot = base.indexOf('.');
	return dot === -1 ? base : base.slice(0, dot);
}

/** Output → source file extension mapping */
const outputToSourceExtension: ReadonlyMap<string, string> = new Map([
	['.js', '.ts'],
	['.jsx', '.tsx'],
	['.d.ts', '.ts'],
]);

interface PackageJsonConditionalExport { [key: string]: string | PackageJsonConditionalExport | undefined }
type PackageJsonExports = string | Record<string, string | PackageJsonConditionalExport>;

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

/**
 * Strips the npm scope prefix from a package name (e.g., `'@scope/pkg'` → `'pkg'`).
 * @param name The package name, optionally scoped
 * @returns The unscoped name
 */
function unscope(name: string): string {
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
	const normalizedOutput = outputPath.replace(/^\.\//, '');
	const normalizedOutDir = outDir.replace(/^\.\//, '').replace(/\/$/, '');

	if (!normalizedOutput.startsWith(normalizedOutDir + '/') && normalizedOutput !== normalizedOutDir) { return undefined }

	const relativePortion = normalizedOutput.slice(normalizedOutDir.length + 1);

	for (const [outExt, srcExt] of outputToSourceExtension) {
		if (relativePortion.endsWith(outExt)) {
			const stem = relativePortion.slice(0, -outExt.length);
			return `./${sourceDir}/${stem}${srcExt}` as RelativePath;
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
function resolveConditionalExport(exportValue: string | PackageJsonConditionalExport): string | undefined {
	if (typeof exportValue === 'string') { return exportValue }

	for (const condition of importConditions) {
		const value: string | PackageJsonConditionalExport | undefined = exportValue[condition];
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

	const withoutPrefix = subpath.replace(/^\.\//, '');
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
		if (typeof packageJson.exports === 'string') {
			const sourcePath = outputToSourcePath(packageJson.exports, outDir, sourceDir);
			if (sourcePath) { entryPoints[stemOf(sourcePath)] = sourcePath }
		} else {
			for (const [subpath, exportValue] of Object.entries(packageJson.exports)) {
				if (subpath.includes('*')) { continue }

				const outputPath = resolveConditionalExport(exportValue);
				if (outputPath === undefined) { continue }

				const sourcePath = outputToSourcePath(outputPath, outDir, sourceDir);
				if (sourcePath) { entryPoints[subpath === '.' ? stemOf(sourcePath) : subpathToEntryName(subpath, packageJson.name)] = sourcePath }
			}
		}
	}

	if (packageJson.bin !== undefined) {
		const binEntries = typeof packageJson.bin === 'string' ? { [packageJson.name ?? 'cli']: packageJson.bin } : packageJson.bin;

		for (const [name, outputPath] of Object.entries(binEntries)) {
			if (entryPoints[name] === undefined) {
				const sourcePath = outputToSourcePath(outputPath, outDir, sourceDir);
				if (sourcePath) { entryPoints[name] = sourcePath }
			}
		}
	}

	if (Object.keys(entryPoints).length === 0) {
		const legacyPath = packageJson.module ?? packageJson.main;
		if (legacyPath !== undefined) {
			const sourcePath = outputToSourcePath(legacyPath, outDir, sourceDir);
			if (sourcePath) { entryPoints['index'] = sourcePath }
		}
	}

	return Object.keys(entryPoints).length > 0 ? entryPoints : undefined;
}

export { inferEntryPoints, outputToSourcePath, resolveConditionalExport, subpathToEntryName };
export type { PackageJson, PackageJsonExports, PackageJsonConditionalExport };
