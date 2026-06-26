import { Paths } from 'src/paths';
import MagicString from 'magic-string';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { BundleError } from 'src/errors';
import { Logger } from 'src/logger';
import { DeclarationProcessor } from './declaration-processor';
import { defaultDirOptions, Encoding, sourceScriptExtensionExpression, FileExtension, newLine } from 'src/constants';
import {
	sys,
	createSourceFile,
	ScriptTarget,
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
	isIdentifier,
	isNamespaceImport,
	isQualifiedName,
	resolveModuleName,
	isExportAssignment,
	forEachChild
} from 'typescript';
import type { SourceFile, Node, StringLiteral, ModuleResolutionHost } from 'typescript';
import type { AbsolutePath, CachedDeclaration, Pattern, WrittenFile } from 'src/@types';
import type { ModuleInfo, DtsBundleOptions, DtsCompilerOptions, IdentifierMap, DeclarationCode, ModuleDependencyGraph, BundledDeclaration, ExternalImport } from './@types';

const nodeModules = '/node_modules/';
const emptySet: ReadonlySet<string> = new Set();

/**
 * Merges structured external imports from the same module into single import statements.
 * Pure Map aggregation — no regex, no text parsing.
 *
 * @param imports - Structured external imports collected from all modules
 * @returns Array of merged, deduplicated import statement strings
 */
