import { Paths } from '../paths';
import { createPatternMatcher } from '../pattern-matcher';
import MagicString from 'magic-string';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { BundleError } from '../errors';
import { Logger } from '../logger';
import { DeclarationProcessor } from './declaration-processor';
import { parseSourceFiles, sourceFileBatchSize } from './source-file-batches';
import { alwaysUndefined, defaultDirOptions, Encoding, sourceScriptExtensionExpression, FileExtension, newLine } from '../constants';
import {
	isImportDeclaration,
	isExportDeclaration,
	isInterfaceDeclaration,
	isTypeAliasDeclaration,
	isEnumDeclaration,
	isFunctionDeclaration,
	isClassDeclaration,
	isVariableStatement,
	isModuleDeclaration,
	isModuleBlock,
	isNamedExports,
	isNamedImports,
	isNamespaceExport,
	isIdentifier,
	isNamespaceImport,
	isQualifiedName,
	isExportAssignment,
	SyntaxKind
} from 'typescript/ast';
import { createFileSystemLayer } from 'typescript/fs';
import type { SourceFile, Node, StringLiteral } from 'typescript/ast';
import type { ModuleResolver, Snapshot } from 'typescript/sync';
import type { AbsolutePath, CachedDeclaration, EntryPoints, RelativePath, WrittenFile } from '../@types';
import type { ModuleInfo, DtsBundleOptions, DtsCompilerOptions, IdentifierMap, DeclarationCode, ModuleDependencyGraph, ExternalImport, ExportedName, NamespaceExport } from './@types';

/** Default main-thread budget, in milliseconds, between event-loop turns while declarations are bundled alongside transpilation */
const defaultYieldIntervalMs = 10;
const nodeModules = '/node_modules/';
const emptySet: ReadonlySet<string> = new Set();

/**
 * Resolves a promise on the next event-loop turn, after pending I/O callbacks
 * @param resolve - The function to call to resolve the promise
 */
const queueImmediateTask = (resolve: (value: void | PromiseLike<void>) => void) => void setImmediate(resolve);

/**
 * Import/export module specifiers are always string literals in parsed declaration files.
 * @param moduleSpecifier - The module specifier expression node from an import/export declaration
 */
function moduleSpecifierText(moduleSpecifier: Node) {
	return (moduleSpecifier as StringLiteral).text;
}

/**
 * Computes the relative module specifier from one path to another.
 * Ensures consistent POSIX-style path separators.
 * @param fromPath - The path of the importing module
 * @param toPath - The path of the target module
 */
function relativeModuleSpecifier(fromPath: string, toPath: string) {
	// Posix is used to ensure consistent path separators across platforms for module specifiers.
	const specifier = Paths.Posix.relative(Paths.Posix.directoryName(fromPath), toPath);

	return specifier.startsWith('.') ? specifier : `./${specifier}` as RelativePath;
}

/**
 * Merges structured external imports from the same module into single import statements.
 * Pure Map aggregation — no regex, no text parsing.
 *
 * @param imports - Structured external imports collected from all modules
 * @returns Array of merged, deduplicated import statement strings
 */
function mergeImports(imports: ExternalImport[]) {
	const raw = new Set<string>();
	// Map key: type-only marker, specifier and import attributes, so type-only, value and differently attributed imports stay separate
	const merged = new Map<string, { specifier: string; isType: boolean; names: Set<string>; attributes?: string }>();

	for (const imp of imports) {
		if (imp.kind === 'raw') {
			raw.add(imp.text);
			continue;
		}

		const key = `${imp.isType ? 'type:' : ''}${imp.specifier}${imp.attributes === undefined ? '' : ` ${imp.attributes}`}`;
		let entry = merged.get(key);
		if (entry === undefined) {
			entry = { specifier: imp.specifier, isType: imp.isType, names: new Set(), attributes: imp.attributes };
			merged.set(key, entry);
		}

		for (const name of imp.names) { entry.names.add(name) }
	}

	const result: string[] = [];
	for (const { specifier, isType, names, attributes } of merged.values()) {
		result.push(`${isType ? 'import type' : 'import'} { ${Array.from(names).sort().join(', ')} } from "${specifier}"${attributes === undefined ? '' : ` ${attributes}`};`);
	}

	for (const text of raw) { result.push(text) }

	return result;
}

/**
 * A minimal DTS bundler that combines TypeScript declaration files.
 * This replaces the Rollup-based approach with a simpler, more direct implementation
 * that leverages the declarations we already have in memory.
 *
 * Core responsibilities:
 * 1. Module resolution - Follow import/export statements between files
 * 2. Dependency ordering - Process files in correct order
 * 3. Code concatenation - Combine declarations into single output
 *
 * What it does NOT do:
 * - Create TypeScript programs (we already have one)
 * - Generate declarations (TypeScript does this)
 * - Complex tree-shaking (keep it simple)
 */
class DeclarationBundler implements Disposable {
	/** Time after which the next checkpoint yields */
	#nextYieldAt = 0;
	/** Snapshot layering the in-memory declaration paths over the host filesystem, so resolution sees unwritten declarations */
	#resolution: { snapshot: Snapshot; resolver: ModuleResolver } | undefined;
	/** Project declaration files from in-memory FileManager */
	readonly #declarationFiles: Map<AbsolutePath, CachedDeclaration> = new Map();
	/** External declaration files resolved from disk (node_modules) when resolve is enabled */
	readonly #externalDeclarationFiles: Map<AbsolutePath, CachedDeclaration> = new Map();
	/** d.ts Bundle Options */
	readonly #options: DtsBundleOptions;
	/** WeakMap cache for identifier collection to avoid re-parsing same source files */
	readonly #identifierCache = new WeakMap<SourceFile, IdentifierMap>();
	/** SourceFile cache keyed by path — survives across multiple bundle() calls (entry points) */
	readonly #sourceFileCache = new Map<AbsolutePath, SourceFile>();
	/** Module resolution cache for this bundler instance (unresolved specifiers are cached as undefined) */
	readonly #moduleResolutionCache = new Map<string, AbsolutePath | undefined>();
	/** Source-to-declaration path mapping cache to avoid redundant lookups during bundling */
	readonly #sourceToDeclarationCache = new Map<AbsolutePath, AbsolutePath>();
	/** Owns the resolution snapshot and module resolver; both are created on first use */
	readonly #resources = new DisposableStack();
	/** Main-thread budget between event-loop turns; undefined when bundling must not yield (no parallel transpile) */
	readonly #yieldIntervalMs: number | undefined;
	/** Pre-built matcher for external patterns — O(1) string lookups + cached regex tests */
	readonly #matchExternal: (id: string) => boolean;
	/** Pre-built matcher for noExternal patterns — O(1) string lookups + cached regex tests */
	readonly #matchNoExternal: (id: string) => boolean;
	static readonly #exportMapper = ({ localName, exportedName }: ExportedName) => localName === exportedName ? localName : `${localName} as ${exportedName}`;
	/** Same ordering as `localeCompare`, without rebuilding ICU collation state on every comparison */
	static readonly #collator = new Intl.Collator();
	static readonly #exportComparator = (a: ExportedName, b: ExportedName) => DeclarationBundler.#collator.compare(a.exportedName, b.exportedName);

