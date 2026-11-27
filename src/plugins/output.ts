import { readFile } from 'node:fs/promises';
import { Files } from '../files';
import { Paths } from '../paths';
import { FileExtension } from '../constants';
import { LanguageVariant, SyntaxKind } from 'typescript/ast';
import { createScanner } from 'typescript/ast/scanner';
import type { Metafile, OutputFile, Plugin } from 'esbuild';
import type { AbsolutePath, WrittenFile, Mutable, SourceFile, PathDescriptor } from '../@types';

type MetafileOutputs = Metafile['outputs'];
type MetafileOutputValues = MetafileOutputs[string];
type ReplacementSpecifier = { start: number; end: number; content: string };
type WriteOutputOptions = { iifeFiles?: OutputFile[], resolveImports?: boolean };

/**
 * Rewrites extension-less relative import/export/dynamic-import specifiers to include `.js`.
 * @param code The JavaScript output content to rewrite.
 * @returns The content with `.js` added to eligible relative specifiers.
 */
function rewriteRelativeSpecifiers(code: string): string {
	const replacements: ReplacementSpecifier[] = [];
	const scanner = createScanner(true, LanguageVariant.Standard, code);

	/**
	 * Adds a rewrite for a relative specifier without an extension.
	 * @param start The start index of the specifier in the code.
	 * @param end The end index of the specifier in the code.
	 * @param tokenText The text of the specifier token, including quotes.
	 */
	const addSpecifierRewrite = (start: number, end: number, tokenText: string) => {
		const quote = tokenText[0];
		const specifier = tokenText.slice(1, -1);
		if (!Paths.isRelativePathWithoutExtension(specifier)) { return }

		replacements.push({ start, end, content: `${quote}${Paths.appendExtension(specifier, FileExtension.JS)}${quote}` });
	};

	let seenImportOrExport = false;
	let importOrExportDepth = 0;
	let expectSpecifierAfterFrom = false;
	let expectSideEffectImportSpecifier = false;
	let maybeDynamicImport = false;
	let expectDynamicImportSpecifier = false;

	for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
		switch (token) {
			case SyntaxKind.ImportKeyword: {
				seenImportOrExport = true;
				importOrExportDepth = 0;
				expectSpecifierAfterFrom = false;
				expectSideEffectImportSpecifier = true;
				maybeDynamicImport = true;
				expectDynamicImportSpecifier = false;

				break;
			}
			case SyntaxKind.ExportKeyword: {
				seenImportOrExport = true;
				importOrExportDepth = 0;
				expectSpecifierAfterFrom = false;
				expectSideEffectImportSpecifier = false;
				maybeDynamicImport = false;
				expectDynamicImportSpecifier = false;

				break;
			}
			case SyntaxKind.OpenParenToken: {
				if (maybeDynamicImport) {
					expectDynamicImportSpecifier = true;
					maybeDynamicImport = false;
				}

				if (seenImportOrExport) { importOrExportDepth += 1 }

				break;
			}
			case SyntaxKind.CloseParenToken: {
				if (seenImportOrExport && importOrExportDepth > 0) { importOrExportDepth -= 1 }

				break;
			}
			case SyntaxKind.FromKeyword: {
				if (seenImportOrExport) {
					expectSpecifierAfterFrom = true;
					expectSideEffectImportSpecifier = false;
				}

				break;
			}
			case SyntaxKind.StringLiteral:
			case SyntaxKind.NoSubstitutionTemplateLiteral: {
				if (expectDynamicImportSpecifier || expectSpecifierAfterFrom || expectSideEffectImportSpecifier) {
					addSpecifierRewrite(scanner.getTokenStart(), scanner.getTokenEnd(), scanner.getTokenText());
					expectDynamicImportSpecifier = false;
					expectSpecifierAfterFrom = false;
					expectSideEffectImportSpecifier = false;
				}

				break;
			}
			case SyntaxKind.SemicolonToken: {
				seenImportOrExport = false;
				importOrExportDepth = 0;
				expectSpecifierAfterFrom = false;
				expectSideEffectImportSpecifier = false;
				maybeDynamicImport = false;
				expectDynamicImportSpecifier = false;

				break;
			}
			case SyntaxKind.OpenBraceToken:
			case SyntaxKind.OpenBracketToken:
			case SyntaxKind.LessThanToken:
			case SyntaxKind.Identifier:
			case SyntaxKind.AsteriskToken:
			case SyntaxKind.TypeKeyword:
			case SyntaxKind.DefaultKeyword:
			case SyntaxKind.AsKeyword: {
				maybeDynamicImport = false;

				break;
			}
			default: break;
		}

		// End `import { ... }` / `export { ... }` clause where semicolon may be omitted.
		if (seenImportOrExport && importOrExportDepth === 0 && token === SyntaxKind.CloseBraceToken) { expectSideEffectImportSpecifier = false }
	}

	if (replacements.length === 0) { return code }

	// Single forward pass; repeated slice-and-concat is O(n * replacements) on large bundles.
	replacements.sort((left, right) => left.start - right.start);

	let cursor = 0;
	const segments: string[] = [];
	for (const { start, content, end } of replacements) {
		segments.push(code.slice(cursor, start), content);
		cursor = end;
	}

	segments.push(code.slice(cursor));

	return segments.join('');
}