function mergeImports(imports: ExternalImport[]): string[] {
	// Map key: `${isType ? 'type:' : ''}${specifier}` so type-only and value imports stay separate
	const merged = new Map<string, { specifier: string; isType: boolean; names: Set<string> }>();
	const raw = new Set<string>();

	for (const imp of imports) {
		if (imp.kind === 'raw') {
			raw.add(imp.text);
			continue;
		}

		const key = `${imp.isType ? 'type:' : ''}${imp.specifier}`;
		let entry = merged.get(key);
		if (entry === undefined) {
			entry = { specifier: imp.specifier, isType: imp.isType, names: new Set() };
			merged.set(key, entry);
		}

		for (const name of imp.names) { entry.names.add(name) }
	}

	const result: string[] = [];
	for (const { specifier, isType, names } of merged.values()) {
		const sorted = Array.from(names).sort();
		result.push(`${isType ? 'import type' : 'import'} { ${sorted.join(', ')} } from "${specifier}";`);
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
class DeclarationBundler {
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
	/** Module resolution cache for this bundler instance */
	readonly #moduleResolutionCache = new Map<string, AbsolutePath>();
	/** Source-to-declaration path mapping cache to avoid redundant lookups during bundling */
	readonly #sourceToDeclarationCache = new Map<AbsolutePath, AbsolutePath>();
	/** Pre-computed set of directory prefixes from declaration file paths for O(1) directoryExists lookups */
	readonly #declarationDirs: Set<string> = new Set();
	/** Pre-built matcher for external patterns — O(1) string lookups + cached regex tests */
	readonly #matchExternal: (id: string) => boolean;
	/** Pre-built matcher for noExternal patterns — O(1) string lookups + cached regex tests */
	readonly #matchNoExternal: (id: string) => boolean;
	// Create a proper module resolution host that supports both in-memory files and disk files
	readonly #moduleResolutionHost: ModuleResolutionHost = {
		fileExists: (fileName: AbsolutePath) => {
			// Check in-memory declarations first (both project and external), then disk when resolve is enabled
			return this.#declarationFiles.has(fileName) || this.#externalDeclarationFiles.has(fileName) || this.#options.resolve && sys.fileExists(fileName);
		},
		readFile: (fileName: AbsolutePath): string | undefined => {
			const cached = this.#declarationFiles.get(fileName) ?? this.#externalDeclarationFiles.get(fileName);
			// Return the code from the CachedDeclaration
			if (cached) { return cached.code }

			if (!this.#options.resolve) { return undefined }

			// When resolve is enabled, read from disk and pre-process into the external map
			const rawContent = sys.readFile(fileName, Encoding.utf8);
			if (rawContent !== undefined) {
				// Pre-process external files loaded from disk
				const preProcessOutput = DeclarationProcessor.preProcess(createSourceFile(fileName, rawContent, ScriptTarget.Latest, true));
				this.#externalDeclarationFiles.set(fileName, preProcessOutput);

				return preProcessOutput.code;
			}

			/* v8 ignore next */
			return undefined;
		},
		directoryExists: (dirName: AbsolutePath) => {
			// O(1) Set lookup using pre-computed directory prefixes
			const normalizedDir = dirName.endsWith('/') ? dirName.slice(0, -1) : dirName;
			return this.#declarationDirs.has(normalizedDir) || (this.#options.resolve ? sys.directoryExists(dirName) : false);
		},
		getCurrentDirectory: () => this.#options.currentDirectory,
		/* v8 ignore next */
		getDirectories: () => [],
	};

	/**
	 * Creates a new DTS bundler instance
	 * @param dtsBundleOptions - Options for the DTS bundler
	 */
	constructor(dtsBundleOptions: DtsBundleOptions) {
		// Normalize all declaration file paths to ensure consistent lookups
		// This handles cases where paths may be relative or use different separators
		for (const [ filePath, cachedDecl ] of dtsBundleOptions.declarationFiles) {
			this.#declarationFiles.set(sys.resolvePath(filePath) as AbsolutePath, cachedDecl);
		}

		// Pre-compute all ancestor directory prefixes for O(1) directoryExists lookups
		for (const filePath of this.#declarationFiles.keys()) {
			let dir = filePath.lastIndexOf('/') !== -1 ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
			while (dir.length > 0) {
				if (this.#declarationDirs.has(dir)) { break }
				this.#declarationDirs.add(dir);
				const nextSlash = dir.lastIndexOf('/');
				dir = nextSlash !== -1 ? dir.slice(0, nextSlash) : '';
			}
		}

		this.#options = dtsBundleOptions;
		this.#matchExternal = DeclarationBundler.#buildMatcher(dtsBundleOptions.external);
		this.#matchNoExternal = DeclarationBundler.#buildMatcher(dtsBundleOptions.noExternal);
	}

	/**
	 * Clears external declaration files and module resolution cache to free memory.
	 * Called after all entry points have been bundled.
	 */
	clearExternalFiles() {
		this.#externalDeclarationFiles.clear();
		this.#moduleResolutionCache.clear();
		this.#sourceFileCache.clear();
		this.#sourceToDeclarationCache.clear();
	}

	/**
	 * Convert a source file path to its corresponding declaration file path
	 * @param sourcePath - Absolute path to a source file (.ts, .tsx)
	 * @returns The corresponding .d.ts path, or the original source path if no declaration exists
	 */
	#sourceToDeclarationPath(sourcePath: AbsolutePath): AbsolutePath {
		// Check cache first to avoid redundant lookups during multi-entry-point bundling
		const cached = this.#sourceToDeclarationCache.get(sourcePath);
		if (cached !== undefined) { return cached }

		const { outDir, rootDir } = this.#options.compilerOptions;
		const sourceWithoutExt = sourcePath.substring(0, sourcePath.lastIndexOf('.') || sourcePath.length);

		let result: AbsolutePath;
		if (rootDir) {
			// With explicit rootDir, calculate relative path and append to outDir
			// posix.normalize is required because TypeScript internally uses POSIX-style forward slashes
			// for module resolution paths regardless of the host platform
			const dtsPath = posix.normalize(Paths.join(outDir, Paths.relative(rootDir, sourceWithoutExt) + FileExtension.DTS)) as AbsolutePath;
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
	 * Builds an O(1) matcher from a mixed Pattern array by splitting into a Set<string> for
	 * exact/sub-path checks and a RegExp[] for regex tests. Called once per bundler instance.
	 * @param patterns - The array of string and RegExp patterns to match against module specifiers
	 * @returns A function that takes a module specifier and returns true if it matches any of the patterns
	 */
	static #buildMatcher(patterns: readonly Pattern[]): (id: string) => boolean {
		const exact = new Set<string>();
		const prefixes: string[] = [];
		const regexps: RegExp[] = [];
		for (const p of patterns) {
			if (typeof p === 'string') { exact.add(p); prefixes.push(p + '/') } else { regexps.push(p) }
		}
		if (exact.size === 0 && regexps.length === 0) { return () => false }
		return (id: string): boolean => {
			if (exact.has(id)) { return true }
			for (let i = 0; i < prefixes.length; i++) { if (id.startsWith(prefixes[i])) { return true } }
			for (let i = 0; i < regexps.length; i++) { if (regexps[i].test(id)) { return true } }
			return false;
		};
	}

	/**
	 * Resolve a module import using TypeScript's resolution algorithm with path mapping support
	 * For bundles with resolve enabled, also loads declaration files from node_modules
	 * @param importPath - The module specifier to resolve
	 * @param containingFile - The file containing the import
	 * @returns Resolved file path or undefined
	 */
	#resolveModule(importPath: string, containingFile: string): AbsolutePath | undefined {
		// Create cache key (resolve option is constant for bundler lifetime)
		const cacheKey = `${importPath}|${containingFile}`;

		// Check cache
		if (this.#moduleResolutionCache.has(cacheKey)) { return this.#moduleResolutionCache.get(cacheKey) }

		const { resolvedModule } = resolveModuleName(importPath, containingFile, this.#options.compilerOptions, this.#moduleResolutionHost);

		if (resolvedModule === undefined) { return }

		let resolvedFileName = resolvedModule.resolvedFileName as AbsolutePath;

		// If TypeScript resolved to a source file (.ts/.tsx), convert to the corresponding .d.ts file
		// This handles cases where tsconfig paths point to source files instead of declarations
		if (this.#options.compilerOptions.paths && resolvedFileName.match(sourceScriptExtensionExpression)) {
			resolvedFileName = this.#sourceToDeclarationPath(resolvedFileName);
		}

		// Cache the result
		this.#moduleResolutionCache.set(cacheKey, resolvedFileName);

		return resolvedFileName;
	}

	/**
	 * Build a dependency graph of all modules starting from entry point
	 * @param entryPoint - The entry point file path
	 * @returns Map of file paths to module information with bundled specifiers tracked
	 */
	#buildModuleGraph(entryPoint: AbsolutePath): ModuleDependencyGraph {
		const modules = new Map<string, ModuleInfo>();
		const visited: Set<string> = new Set();
		const bundledSpecifiers = new Map<string, Set<string>>(); // Maps module path to bundled import specifiers

		/**
		 * Recursively visit and process a module and its dependencies
		 * @param path - Path to the module file
		 */
		const visit = (path: AbsolutePath): void => {
			// Normalize the path to ensure we don't visit the same file twice with different path representations
			path = sys.resolvePath(path) as AbsolutePath;

			if (visited.has(path)) { return }

			visited.add(path);

			const cached = this.#declarationFiles.get(path) ?? this.#externalDeclarationFiles.get(path);

			// File not in our declaration map - it's external
			if (cached === undefined) { return }

			// Declarations are already pre-processed - just use the cached code and references
			const { code, typeReferences, fileReferences } = cached;

			// Reuse parsed SourceFile across entry points to avoid redundant parsing of shared modules
			let sourceFile = this.#sourceFileCache.get(path);
			if (sourceFile === undefined) {
				sourceFile = createSourceFile(path, code, ScriptTarget.Latest, true);
				this.#sourceFileCache.set(path, sourceFile);
			}

			// Cache identifiers from source (since that's what we'll use)
			const identifiers = this.#collectIdentifiers(sourceFile.statements, sourceFile);

			// Create module info - note: code is already pre-processed, typeReferences/fileReferences come from cache
			const module: ModuleInfo = { path, code, imports: new Set(), typeReferences: new Set(typeReferences), fileReferences: new Set(fileReferences), sourceFile, identifiers };
			const bundledSpecs = new Set<string>();

			// Extract and resolve imports in a single pass through statements
			for (const statement of sourceFile.statements) {
				if ((isImportDeclaration(statement) || isExportDeclaration(statement)) && statement.moduleSpecifier) {
					const specifier = (statement.moduleSpecifier as StringLiteral).text;

					// Skip explicit external modules
					if (this.#matchExternal(specifier)) { continue }

					const resolvedPath = this.#resolveModule(specifier, path);

					// Skip node_modules packages unless they're in noExternal list
					if (resolvedPath?.includes(nodeModules) && !this.#matchNoExternal(specifier)) { continue }

					if (resolvedPath && (this.#declarationFiles.has(resolvedPath) || this.#externalDeclarationFiles.has(resolvedPath))) {
						module.imports.add(resolvedPath);
						// Track the original specifier
						bundledSpecs.add(specifier);
						// Recursively process dependencies
						visit(resolvedPath);
					}
				}
			}

			modules.set(path, module);
			bundledSpecifiers.set(path, bundledSpecs);
		};

		visit(entryPoint);

		return { modules, bundledSpecifiers };
	}

	/**
	 * Topological sort of modules to ensure dependencies come before dependents
	 * @param modules - Map of all modules
	 * @param entryPoint - Starting point for sorting
	 * @returns Array of modules in dependency order
	 */
	#sortModules(modules: ReadonlyMap<string, ModuleInfo>, entryPoint: string) {
		const sorted: ModuleInfo[] = [];
		const visited = new Set<string>();
		const visiting = new Set<string>();
		const visitStack: string[] = [];

		/**
		 * Visit a module and its dependencies in topological order
		 * @param path - Module path to visit
		 */
		const visit = (path: string): void => {
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
	 * @returns Object with processed code, collected external imports, and exported names (separated by type/value)
	 */
	#stripImportsExports(code: string, sourceFile: SourceFile, identifiers: IdentifierMap, bundledImportPaths: ReadonlySet<string>, renameMap: Map<string, string>, modulePath: string): DeclarationCode {
		const externalImports: ExternalImport[] = [];
		const typeExports: string[] = [];
		const valueExports: string[] = [];
		// Use pre-computed identifiers directly - they're already Sets
		const { types: typeIdentifiers, values: valueIdentifiers } = identifiers;
		// Use MagicString for efficient code manipulation
		const magic = new MagicString(code);
		const moduleRenames = new Map<string, string>();
		const exportsMapper = (name: string) => moduleRenames.get(name) ?? name;

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
		// When a namespace import is bundled (inlined), all `Alias.Name` qualified
		// references must be flattened to plain `Name` since the alias is removed.
		const bundledNamespaceAliases = new Set<string>();

		// Process all statements using the source file AST
		for (const statement of sourceFile.statements) {
			if (isImportDeclaration(statement)) {
				const moduleSpecifier = (statement.moduleSpecifier as StringLiteral).text;

				// Keep as external if:
				// 1. It explicitly matches external patterns, OR
				// 2. It's NOT in the bundled specifiers (meaning it didn't get bundled in module graph)
				// Bundled specifiers are those that were successfully resolved and added to the module graph
				// Keep as external import if it's explicitly external OR wasn't bundled
				if (this.#matchExternal(moduleSpecifier) || !bundledImportPaths.has(moduleSpecifier)) {
					// Extract structured metadata from the AST instead of round-tripping through text+regex
					const importClause = statement.importClause;
					const isTypeOnly = importClause?.isTypeOnly === true;
					const namedBindings = importClause?.namedBindings;

					if (importClause && !importClause.name && namedBindings && isNamedImports(namedBindings)) {
						// Standard `import { A, B } from 'x'` or `import type { A } from 'x'`
						const names: string[] = [];
						for (const element of namedBindings.elements) {
							const local = element.name.text;
							const original = element.propertyName?.text;
							// Inline `type` markers (e.g. `import { type Foo }`) are preserved per-element
							const prefix = element.isTypeOnly ? 'type ' : '';
							names.push(original ? `${prefix}${original} as ${local}` : `${prefix}${local}`);
						}
						externalImports.push({ kind: 'named', specifier: moduleSpecifier, isType: isTypeOnly, names });
					} else {
						// Default imports, namespace imports, side-effect imports — keep verbatim
						externalImports.push({ kind: 'raw', text: code.substring(statement.pos, statement.end).trim() });
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
					// Remove all export...from statements (re-exports are flattened during bundling)
					magic.remove(statement.pos, statement.end);
					continue;
				}

				// Standalone export: export { X, Y, Z } or export type { A, B }
				if (statement.exportClause && isNamedExports(statement.exportClause)) {
					// Check if this is an empty export (export {};). These are used by TypeScript to mark a file as a module
					// Collect exported names
					if (statement.exportClause.elements.length > 0) {
						for (const { name, propertyName } of statement.exportClause.elements) {
							const localName = propertyName?.text ?? name.text;

							// Categorize as type or value. Values take precedence (classes/enums are both)
							if (valueIdentifiers.has(localName)) {
								valueExports.push(localName);
							} else if (typeIdentifiers.has(localName)) {
								typeExports.push(localName);
							} else {
								// Unknown, assume value (safer default)
								valueExports.push(localName);
							}
						}

						// Remove the export statement
						magic.remove(statement.pos, statement.end);
					}
				}
			} else if (isExportAssignment(statement)) {
				// Handle export default assignment: export default ...
				magic.remove(statement.pos, statement.end);
			}
		}

		// Apply renaming to all identifier occurrences and flatten qualified names from bundled namespaces.
		// Combined into a single AST walk to avoid traversing the tree multiple times.
		// IMPORTANT: Only visit declaration statements, NOT import/export declarations.
		// Import and export declarations are removed via magic.remove() above.
		// Calling magic.overwrite() on an already-removed range reinserts the text.
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
				forEachChild(node, visit);
			};

			for (const statement of sourceFile.statements) {
				if (!isImportDeclaration(statement) && !isExportDeclaration(statement) && !isExportAssignment(statement)) {
					visit(statement);
				}
			}
		}

		// Value exports take precedence - remove any types that are also values
		const finalValueExportsSet = new Set<string>();
		for (const name of valueExports) { finalValueExportsSet.add(exportsMapper(name)) }

		const finalTypeExports: string[] = [];
		for (const type of typeExports) {
			const mapped = exportsMapper(type);
			if (!finalValueExportsSet.has(mapped)) { finalTypeExports.push(mapped) }
		}

		return { code: magic.toString(), externalImports, typeExports: finalTypeExports, valueExports: Array.from(finalValueExportsSet) };
	}

	/**
	 * Combine modules into a single output string
	 * @param sortedModules - Modules in dependency order
	 * @param bundledSpecifiers - Map of module paths to their bundled import specifiers
	 * @returns Object containing combined code, all exported identifiers, and all declarations from bundled modules
	 */
	#combineModules(sortedModules: ModuleInfo[], bundledSpecifiers: ReadonlyMap<string, ReadonlySet<string>>): BundledDeclaration {
		// Use Sets directly to deduplicate as we collect — avoids intermediate arrays + later `new Set(array)` round-trips
		const typeReferencesSet = new Set<string>();
		const fileReferencesSet = new Set<string>();
		const allExternalImports: ExternalImport[] = [];
		const valueExportsSet = new Set<string>();
		const typeExportsSeen = new Set<string>();
		const orderedTypeExports: string[] = []; // preserve first-seen order for stable output
		const codeBlocks: string[] = [];
		const allDeclarations = new Set<string>();

		// Track declarations per module to detect conflicts and rename
		const declarationSources = new Map<string, Set<string>>(); // identifier -> Set of module paths
		const renameMap = new Map<string, string>(); // original name + module -> renamed identifier

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
				// First module keeps original name, subsequent modules get $1, $2, etc.
				// Each candidate is verified against all known declarations to avoid collisions
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
			// Collect references — Sets dedupe as we go
			for (const r of typeReferences) { typeReferencesSet.add(r) }
			for (const r of fileReferences) { fileReferencesSet.add(r) }

			// Strip import/export statements, preserving external imports.
			// Use cached identifiers and sourceFile (both always present after buildModuleGraph).
			const bundledForThisModule = bundledSpecifiers.get(path) ?? emptySet;
			const { code: strippedCode, externalImports, typeExports, valueExports } = this.#stripImportsExports(code, sourceFile, { types, values }, bundledForThisModule, renameMap, path);

			// Collect external imports from all modules (merged later by mergeImports)
			for (const imp of externalImports) { allExternalImports.push(imp) }

			// Collect exports from project modules, but not from bundled npm packages.
			// This prevents unused types from dependencies being re-exported
			// while still allowing re-exports from the project's own modules.
			if (!path.includes(nodeModules)) {
				for (const exp of valueExports) { valueExportsSet.add(exp) }
				for (const exp of typeExports) {
					if (!typeExportsSeen.has(exp)) {
						typeExportsSeen.add(exp);
						orderedTypeExports.push(exp);
					}
				}

				// Collect ALL declarations from project modules (exported or not).
				// These should be preserved during tree-shaking since TypeScript emitted them.
				for (const name of types) { allDeclarations.add(name) }
				for (const name of values) { allDeclarations.add(name) }
			}

			// Skip modules that only contain imports/exports (pure re-export files)
			if (strippedCode.trim().length > 0) { codeBlocks.push(strippedCode.trim()) }
		}

		// Merge imports from the same module instead of simple deduplication
		const mergedExternalImports = mergeImports(allExternalImports);

		// Infer /// <reference types="..." /> from node: protocol imports so the .d.ts is self-contained
		for (const imp of mergedExternalImports) {
			if (imp.includes('"node:') || imp.includes('\'node:')) { typeReferencesSet.add('node') }
		}

		// Value exports take precedence — strip any types that are also values
		const finalValueExports: string[] = [...valueExportsSet];
		const finalTypeExports: string[] = [];
		for (const typeExport of orderedTypeExports) {
			if (!valueExportsSet.has(typeExport)) { finalTypeExports.push(typeExport) }
		}

		// Build output using array for better performance than string concatenation
		const outputParts: string[] = [];

		// Add file references
		if (fileReferencesSet.size > 0) {
			for (const ref of fileReferencesSet) {
				outputParts.push(`/// <reference path="${ref}" />`);
			}
			outputParts.push('');
		}

		// Add type references
		if (typeReferencesSet.size > 0) {
			for (const ref of typeReferencesSet) {
				outputParts.push(`/// <reference types="${ref}" />`);
			}
			outputParts.push('');
		}

		// Add external imports. Add a blank line after imports
		if (mergedExternalImports.length > 0) {
			for (const imp of mergedExternalImports) { outputParts.push(imp) }
			outputParts.push('');
		}

		// Add all code
		outputParts.push(codeBlocks.join(newLine + newLine));

		// Add consolidated export statements at the end
		// Export types separately from values
		// Only add if there are actual exports to consolidate
		if (finalTypeExports.length > 0 || finalValueExports.length > 0) {
			// blank line before exports
			outputParts.push('');

			// Export values on a separate line (only if non-empty)
			if (finalValueExports.length > 0) {
				outputParts.push(`export { ${finalValueExports.sort().join(', ')} };`);
			}

			// Export types (only if non-empty)
			if (finalTypeExports.length > 0) {
				outputParts.push(`export type { ${finalTypeExports.sort().join(', ')} };`);
			}
		}

		// Return combined code with exports and all declarations from bundled modules
		return { code: outputParts.join(newLine), exports: [...finalTypeExports, ...finalValueExports], allDeclarations };
	}

	/**
	 * Main bundling orchestration method
	 * @param entryPoint - The entry point file path
	 * @returns The bundled declaration file content
	 */
	bundle(entryPoint: AbsolutePath) {
		// Convert source path to declaration path
		const dtsEntryPoint = this.#resolveEntryPoint(entryPoint, this.#options.compilerOptions);

		// Entry points with no declaration file were never stored (empty d.ts from TypeScript)
		if (dtsEntryPoint === undefined) { return '' }

		// Build the module dependency graph
		const { modules, bundledSpecifiers } = this.#buildModuleGraph(dtsEntryPoint);

		// Combine modules and collect exports and all declarations
		const { code } = this.#combineModules(this.#sortModules(modules, dtsEntryPoint), bundledSpecifiers);

		// Post-process combined modules to fix any issues
		// Tree-shaking is now done during combineModules
		return DeclarationProcessor.postProcess(createSourceFile(dtsEntryPoint, code, ScriptTarget.Latest, true));
	}

	/**
	 * Resolve entry point from source path to declaration path
	 * @param entryPoint - The entry point file path
	 * @param compilerOptions - Minimal compiler options with outDir and rootDir
	 * @returns Resolved declaration entry point path
	 */
	#resolveEntryPoint(entryPoint: AbsolutePath, compilerOptions: DtsCompilerOptions): AbsolutePath | undefined {
		// Convert source path to declaration path and normalize to POSIX format (TypeScript expects forward slashes)
		const dtsEntryPoint = sys.resolvePath(entryPoint.endsWith(FileExtension.DTS) ? entryPoint : this.#sourceToDeclarationPath(entryPoint)) as AbsolutePath;

		if (this.#declarationFiles.has(dtsEntryPoint)) { return dtsEntryPoint }

		// Source entry points with no declaration file have no exportable API (e.g. CLI scripts)
		if (!entryPoint.endsWith(FileExtension.DTS)) { return undefined }

		// A .d.ts was passed directly but not found — this is a real error
		const availableFiles = Array.from(this.#declarationFiles.keys());
		const entryPointFilename = basename(entryPoint);
		const similarFiles = availableFiles.filter((filePath) => filePath.includes(entryPointFilename));

		throw new BundleError(
			`Entry point declaration file not found: ${dtsEntryPoint || 'unknown'}\n` +
			`Original entry: ${entryPoint}\n` +
			`Compiler options: outDir=${compilerOptions.outDir || 'dist'}, rootDir=${compilerOptions.rootDir || 'not set'}\n` +
			`Similar files found:\n${similarFiles.map(f => `  - ${f}`).join('\n')}\n` +
			`Total available files: ${availableFiles.length}`
		);
	}
}

/**
 * Bundle TypeScript declaration files into a single output
 * @param options Bundling options
 * @returns The bundled declaration file content
 * @remarks
 * Yields the event loop before each entry point's bundle (when parallelTranspile is true)
 * so pending I/O (for example, esbuild IPC responses from the parallel transpile phase) can be
 * processed promptly instead of being delayed by declaration bundling work.
 */
export async function bundleDeclarations(options: DtsBundleOptions): Promise<WrittenFile[]> {
	// mkdir with { recursive: true } is idempotent — no-op when the directory already exists,
	// so we skip the redundant Files.exists check and save one syscall per build.
	await mkdir(options.compilerOptions.outDir, defaultDirOptions);

	const dtsBundler = new DeclarationBundler(options);

	// When transpile runs in parallel, dtsBundler.bundle() is synchronous CPU-bound work
	// that blocks the event loop. While blocked, esbuild's IPC response cannot be delivered,
	// inflating the measured transpile duration. Yield before each entry point so pending
	// I/O (esbuild IPC responses) can be processed promptly.
	// When transpile isn't running (emitDeclarationOnly), skip yields to reduce latency.
	const bundleTasks: Promise<WrittenFile>[] = [];
	const bundleEntryPoint = (entryName: string, entryPoint: AbsolutePath) => {
		const content = dtsBundler.bundle(entryPoint);
		if (content.length > 0) {
			const outPath = Paths.join(options.compilerOptions.outDir, `${entryName}${FileExtension.DTS}`);
			bundleTasks.push(writeFile(outPath, content, Encoding.utf8).then(() => ({ path: Paths.relative(options.currentDirectory, outPath), size: content.length })));
		}
	};

	if (options.parallelTranspile) {
		const queueImmediateTask = (resolve: (value: void | PromiseLike<void>) => void): undefined => void setImmediate(resolve);

		for (const [ entryName, entryPoint ] of Object.entries(options.entryPoints)) {
			await new Promise<void>(queueImmediateTask);
			bundleEntryPoint(entryName, entryPoint);
		}
	} else {
		for (const [ entryName, entryPoint ] of Object.entries(options.entryPoints)) {
			bundleEntryPoint(entryName, entryPoint);
		}
	}

	const results = await Promise.all(bundleTasks);

	// Free memory used by externally-resolved declaration files (node_modules)
	dtsBundler.clearExternalFiles();

	return results;
}