	/**
	 * Creates a new DTS bundler instance
	 * @param dtsBundleOptions - Options for the DTS bundler
	 */
	constructor(dtsBundleOptions: DtsBundleOptions) {
		// Normalize all declaration file paths to ensure consistent lookups.
		// This handles cases where paths may be relative or use different separators
		for (const [ filePath, cachedDeclaration ] of dtsBundleOptions.declarationFiles) {
			this.#declarationFiles.set(Paths.absolute(filePath), cachedDeclaration);
		}

		this.#options = dtsBundleOptions;
		this.#yieldIntervalMs = dtsBundleOptions.parallelTranspile ? dtsBundleOptions.yieldIntervalMs ?? defaultYieldIntervalMs : undefined;

		// The caller owns this cache for one project lifetime.
		// Retain only syntax trees for current project declarations; external files and module-resolution results remain build-scoped.
		if (dtsBundleOptions.sourceFileCache !== undefined) {
			for (const path of dtsBundleOptions.sourceFileCache.keys()) {
				if (!this.#declarationFiles.has(path)) { dtsBundleOptions.sourceFileCache.delete(path) }
			}
		}

		this.#matchExternal = createPatternMatcher(dtsBundleOptions.external);
		this.#matchNoExternal = createPatternMatcher(dtsBundleOptions.noExternal);
	}

	/**
	 * Bundles entry points without duplicating modules shared between them.
	 * A shared module that is itself an entry point stays in that entry's output and is imported by the others;
	 * any other shared module is written once to its own declaration path (mirroring its source path) and imported from there.
	 * @param entryPoints - Named declaration entry points to bundle
	 * @returns Bundled entry contents and shared declaration module contents
	 */
	async bundle(entryPoints: EntryPoints<AbsolutePath>) {
		const graphs = new Map<string, { entryPoint: AbsolutePath; outputPath: AbsolutePath; graph: ModuleDependencyGraph }>();

		for (const [ entryName, entryPoint ] of Object.entries(entryPoints)) {
			await this.yieldToEventLoop(true);

			const dtsEntryPoint = this.#resolveEntryPoint(entryPoint, this.#options.compilerOptions);

			if (dtsEntryPoint === undefined) { continue }

			const outputPath = Paths.join(this.#options.compilerOptions.outDir, `${entryName}${FileExtension.DTS}`);
			graphs.set(entryName, { entryPoint: dtsEntryPoint, outputPath, graph: await this.#buildModuleGraph(dtsEntryPoint) });
		}

		const graphCounts = new Map<AbsolutePath, number>();
		const sharedSourceFiles = new Map<string, SourceFile>();

		for (const { graph } of graphs.values()) {
			for (const [ path, module ] of graph.modules) {
				graphCounts.set(path, (graphCounts.get(path) ?? 0) + 1);
				sharedSourceFiles.set(path, module.sourceFile);
			}
		}

		const entryOutputs = new Map(Array.from(graphs.values(), ({ entryPoint, outputPath }) => [ entryPoint, outputPath ]));
		const outputPaths = new Set(entryOutputs.values());
		const sharedModules = new Map<AbsolutePath, AbsolutePath>();

		for (const [ path, count ] of graphCounts) {
			if (count < 2 || !this.#declarationFiles.has(path)) { continue }

			// Entry modules are imported from their own entry output; other shared modules keep their mirrored declaration path
			const entryOutputPath = entryOutputs.get(path);

			if (entryOutputPath === undefined) {
				if (!path.startsWith(`${this.#options.compilerOptions.outDir}/`)) { throw new BundleError(`Shared declaration is outside outDir: ${path}`) }

				if (outputPaths.has(path)) { throw new BundleError(`Shared declaration output conflicts with a bundled entry point: ${path}`) }
			}

			sharedModules.set(path, entryOutputPath ?? path);
		}

		const entries = new Map<string, string>();

		for (const [ entryName, { entryPoint, outputPath, graph } ] of graphs) {
			let externalModules: ReadonlyMap<AbsolutePath, AbsolutePath> = sharedModules;

			if (sharedModules.has(entryPoint)) {
				const withoutEntry = new Map(sharedModules);
				withoutEntry.delete(entryPoint);
				externalModules = withoutEntry;
			}

			entries.set(entryName, await this.#bundleGraph(graph, entryPoint, externalModules, outputPath));
		}

		const sharedFiles = new Map<AbsolutePath, string>();

		for (const [ path, outputPath ] of sharedModules) {
			if (entryOutputs.has(path)) { continue }

			const declaration = this.#declarationFiles.get(path as AbsolutePath);

			if (declaration === undefined) { continue }

			const sourceFile = sharedSourceFiles.get(path);

			if (sourceFile === undefined) { throw new BundleError(`Shared declaration source file was not parsed: ${path}`) }

			const references = [
				...[ ...declaration.fileReferences ].map((reference) => {
					const sharedOutputPath = sharedModules.get(Paths.absolute(Paths.directoryName(path), reference));

					return `/// <reference path="${sharedOutputPath === undefined ? reference : relativeModuleSpecifier(outputPath, sharedOutputPath)}" />`;
				}),
				...[ ...declaration.typeReferences ].map((reference) => `/// <reference types="${reference}" />`)
			];

			const code = new MagicString(declaration.code);

			for (const statement of sourceFile.statements) {
				if (!(isImportDeclaration(statement) || isExportDeclaration(statement)) || !statement.moduleSpecifier) { continue }

				// Resolve the module specifier to an absolute path and check if it corresponds to a shared module.
				const resolvedPath = this.#resolveModules([ moduleSpecifierText(statement.moduleSpecifier) ], path)[0];
				const sharedOutputPath = resolvedPath === undefined ? undefined : sharedModules.get(Paths.absolute(resolvedPath));

				if (sharedOutputPath !== undefined) {
					code.overwrite(statement.moduleSpecifier.getStart() + 1, statement.moduleSpecifier.getEnd() - 1, relativeModuleSpecifier(outputPath, sharedOutputPath));
				}
			}

			const outputCode = [ ...references, code.toString() ].filter(Boolean).join(newLine);
			sharedFiles.set(outputPath, DeclarationProcessor.postProcess(this.#parse(path, outputCode)));
		}

		return { entries, sharedFiles };
	}

	/**
	 * Gives the event loop one turn when bundling runs alongside transpilation, so esbuild plugin callbacks, IPC and
	 * output writes are not starved by a large entry point. A no-op when no transpile runs in parallel.
	 * @param force - Yield even if the current synchronous slice is still within its budget
	 */
	async yieldToEventLoop(force = false): Promise<void> {
		if (this.#yieldIntervalMs === undefined || (!force && performance.now() < this.#nextYieldAt)) { return }

		// Yield to the event loop to allow other tasks to run before continuing with bundling/transpilation.
		await new Promise<void>(queueImmediateTask);

		this.#nextYieldAt = performance.now() + this.#yieldIntervalMs;
	}

	/** Releases the resolution snapshot and resolver, and clears caches to free memory once all entry points have been bundled. */
	[Symbol.dispose](): void {
		this.#resolution = undefined;
		this.#resources.dispose();
		this.#externalDeclarationFiles.clear();
		this.#moduleResolutionCache.clear();
		this.#sourceFileCache.clear();
		this.#sourceToDeclarationCache.clear();
	}

	/**
	 * Resolve entry point from source path to declaration path
	 * @param entryPoint - The entry point file path
	 * @param compilerOptions - Minimal compiler options with outDir and rootDir
	 * @returns Resolved declaration entry point path
	 */
	#resolveEntryPoint(entryPoint: AbsolutePath, compilerOptions: DtsCompilerOptions) {
		// Convert source path to declaration path and normalize to POSIX format (TypeScript expects forward slashes)
		const dtsEntryPoint = Paths.absolute(entryPoint.endsWith(FileExtension.DTS) ? entryPoint : this.#sourceToDeclarationPath(entryPoint));

		if (this.#declarationFiles.has(dtsEntryPoint)) { return dtsEntryPoint }

		// Source entry points with no declaration file have no exportable API (e.g. CLI scripts)
		if (!entryPoint.endsWith(FileExtension.DTS)) { return undefined }

		// A .d.ts was passed directly but not found — this is a real error
		const availableFiles = Array.from(this.#declarationFiles.keys());
		const similarFiles = availableFiles.filter((filePath) => filePath.includes(Paths.baseName(entryPoint)));

		throw new BundleError(
			`Entry point declaration file not found: ${dtsEntryPoint || 'unknown'}\n` +
			`Original entry: ${entryPoint}\n` +
			`Compiler options: outDir=${compilerOptions.outDir || 'dist'}, rootDir=${compilerOptions.rootDir || 'not set'}\n` +
			`Similar files found:\n${similarFiles.map(f => `  - ${f}`).join('\n')}\n` +
			`Total available files: ${availableFiles.length}`
		);
	}

	/**
	 * Builds the ambient namespace standing in for a bundled `export * as name from './module'`.
	 * @param localName - Collision-free namespace identifier
	 * @param members - Bindings of the re-exported module
	 * @returns The `declare namespace` text
	 */
	static #namespaceDeclaration(localName: string, members: ExportedName[]): string {
		const values: string[] = [];
		const types: string[] = [];

		for (const member of members.toSorted(DeclarationBundler.#exportComparator)) {
			(member.isType ? types : values).push(DeclarationBundler.#exportMapper(member));
		}

		const lines = [ `declare namespace ${localName} {` ];

		if (values.length > 0) { lines.push(`\texport { ${values.join(', ')} };`) }

		if (types.length > 0) { lines.push(`\texport type { ${types.join(', ')} };`) }

		lines.push('}');

		return lines.join(newLine);
	};

	/**
	 * Parses declaration text through the TypeScript API. The remote lease is released immediately;
	 * the decoded AST stays readable locally for syntax-only traversal.
	 * @param fileName - Declaration file path
	 * @param text - Declaration source text
	 */
	#parse(fileName: string, text: string): SourceFile {
		using retained = this.#options.api.createSourceFile(fileName, text);

		return retained.sourceFile;
	}

	/**
	 * Returns whether a resolved path has declaration content available for bundling.
	 * With `resolve` enabled, declarations outside the project are loaded from disk and pre-processed on first use.
	 * @param path - Resolved absolute path
	 */
	#hasDeclaration(path: AbsolutePath) {
		if (this.#declarationFiles.has(path) || this.#externalDeclarationFiles.has(path)) { return true }

		if (!this.#options.resolve || !path.endsWith(FileExtension.DTS)) { return false }

		let rawContent: string;
		try { rawContent = readFileSync(path, Encoding.utf8) } catch { return false }

		this.#externalDeclarationFiles.set(path, DeclarationProcessor.preProcess(this.#parse(path, rawContent)));

		return true;
	}

	/**
	 * Convert a source file path to its corresponding declaration file path
	 * @param sourcePath - Absolute path to a source file (.ts, .tsx)
	 * @returns The corresponding .d.ts path, or the original source path if no declaration exists
	 */
	#sourceToDeclarationPath(sourcePath: AbsolutePath) {
		// Check cache first to avoid redundant lookups during multi-entry-point bundling
		const cached = this.#sourceToDeclarationCache.get(sourcePath);

		if (cached !== undefined) { return cached }

		let result: AbsolutePath;
		const { outDir, rootDir } = this.#options.compilerOptions;
		const sourceWithoutExt = sourcePath.substring(0, sourcePath.lastIndexOf('.') || sourcePath.length);

		if (rootDir) {
			// With explicit rootDir, calculate relative path and append to outDir.
			// Paths.Posix.normalize is required because TypeScript internally uses POSIX-style forward slashes for module resolution paths regardless of the host platform
			const dtsPath = Paths.Posix.normalize(Paths.join(outDir, Paths.relative(rootDir, sourceWithoutExt) + FileExtension.DTS));
			result = this.#declarationFiles.has(dtsPath) ? dtsPath : sourcePath;
		} else {
			// Without rootDir, find .d.ts file by stripping outDir and matching the suffix
			// TypeScript preserves directory structure, so /path/to/project/src/foo/bar.ts
			// becomes /path/to/project/dist/foo/bar.d.ts
			// We can match by checking if they share the same relative path structure
			// When multiple paths match (e.g. stale cache entries from old builds with different rootDir),
			// prefer the shortest relative path — TypeScript strips rootDir from output paths, so the
			// correct current path is always at least as short as any stale path from a shallower rootDir.
			let bestMatch: AbsolutePath | undefined;
			let bestRelativeLength = Infinity;

			for (const dtsPath of this.#declarationFiles.keys()) {
				if (!dtsPath.endsWith(FileExtension.DTS)) { continue }

				// Strip outDir prefix from declaration path: /path/to/project/dist/foo/bar.d.ts -> foo/bar.d.ts
				const withoutOutDir = dtsPath.startsWith(outDir + '/') ? dtsPath.slice(outDir.length + 1) : dtsPath;

				// Remove .d.ts extension to get relative path: foo/bar.d.ts -> foo/bar
				const relativeDtsPath = withoutOutDir.slice(0, -FileExtension.DTS.length);

				// Check if source path ends with the same relative path structure
				// Ensure it's a complete path segment match by checking for '/' before the match
				if ((sourceWithoutExt === relativeDtsPath || sourceWithoutExt.endsWith('/' + relativeDtsPath)) && relativeDtsPath.length < bestRelativeLength) {
					bestRelativeLength = relativeDtsPath.length;
					bestMatch = dtsPath;
				}
			}

			result = bestMatch ?? sourcePath;
		}

		// Cache the result for subsequent lookups
		this.#sourceToDeclarationCache.set(sourcePath, result);

		return result;
	}

	/**
	 * Creates the resolution snapshot and resolver on first use.
	 * Layer contents are empty because resolution only probes for existence; bundling reads the in-memory declarations directly.
	 */
	#getResolution() {
		if (this.#resolution !== undefined) { return this.#resolution }

		const declarationPathMapper = (path: AbsolutePath) => [ path, '' ] as const;

		const { api, compilerOptions: { paths, moduleResolution, configFilePath } } = this.#options;
		const [ snapshot, resolver ] = api.batch(api.createSnapshot.gen({ fileSystem: createFileSystemLayer(Array.from(this.#declarationFiles.keys(), declarationPathMapper)) }), api.createModuleResolver.gen({ paths, moduleResolution, configFilePath }));

		return this.#resolution = { snapshot: this.#resources.use(snapshot), resolver: this.#resources.use(resolver) };
	}

	/**
	 * Resolves module imports using TypeScript's resolution algorithm with path mapping support.
	 * Uncached specifiers of one containing file are resolved in a single batched API round trip.
	 * @param specifiers - The module specifiers to resolve
	 * @param containingFile - The file containing the imports
	 * @returns Resolved file paths (or undefined) in specifier order
	 */
	#resolveModules(specifiers: readonly string[], containingFile: string) {
		const containingDirectory = Paths.directoryName(containingFile);
		const cacheKey = (specifier: string) => `${specifier}|${containingDirectory}`;
		const unresolved = specifiers.filter((specifier) => !this.#moduleResolutionCache.has(cacheKey(specifier)));

		if (unresolved.length > 0) {
			const { snapshot, resolver } = this.#getResolution();
			const results = this.#options.api.batch(...unresolved.map((specifier) => resolver.resolveModuleName.gen(specifier, containingDirectory, undefined, { snapshot })));

			for (let i = 0; i < unresolved.length; i++) {
				let resolvedFileName = results[i].resolvedModule?.resolvedFileName as AbsolutePath | undefined;

				// If TypeScript resolved to a source file (.ts/.tsx), convert to the corresponding .d.ts file
				// This handles cases where tsconfig paths point to source files instead of declarations
				if (resolvedFileName !== undefined && this.#options.compilerOptions.paths && sourceScriptExtensionExpression.test(resolvedFileName)) {
					resolvedFileName = this.#sourceToDeclarationPath(resolvedFileName);
				}

				this.#moduleResolutionCache.set(cacheKey(unresolved[i]), resolvedFileName);
			}
		}

		return specifiers.map((specifier) => this.#moduleResolutionCache.get(cacheKey(specifier)));
	}

	/**
	 * Topological sort of modules to ensure dependencies come before dependents
	 * @param modules - Map of all modules
	 * @param entryPoint - Starting point for sorting
	 * @returns Array of modules in dependency order
	 */
	#sortModules(modules: ReadonlyMap<AbsolutePath, ModuleInfo>, entryPoint: AbsolutePath) {
		const sorted: ModuleInfo[] = [];
		const visited = new Set<AbsolutePath>();
		const visiting = new Set<AbsolutePath>();
		const visitStack: AbsolutePath[] = [];

		/**
		 * Visit a module and its dependencies in topological order
		 * @param path - Module path to visit
		 */
		const visit = (path: AbsolutePath): void => {
			if (visited.has(path)) { return }

			if (visiting.has(path)) {
				const cyclePath = [ ...visitStack.slice(visitStack.indexOf(path)), path ].map((p) => Paths.relative(this.#options.currentDirectory, p)).join(' -> ');
				Logger.warn(`Circular dependency detected: ${cyclePath}`);

				visited.add(path);

				return;
			}

			visiting.add(path);
			visitStack.push(path);

			const module = modules.get(path);
			if (!module) {
				visiting.delete(path);
				visitStack.pop();

				return;
			}

			// Visit dependencies first
			for (const importPath of module.imports) { visit(importPath) }

			visiting.delete(path);
			visitStack.pop();
			visited.add(path);
			sorted.push(module);
		};

		visit(entryPoint);

		return sorted;
	}

	/**
	 * Recursively collect type and value identifiers from AST statements
	 * This is more robust and performant than regex matching
	 * @param statements - AST statements to analyze
	 * @param sourceFile - Optional source file for caching results
	 * @returns Sets of type and value identifiers
	 */
	#collectIdentifiers<const S extends Iterable<Node>>(statements: S, sourceFile?: SourceFile) {
		let result: IdentifierMap | undefined;

		// Check cache if we have the source file
		if (sourceFile) {
			result = this.#identifierCache.get(sourceFile);

			if (result) { return result }
		}

		const types = new Set<string>();
		const values = new Set<string>();

		const collectNestedIdentifiers = (subStatements: Iterable<Node>) => {
			const { types: subTypes, values: subValues } = this.#collectIdentifiers(subStatements);

			for (const type of subTypes) { types.add(type) }
			for (const value of subValues) { values.add(value) }
		};

		for (const statement of statements) {
			// Skip imports
			if (isImportDeclaration(statement)) { continue }

			if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
				// Type declarations
				types.add(statement.name.text);
			} else if (isEnumDeclaration(statement) || isFunctionDeclaration(statement) || isClassDeclaration(statement)) {
				// Value declarations (enums, functions, classes)
				if (statement.name) { values.add(statement.name.text) }
			} else if (isVariableStatement(statement)) {
				// Variable declarations
				for (const { name } of statement.declarationList.declarations) {
					if (isIdentifier(name)) { values.add(name.text) }
				}
			} else if (isModuleDeclaration(statement)) {
				// Module/namespace declarations are values
				if (statement.name && isIdentifier(statement.name)) { values.add(statement.name.text) }
				// Walk into the module body's statements directly via AST (avoids slow getChildren()).
				// Nested namespace bodies are walked recursively by re-entering this branch.
				const body = statement.body;
				if (body && isModuleBlock(body)) {
					collectNestedIdentifiers(body.statements);
				} else if (body && isModuleDeclaration(body)) {
					collectNestedIdentifiers([body]);
				}
			}
		}

		result = { types, values };

		// Cache if we have the source file
		if (sourceFile) { this.#identifierCache.set(sourceFile, result) }

		return result;
	}

	/**
	 * Remove import/export statements from code, but preserve external imports
	 * Fully AST-based approach using magic-string for efficient code manipulation
	 * @param code - Declaration file content
	 * @param sourceFile - Parsed source file AST (required to avoid re-parsing)
	 * @param identifiers - Pre-computed type and value identifiers (to avoid re-computation)
	 * @param bundledImportPaths - Set of resolved file paths that were bundled (to exclude from external imports)
	 * @param renameMap - Map of renamed identifiers (name:path -> newName)
	 * @param modulePath - Path of current module for looking up renames
	 * @param dependencyExports - Export bindings collected from dependencies already processed
	 * @returns Object with processed code, collected external imports, and exported names (separated by type/value)
	 */
	#stripImportsExports(code: string, sourceFile: SourceFile, identifiers: IdentifierMap, bundledImportPaths: ReadonlySet<string>, renameMap: Map<string, string>, modulePath: string, dependencyExports: ReadonlyMap<string, ReadonlyMap<string, ExportedName>>, sharedModules: ReadonlyMap<string, AbsolutePath>, bundleOutputPath: AbsolutePath): DeclarationCode {
		const externalImports: ExternalImport[] = [];
		const typeExports: ExportedName[] = [];
		const valueExports: ExportedName[] = [];
		const namespaceExports: NamespaceExport[] = [];
		// Candidate bindings from bundled `export * from` statements, resolved once all explicit exports are known
		const starExports: ExportedName[] = [];
		// Use pre-computed identifiers directly - they're already Sets
		const { types: typeIdentifiers, values: valueIdentifiers } = identifiers;
		// Use MagicString for efficient code manipulation
		const magic = new MagicString(code);
		const moduleRenames = new Map<string, string>();
		const localBindings = new Map<string, string>();
		const exportsMapper = (name: string) => moduleRenames.get(localBindings.get(name) ?? name) ?? localBindings.get(name) ?? name;

		// Apply renaming for identifiers from this module
		for (const name of typeIdentifiers) {
			const renamed = renameMap.get(`${name}:${modulePath}`);

			if (renamed) { moduleRenames.set(name, renamed) }
		}

		for (const name of valueIdentifiers) {
			const renamed = renameMap.get(`${name}:${modulePath}`);

			if (renamed) { moduleRenames.set(name, renamed) }
		}

		// Namespace aliases from bundled `import * as Alias` statements.
		// When a namespace import is bundled (inlined), all `Alias.Name` qualified references must be flattened to plain `Name` since the alias is removed.
		const bundledNamespaceAliases = new Set<string>();

		// Process all statements using the source file AST
		for (const statement of sourceFile.statements) {
			if (isImportDeclaration(statement)) {
				const moduleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
				const resolvedPath = this.#resolveModules([ moduleSpecifier ], modulePath)[0];
				const sharedOutputPath = resolvedPath === undefined ? undefined : sharedModules.get(Paths.absolute(resolvedPath));
				const outputSpecifier = sharedOutputPath === undefined ? moduleSpecifier : relativeModuleSpecifier(bundleOutputPath, sharedOutputPath);

				if (outputSpecifier !== moduleSpecifier) {
					magic.overwrite(statement.moduleSpecifier.getStart() + 1, statement.moduleSpecifier.getEnd() - 1, outputSpecifier);
				}

				const resolvedExports = resolvedPath === undefined ? undefined : dependencyExports.get(resolvedPath);
				const importClause = statement.importClause;

				if (resolvedExports && importClause) {
					if (importClause.name) {
						const imported = resolvedExports.get('default');

						if (imported) { localBindings.set(importClause.name.text, imported.localName) }
					}

					if (importClause.namedBindings && isNamedImports(importClause.namedBindings)) {
						for (const { name, propertyName } of importClause.namedBindings.elements) {
							const imported = resolvedExports.get(propertyName?.text ?? name.text);

							if (imported) { localBindings.set(name.text, imported.localName) }
						}
					}
				}

				// Keep as external if:
				// 1. It explicitly matches external patterns, OR
				// 2. It's NOT in the bundled specifiers (meaning it didn't get bundled in module graph)
				// Bundled specifiers are those that were successfully resolved and added to the module graph
				// Keep as external import if it's explicitly external OR wasn't bundled
				if (this.#matchExternal(moduleSpecifier) || !bundledImportPaths.has(moduleSpecifier)) {
					// Extract structured metadata from the AST instead of round-tripping through text+regex
					const importClause = statement.importClause;
					const namedBindings = importClause?.namedBindings;

					if (importClause && !importClause.name && namedBindings && isNamedImports(namedBindings)) {
						// Standard `import { A, B } from 'x'` or `import type { A } from 'x'`
						const names: string[] = [];

						for (const { name, propertyName, isTypeOnly } of namedBindings.elements) {
							const original = propertyName?.text;
							// Inline `type` markers (e.g. `import { type Foo }`) are preserved per-element
							const prefix = isTypeOnly ? 'type ' : '';

							names.push(original ? `${prefix}${original} as ${name.text}` : `${prefix}${name.text}`);
						}

						// Import attributes (e.g. `with { "resolution-mode": "import" }`) change how the specifier resolves, so keep them
						const attributes = statement.attributes === undefined ? undefined : code.substring(statement.attributes.pos, statement.attributes.end).trim();

						externalImports.push({ kind: 'named', specifier: outputSpecifier, isType: importClause?.phaseModifier === SyntaxKind.TypeKeyword, names, attributes });
					} else {
						// Default imports, namespace imports, side-effect imports — keep verbatim
						externalImports.push({ kind: 'raw', text: magic.slice(statement.pos, statement.end).trim() });
					}
				} else if (statement.importClause?.namedBindings && isNamespaceImport(statement.importClause.namedBindings)) {
					// Bundled namespace import: `import * as Alias from './bundled'`
					// Record alias so qualified references (Alias.X) can be flattened to X
					bundledNamespaceAliases.add(statement.importClause.namedBindings.name.text);
				}
				// Otherwise it was bundled - don't keep it as external, it's in the combined code

				// Remove all import statements (internal ones are bundled, external ones are collected above)
				magic.remove(statement.pos, statement.end);
			} else if (isExportDeclaration(statement)) {
				// Export from another module: export { X } from './module'
				if (statement.moduleSpecifier) {
					const exportModuleSpecifier = moduleSpecifierText(statement.moduleSpecifier);
					const resolvedTarget = this.#resolveModules([ exportModuleSpecifier ], modulePath)[0];
					const sharedOutputPath = resolvedTarget === undefined ? undefined : sharedModules.get(Paths.absolute(resolvedTarget));
					const outputSpecifier = sharedOutputPath === undefined ? exportModuleSpecifier : relativeModuleSpecifier(bundleOutputPath, sharedOutputPath);

					if (outputSpecifier !== exportModuleSpecifier) {
						magic.overwrite(statement.moduleSpecifier.getStart() + 1, statement.moduleSpecifier.getEnd() - 1, outputSpecifier);
					}

					const isBundled = bundledImportPaths.has(exportModuleSpecifier);
					const resolvedPath = isBundled ? this.#resolveModules([ exportModuleSpecifier ], modulePath)[0] : undefined;
					const resolvedExports = resolvedPath === undefined ? undefined : dependencyExports.get(resolvedPath);

					if (resolvedExports) {
						const { exportClause } = statement;

						if (exportClause === undefined) {
							// `export * from './module'` re-exports every binding except `default`
							for (const [ exportedName, { localName, isType } ] of resolvedExports) {
								if (exportedName !== 'default') { starExports.push({ localName, exportedName, isType: statement.isTypeOnly || isType }) }
							}
						} else if (isNamespaceExport(exportClause)) {
							// `export * as name from './module'` exposes the whole module object, including `default`
							namespaceExports.push({ exportedName: exportClause.name.text, isType: statement.isTypeOnly, members: Array.from(resolvedExports.values()) });
						} else {
							for (const { name, propertyName, isTypeOnly } of exportClause.elements) {
								const importedName = propertyName?.text ?? name.text;
								const exported = { localName: resolvedExports.get(importedName)?.localName ?? importedName, exportedName: name.text, isType: statement.isTypeOnly || isTypeOnly };

								if (exported.isType) { typeExports.push(exported) } else { valueExports.push(exported) }
							}
						}
					}
					// Keep external or unresolved re-exports verbatim so public APIs are preserved.
					// Only strip re-exports that were actually bundled into the combined output.
					if (isBundled) { magic.remove(statement.pos, statement.end) }

					continue;
				}

				// Standalone export: export { X, Y, Z }, export type { A, B }, or the empty module marker export {}
				if (statement.exportClause && isNamedExports(statement.exportClause)) {
					for (const { name, propertyName } of statement.exportClause.elements) {
						const localName = propertyName?.text ?? name.text;
						const exported = { localName: exportsMapper(localName), exportedName: name.text, isType: statement.isTypeOnly };

						// Categorize as type or value. Values take precedence (classes/enums are both)
						if (valueIdentifiers.has(localName) || localBindings.has(localName) && !statement.isTypeOnly) {
							valueExports.push(exported);
						} else if (typeIdentifiers.has(localName) || localBindings.has(localName)) {
							typeExports.push(exported);
						} else {
							// Unknown, assume value (safer default)
							valueExports.push(exported);
						}
					}

					// Remove the export statement
					magic.remove(statement.pos, statement.end);
				}
			} else if (isExportAssignment(statement)) {
				// Handle export default assignment: export default ...
				if (isIdentifier(statement.expression)) {
					valueExports.push({ localName: exportsMapper(statement.expression.text), exportedName: 'default', isType: false });
				}

				magic.remove(statement.pos, statement.end);
			}
		}

		// Apply renaming to all identifier occurrences and flatten qualified names from bundled namespaces.
		// Combined into a single AST walk to avoid traversing the tree multiple times.
		// IMPORTANT: Only visit declaration statements, NOT import/export declarations.
		// Import and export declarations are removed via magic.remove() above.
		// Calling magic.overwrite() on an already-removed range reinserts the text.
		for (const [localName, importedName] of localBindings) { moduleRenames.set(localName, exportsMapper(importedName)) }

		const hasRenames = moduleRenames.size > 0;
		const hasBundledAliases = bundledNamespaceAliases.size > 0;

		if (hasRenames || hasBundledAliases) {
			const visit = (node: Node): void => {
				if (hasBundledAliases && isQualifiedName(node) && isIdentifier(node.left) && bundledNamespaceAliases.has(node.left.text)) {
					// Flatten `Alias.Name` → `Name` when the alias was bundled away.
					magic.remove(node.left.getStart(), node.right.getStart());
				} else if (hasRenames && isIdentifier(node)) {
					const renamed = moduleRenames.get(node.text);

					if (renamed) { magic.overwrite(node.getStart(), node.end, renamed) }
				}

				node.forEachChild(visit);
			};

			for (const statement of sourceFile.statements) {
				if (!isImportDeclaration(statement) && !isExportDeclaration(statement) && !isExportAssignment(statement)) { visit(statement) }
			}
		}

		// Value exports take precedence - remove any types that are also values. `isType` is normalized to the bucket so dependents see the binding kind
		const finalValueExports = new Map<string, ExportedName>();
		for (const exported of valueExports) { finalValueExports.set(exported.exportedName, { ...exported, isType: false }) }

		const finalTypeExports = new Map<string, ExportedName>();
		for (const exported of typeExports) {
			if (!finalValueExports.has(exported.exportedName)) { finalTypeExports.set(exported.exportedName, { ...exported, isType: true }) }
		}

		// Star exports never shadow explicit exports, and a name provided by several stars with different bindings is ambiguous and not exported
		const explicitNames = new Set([ ...finalValueExports.keys(), ...finalTypeExports.keys(), ...namespaceExports.map(({ exportedName }) => exportedName) ]);
		for (const [ exportedName, candidates ] of Map.groupBy(starExports, ({ exportedName }) => exportedName)) {
			const [ first ] = candidates as [ ExportedName, ...ExportedName[] ];

			if (explicitNames.has(exportedName) || candidates.some(({ localName }) => localName !== first.localName)) { continue }

			// The same binding reached through several stars stays a value unless every path is type-only
			const exported = { ...first, isType: candidates.every(({ isType }) => isType) };

			if (exported.isType) { finalTypeExports.set(exportedName, exported) } else { finalValueExports.set(exportedName, exported) }
		}

		return { code: magic.toString(), externalImports, typeExports: Array.from(finalTypeExports.values()), valueExports: Array.from(finalValueExports.values()), namespaceExports };
	}

	/**
	 * Parses the not yet cached declarations among `paths` in bounded API batches and caches their syntax trees.
	 * Leases are released as soon as each batch is parsed; the decoded trees stay readable locally.
	 * @param paths - Normalized module paths about to be visited
	 */
	async #parseDeclarations(paths: readonly AbsolutePath[]) {
		const pending: Array<readonly [ AbsolutePath, string ]> = [];

		for (const path of paths) {
			if (this.#sourceFileCache.has(path)) { continue }

			const declaration = this.#declarationFiles.get(path);
			const cached = declaration ?? this.#externalDeclarationFiles.get(path);

			if (cached === undefined) { continue }

			const reusable = declaration === undefined ? undefined : this.#options.sourceFileCache?.get(path);

			if (reusable?.text === cached.code && reusable.sourceFile.text === cached.code) {
				this.#sourceFileCache.set(path, reusable.sourceFile);
			} else {
				pending.push([ path, cached.code ]);
			}
		}

		// Parse one bounded batch per call so every lease is released before the event loop may run other work
		for (let start = 0, pendingLength = pending.length; start < pendingLength; start += sourceFileBatchSize) {
			if (start > 0) { await this.yieldToEventLoop() }

			const batch = pending.slice(start, start + sourceFileBatchSize);
			const sourceFiles = parseSourceFiles(this.#options.api, batch, (sourceFile) => sourceFile);

			for (let i = 0, batchLength = batch.length; i < batchLength; i++) {
				const [ path, text ] = batch[i];
				const sourceFile = sourceFiles[i];
				this.#sourceFileCache.set(path, sourceFile);

				if (this.#declarationFiles.has(path)) { this.#options.sourceFileCache?.set(path, { text, sourceFile }) }
			}
		}
	}

	/**
	 * Build a dependency graph of all modules starting from entry point.
	 * Modules are discovered breadth-first so each newly discovered set of modules is parsed in batched round trips.
	 * @param entryPoint - The entry point file path
	 * @returns Map of file paths to module information with bundled specifiers tracked
	 */
	async #buildModuleGraph(entryPoint: AbsolutePath): Promise<ModuleDependencyGraph> {
		// Normalized paths, so the same file is never visited twice with different path representations
		let frontier: AbsolutePath[] = [ Paths.absolute(entryPoint) ];
		const visited = new Set<string>(frontier);
		const modules = new Map<AbsolutePath, ModuleInfo>();
		// Maps module path to bundled import specifiers
		const bundledSpecifiers = new Map<string, Set<string>>();

		while (frontier.length > 0) {
			await this.#parseDeclarations(frontier);

			const next: AbsolutePath[] = [];

			for (const path of frontier) {
				await this.yieldToEventLoop();

				const cached = this.#declarationFiles.get(path) ?? this.#externalDeclarationFiles.get(path);
				const sourceFile = this.#sourceFileCache.get(path);

				// File not in our declaration map - it's external
				if (cached === undefined || sourceFile === undefined) { continue }

				// Declarations are already pre-processed. Use the cached code and references when creating the module info
				const module: ModuleInfo = {
					path,
					code: cached.code,
					imports: new Set(),
					typeReferences: new Set(cached.typeReferences),
					fileReferences: new Set(cached.fileReferences),
					sourceFile,
					// Cache identifiers from source (since that's what we'll use)
					identifiers: this.#collectIdentifiers(sourceFile.statements, sourceFile)
				};

				const specifiers: string[] = [];
				const bundledSpecs = new Set<string>();

				// Extract import specifiers, then resolve them in one batch
				for (const statement of sourceFile.statements) {
					if ((isImportDeclaration(statement) || isExportDeclaration(statement)) && statement.moduleSpecifier !== undefined) {
						const specifier = moduleSpecifierText(statement.moduleSpecifier);

						// Skip explicit external modules
						if (!this.#matchExternal(specifier)) { specifiers.push(specifier) }
					}
				}

				const resolvedPaths = this.#resolveModules(specifiers, path);

				for (let i = 0, length = specifiers.length; i < length; i++) {
					const specifier = specifiers[i];
					const resolvedPath = resolvedPaths[i];

					// Skip node_modules packages unless they're in noExternal list
					if (resolvedPath?.includes(nodeModules) && !this.#matchNoExternal(specifier)) { continue }

					if (resolvedPath !== undefined && this.#hasDeclaration(resolvedPath)) {
						module.imports.add(resolvedPath);
						// Track the original specifier
						bundledSpecs.add(specifier);

						// Queue the dependency for the next breadth-first pass
						const dependency = Paths.absolute(resolvedPath);

						if (!visited.has(dependency)) {
							visited.add(dependency);
							next.push(dependency);
						}
					}
				}

				modules.set(path, module);
				bundledSpecifiers.set(path, bundledSpecs);
			}

			frontier = next;
		}

		return { modules, bundledSpecifiers };
	}

	/**
	 * Combine modules into a single output string
	 * @param sortedModules - Modules in dependency order
	 * @param bundledSpecifiers - Map of module paths to their bundled import specifiers
	 * @returns Object containing combined code, all exported identifiers, and all declarations from bundled modules
	 */
	async #combineModules(sortedModules: ModuleInfo[], bundledSpecifiers: ReadonlyMap<string, ReadonlySet<string>>, sharedModules: ReadonlyMap<string, AbsolutePath> = new Map(), bundleOutputPath: AbsolutePath = this.#options.compilerOptions.outDir) {
		// Identifiers unavailable for synthesized namespaces; built only when a bundled `export * as` needs one
		let reservedNames: Set<string> | undefined;
		const separator  = newLine + newLine;
		// Use Sets directly to deduplicate as we collect — avoids intermediate arrays + later `new Set(array)` round-trips
		const typeReferencesSet = new Set<string>();
		const fileReferencesSet = new Set<string>();
		const allExternalImports: ExternalImport[] = [];
		const valueExports = new Map<string, ExportedName>();
		const typeExports = new Map<string, ExportedName>();
		const moduleExports = new Map<string, Map<string, ExportedName>>();
		const codeBlocks: string[] = [];
		// Track declarations per module to detect conflicts and rename
		const declarationSources = new Map<string, Set<string>>(); // identifier -> Set of module paths
		const renameMap = new Map<string, string>(); // original name + module -> renamed identifier
		const namespaceBlockPredicate = (block: string) => block.length > 0;

		// First pass: collect all declarations and detect conflicts
		for (const { path, identifiers: { types, values } } of sortedModules) {
			for (const name of types) {
				let set = declarationSources.get(name);

				if (set === undefined) { declarationSources.set(name, set = new Set()) }

				set.add(path);
			}

			for (const name of values) {
				let set = declarationSources.get(name);

				if (set === undefined) { declarationSources.set(name, set = new Set()) }

				set.add(path);
			}
		}

		// Second pass: generate unique names for conflicting identifiers
		for (const [ name, sourcesSet ] of declarationSources) {
			if (sourcesSet.size > 1) {
				// First module keeps original name, subsequent modules get $1, $2, etc. Each candidate is verified against all known declarations to avoid collisions
				let suffix = 1;
				const modulePaths = sourcesSet.values();

				modulePaths.next();

				for (const modulePath of modulePaths) {
					let candidate = `${name}$${suffix}`;

					while (declarationSources.has(candidate)) { candidate = `${name}$${++suffix}` }

					renameMap.set(`${name}:${modulePath}`, candidate);
					suffix++;
				}
			}
		}

		// Collect all references and code
		for (const { path, typeReferences, fileReferences, sourceFile, code, identifiers: { types, values } } of sortedModules) {
			await this.yieldToEventLoop();

			// Collect references — Sets dedupe as we go
			for (const typeReference of typeReferences) { typeReferencesSet.add(typeReference) }
			for (const fileReference of fileReferences) { fileReferencesSet.add(fileReference) }

			// Strip import/export statements, preserving external imports.
			// Use cached identifiers and sourceFile (both always present after buildModuleGraph).
			const bundledForThisModule = bundledSpecifiers.get(path) ?? emptySet;
			const { code: strippedCode, externalImports, typeExports: moduleTypeExports, valueExports: moduleValueExports, namespaceExports } = this.#stripImportsExports(code, sourceFile, { types, values }, bundledForThisModule, renameMap, path, moduleExports, sharedModules, bundleOutputPath);

			// Collect external imports from all modules (merged later by mergeImports)
			for (const imp of externalImports) { allExternalImports.push(imp) }

			const namespaceBlocks: string[] = [];
			for (const { exportedName, isType, members } of namespaceExports) {
				reservedNames ??= new Set([ ...declarationSources.keys(), ...renameMap.values() ]);

				let localName = exportedName;

				for (let suffix = 1; reservedNames.has(localName); suffix++) { localName = `${exportedName}$${suffix}` }

				reservedNames.add(localName);
				namespaceBlocks.push(DeclarationBundler.#namespaceDeclaration(localName, members));

				const exported = { localName, exportedName, isType };

				if (isType) { moduleTypeExports.push(exported) } else { moduleValueExports.push(exported) }
			}

			const exportsForModule = new Map<string, ExportedName>();

			for (const exported of moduleValueExports) { exportsForModule.set(exported.exportedName, exported) }

			for (const exported of moduleTypeExports) { exportsForModule.set(exported.exportedName, exported) }

			moduleExports.set(path, exportsForModule);

			// Only the entry module defines the public API. Dependencies are emitted for
			// referenced declarations but their private exports must not leak out.
			if (path === sortedModules[sortedModules.length - 1]?.path) {
				for (const exported of moduleValueExports) { valueExports.set(exported.exportedName, exported) }
				for (const exported of moduleTypeExports) { typeExports.set(exported.exportedName, exported) }
			}

			// Skip modules that only contain imports/exports (pure re-export files)
			const moduleCode = [ strippedCode.trim(), ...namespaceBlocks ].filter(namespaceBlockPredicate).join(separator);

			if (moduleCode.length > 0) { codeBlocks.push(moduleCode) }
		}

		// Merge imports from the same module instead of simple deduplication
		const mergedExternalImports = mergeImports(allExternalImports);

		// Infer /// <reference types="..." /> from node: protocol imports so the .d.ts is self-contained
		for (const imp of mergedExternalImports) {
			if (imp.includes('"node:') || imp.includes('\'node:')) { typeReferencesSet.add('node') }
		}

		// Value exports take precedence — strip any types that are also values
		const finalValueExports = Array.from(valueExports.values());
		const finalTypeExports = Array.from(typeExports.values()).filter(({ exportedName }) => !valueExports.has(exportedName));

		// Build output using array for better performance than string concatenation
		const outputParts: string[] = [];

		// Add file references
		if (fileReferencesSet.size > 0) {
			for (const ref of fileReferencesSet) { outputParts.push(`/// <reference path="${ref}" />`) }
			outputParts.push('');
		}

		// Add type references
		if (typeReferencesSet.size > 0) {
			for (const ref of typeReferencesSet) { outputParts.push(`/// <reference types="${ref}" />`) }
			outputParts.push('');
		}

		// Add external imports. Add a blank line after imports
		if (mergedExternalImports.length > 0) {
			for (const imp of mergedExternalImports) { outputParts.push(imp) }
			outputParts.push('');
		}

		// Add all code
		outputParts.push(codeBlocks.join(separator));

		// Add consolidated export statements at the end and export types separately from values.
		// Only add if there are actual exports to consolidate
		if (finalTypeExports.length > 0 || finalValueExports.length > 0) {
			// blank line before exports
			outputParts.push('');

			// Export values on a separate line (only if non-empty)
			if (finalValueExports.length > 0) {
				outputParts.push(`export { ${finalValueExports.sort(DeclarationBundler.#exportComparator).map(DeclarationBundler.#exportMapper).join(', ')} };`);
			}

			// Export types (only if non-empty)
			if (finalTypeExports.length > 0) {
				outputParts.push(`export type { ${finalTypeExports.sort(DeclarationBundler.#exportComparator).map(DeclarationBundler.#exportMapper).join(', ')} };`);
			}
		} else if (codeBlocks.length > 0) {
			// Keep the bundle a module so `declare global` stays valid and locals stay module-scoped
			outputParts.push('', 'export {};');
		}

		return outputParts.join(newLine);
	}

	/**
	 * Bundles the given module dependency graph into a single declaration file, respecting shared modules and output path.
	 * @param graph The module dependency graph
	 * @param dtsEntryPoint The entry point for the declaration file
	 * @param sharedModules A map of shared modules that should not be bundled
	 * @param outputPath The output path for the bundled declaration file
	 * @returns The post-processed source file
	 */
	async #bundleGraph(graph: ModuleDependencyGraph, dtsEntryPoint: AbsolutePath, sharedModules: ReadonlyMap<string, AbsolutePath>, outputPath: AbsolutePath) {
		const { modules, bundledSpecifiers } = graph;
		const bundledModules = new Map<AbsolutePath, ModuleInfo>();
		const filteredSpecifiers = new Map<string, ReadonlySet<string>>();

		for (const [ path, module ] of modules) {
			if (sharedModules.has(path)) { continue }

			const specifiers = bundledSpecifiers.get(path) ?? emptySet;
			const externalized = new Set<string>();

			for (const specifier of specifiers) {
				const resolvedPath = this.#resolveModules([ specifier ], path)[0];

				if (resolvedPath === undefined || !sharedModules.has(Paths.absolute(resolvedPath))) { externalized.add(specifier) }
			}

			bundledModules.set(path, module);
			filteredSpecifiers.set(path, externalized);
		}

		// Combine modules and collect exports
		await this.yieldToEventLoop();
		const code = await this.#combineModules(this.#sortModules(bundledModules, dtsEntryPoint), filteredSpecifiers, sharedModules, outputPath);

		// Post-process combined modules to fix any issues
		// Tree-shaking is now done during combineModules
		await this.yieldToEventLoop();
		const sourceFile = this.#parse(dtsEntryPoint, code);
		await this.yieldToEventLoop();

		return DeclarationProcessor.postProcess(sourceFile);
	}
}

/**
 * Bundle TypeScript declaration files into a single output
 * @param options Bundling options
 * @returns The bundled declaration file content
 * @remarks
 * When `parallelTranspile` is true, bundling yields the event loop before each entry point and, within an entry point,
 * between parse batches, modules and bundle stages once `yieldIntervalMs` of synchronous work has elapsed. Without
 * these turns esbuild's plugin callbacks and IPC wait for the whole entry point, serializing transpilation behind it.
 * When transpile isn't running (emitDeclarationOnly), no yields are taken to avoid added latency.
 */
export async function bundleDeclarations(options: DtsBundleOptions): Promise<WrittenFile[]> {
	// mkdir with { recursive: true } is idempotent — no-op when the directory already exists, so we skip the redundant Files.exists check and save one syscall per build.
	await mkdir(options.compilerOptions.outDir, defaultDirOptions);

	using dtsBundler = new DeclarationBundler(options);

	const bundleTasks: Promise<WrittenFile>[] = [];
	const { entries, sharedFiles } = await dtsBundler.bundle(options.entryPoints);

	for (const [ outPath, content ] of sharedFiles) {
		if (content.length > 0) {
			const task = mkdir(Paths.parse(outPath).dir, defaultDirOptions)
				.then(() => writeFile(outPath, content, Encoding.utf8))
				.then(() => ({ path: Paths.relative(options.currentDirectory, outPath), size: content.length }));

			// Writes settle while later entry points are still bundling; Promise.all below reports the failure
			void task.catch(alwaysUndefined);
			bundleTasks.push(task);
		}
	}

	for (const [ entryName, content ] of entries) {
		if (content.length > 0) {
			const outPath = Paths.join(options.compilerOptions.outDir, `${entryName}${FileExtension.DTS}`);
			const task = mkdir(Paths.parse(outPath).dir, defaultDirOptions)
				.then(() => writeFile(outPath, content, Encoding.utf8))
				.then(() => ({ path: Paths.relative(options.currentDirectory, outPath), size: content.length }));

			// Writes settle while later entry points are still bundling; Promise.all below reports the failure
			void task.catch(alwaysUndefined);
			bundleTasks.push(task);
		}
	}

	// Do not let a failed write return while later entries still mutate output files.
	// The rejection handlers above prevent early unhandled-rejection reports while bundling continues; drain every write before surfacing the first failure in entry order.
	const fulfilled: WrittenFile[] = [];

	for (const result of await Promise.allSettled(bundleTasks)) {
		switch (result.status) {
			case 'rejected': throw result.reason;
			case 'fulfilled': fulfilled.push(result.value);
		}
	}

	return fulfilled;
}