/**
 * Predicate to check if a given path descriptor represents a relative path without an extension.
 * @param path - The path descriptor to check
 * @returns True if the path is a relative path without an extension, false otherwise
 */
const relativeSpecifierPredicate = ({ path }: { path: PathDescriptor }) => Paths.isRelativePathWithoutExtension(path);

/**
 * Resolves the output path used by tsbuild's extension rewrite for a relative import.
 * @param importPath - Import specifier from esbuild's metafile
 * @returns Relative output path without any query or fragment
 */
function importOutputPath(importPath: PathDescriptor) {
	const path = Paths.pathWithoutQueryOrFragment(importPath);

	return Paths.isRelativePathWithoutExtension(importPath) ? Paths.appendExtension(path, FileExtension.JS) : path;
}

type RelativeImportResolution = { errors: string[]; assets: SourceFile[] };

/**
 * Resolves relative imports in unbundled output. JavaScript imports must match an emitted output, and any other
 * relative import (JSON, CSS, etc.) is copied from beside its source file to the matching location in the output.
 * @param outputs - Metafile outputs from esbuild
 * @param directory - Project directory used to resolve output paths
 * @returns Build diagnostics for unresolvable imports and the assets to write alongside the output
 */
async function resolveRelativeImports(outputs: MetafileOutputs, directory: AbsolutePath): Promise<RelativeImportResolution> {
	const outputPaths = new Set(Object.keys(outputs).map((outputPath) => Paths.absolute(directory, outputPath)));
	const assetSources = new Map<AbsolutePath, AbsolutePath>();
	const errors: string[] = [];

	for (const [ outputPath, metadata ] of Object.entries(outputs)) {
		const absoluteOutputPath = Paths.absolute(directory, outputPath);

		if (!absoluteOutputPath.endsWith(FileExtension.JS)) { continue }

		for (const { path: importPath } of metadata.imports) {
			if (!importPath.startsWith('./') && !importPath.startsWith('../')) { continue }
			if (Paths.pathWithoutQueryOrFragment(importPath).endsWith('/')) { continue }

			const relativeImportPath = importOutputPath(importPath);
			const importedOutputPath = Paths.absolute(Paths.directoryName(absoluteOutputPath), relativeImportPath);

			if (outputPaths.has(importedOutputPath) || assetSources.has(importedOutputPath)) { continue }

			if (relativeImportPath.endsWith(FileExtension.JS) || metadata.entryPoint === undefined) {
				errors.push(`Unbundled output "${Paths.relative(directory, absoluteOutputPath)}" imports "${importPath}", but no matching output was generated. Add it to tsbuild.entryPoints alongside the other required entries.`);

				continue;
			}

			assetSources.set(importedOutputPath, Paths.absolute(Paths.directoryName(Paths.absolute(directory, metadata.entryPoint)), relativeImportPath));
		}
	}

	const assets = await Promise.all(Array.from(assetSources, async ([ path, sourcePath ]): Promise<SourceFile | undefined> => {
		try {
			const data = await readFile(sourcePath);

			return { path, data, size: data.byteLength };
		} catch (error) {
			errors.push(`Unbundled output imports "${Paths.relative(directory, sourcePath)}", but the file could not be read: ${error instanceof Error ? error.message : String(error)}`);

			return undefined;
		}
	}));

	return { errors, assets: assets.filter((asset): asset is SourceFile => asset !== undefined) };
}

/**
 * Writes output files to disk, rewriting relative specifiers in JS files and setting executable permissions for entry points with shebangs.
 * @param outputFiles - Array of output files generated by esbuild.
 * @param outputs - Metafile outputs mapping from esbuild.
 * @param directory - The base directory for resolving output paths.
 * @param iifeFiles - Array of IIFE output files, if any.
 * @param assets - Non-JavaScript files imported by unbundled output, written as-is.
 * @returns Array of written files with their relative paths and sizes.
 */
async function writeOutput(outputFiles: OutputFile[] | undefined, outputs: MetafileOutputs, directory: AbsolutePath, iifeFiles: OutputFile[] | undefined, assets: SourceFile[] | undefined): Promise<WrittenFile[]> {
	const entryPoints = new Set<AbsolutePath>();
	const outputMetadata = new Map<AbsolutePath, MetafileOutputValues>();

	for (const [ outputPath, metadata ] of Object.entries(outputs)) {
		const absolutePath = Paths.absolute(directory, outputPath);
		outputMetadata.set(absolutePath, metadata);

		if (metadata.entryPoint && absolutePath.endsWith(FileExtension.JS)) { entryPoints.add(absolutePath) }
	}

	const processOutput = (file: OutputFile): SourceFile => {
		const { contents } = file;
		const path = Paths.absolute(directory, file.path);
		const sourceFile: Mutable<SourceFile> = { path, data: contents, size: contents.byteLength, options: undefined };

		if (path.endsWith(FileExtension.JS)) {
			if (outputMetadata.get(path)?.imports.some(relativeSpecifierPredicate) ?? false) {
				// `OutputFile.text` is a lazily decoded getter — only touch it for files that actually need rewriting.
				const rewritten = rewriteRelativeSpecifiers(file.text);
				sourceFile.data = rewritten;
				sourceFile.size = Buffer.byteLength(rewritten);
			}

			if (entryPoints.has(path) && Files.hasShebang(contents)) { sourceFile.options = { mode: 0o755 } }
		}

		return Object.freeze(sourceFile);
	};

	const writeEntries: SourceFile[] = [];

	if (outputFiles !== undefined) {
		for (const file of outputFiles) { writeEntries.push(processOutput(file)) }
	}

	if (iifeFiles !== undefined) {
		for (const file of iifeFiles) { writeEntries.push(processOutput(file)) }
	}

	if (assets !== undefined && assets.length > 0) { writeEntries.push(...assets) }

	return Files.writeFiles(directory, writeEntries);
}

/**
 * Creates the esbuild plugin that writes emitted output files.
 * @param directory - Project directory used to resolve output paths
 * @param onWritten - Callback invoked with the files written by the plugin
 * @param options - Optional IIFE outputs and unbundled import resolution
 */
export const createWriteOutputPlugin = (directory: AbsolutePath, onWritten: (writtenFiles: WrittenFile[]) => void, { iifeFiles, resolveImports = false }: WriteOutputOptions = {}): Plugin => ({
	name: 'tsbuild:write-output',
	/**
	 * Sets up the plugin to write output files to disk after the build process completes.
	 * @param build The esbuild build context.
	 */
	setup(build) {
		build.onEnd(async ({ outputFiles, metafile, errors }) => {
			const outputs = metafile?.outputs;

			if (errors.length > 0 || outputs === undefined) { return }

			let assets: SourceFile[] | undefined;

			if (resolveImports) {
				const { errors, assets: resolvedAssets } = await resolveRelativeImports(outputs, directory);

				if (errors.length > 0) { return { errors: errors.map((text) => ({ text })) } }

				assets = resolvedAssets;
			}

			return onWritten(await writeOutput(outputFiles, outputs, directory, iifeFiles, assets));
		});
	}
});
