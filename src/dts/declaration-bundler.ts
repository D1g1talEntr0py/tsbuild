import { Paths } from 'src/paths';
import MagicString from 'magic-string';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { BundleError } from 'src/errors';
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
	isModuleBlock,
	isModuleDeclaration,
	isNamedExports,
	isIdentifier,
	resolveModuleName,
	isExportAssignment,
	forEachChild
} from 'typescript';
import type { SourceFile, Node, StringLiteral, ModuleResolutionHost } from 'typescript';
import type { AbsolutePath, CachedDeclaration, Pattern, WrittenFile } from 'src/@types';
import type { ModuleInfo, DtsBundleOptions, DtsCompilerOptions, IdentifierMap, DeclarationCode, ModuleDependencyGraph, BundledDeclaration } from './@types';

const nodeModules = '/node_modules/';
const importPattern = /^import\s*(?:type\s*)?\{\s*([^}]+)\s*\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/;
const typePrefixPattern = /^type:/;

/**
 * Merges import statements from the same module into a single import.
 * For example, merges:
 *   import { A, B } from 'foo';
 *   import { B, C } from 'foo';
 * Into:
 *   import { A, B, C } from 'foo';
 *
 * @param imports - Array of import statements
 * @returns Array of merged, deduplicated import statements
 */
function mergeImports(imports: string[]): string[] {
	// Map from module specifier to Set of imported names
	const moduleImports = new Map<string, { names: Set<string>; isType: boolean }>();
	const nonMergeableImports: string[] = [];

	for (const importStatement of imports) {
		const match = importPattern.exec(importStatement);
		if (match) {
			const [ , namesString, moduleSpecifier ] = match;
			const isType = importStatement.includes('import type');
			const key = `${isType ? 'type:' : ''}${moduleSpecifier}`;

			if (!moduleImports.has(key)) {
				moduleImports.set(key, { names: new Set(), isType });
			}

			const entry = moduleImports.get(key)!;
			// Split names and add each one, trimming whitespace
			for (const name of namesString.split(',')) {
				entry.names.add(name.trim());
			}
		} else {
			// Non-standard import, keep as-is but dedupe
			nonMergeableImports.push(importStatement);
		}
	}

	// Build merged import statements
	const result: string[] = [];
	for (const [ key, { names, isType } ] of moduleImports) {
		result.push(`${isType ? 'import type' : 'import'} { ${[...names].sort().join(', ')} } from "${key.replace(typePrefixPattern, '')}";`);
	}

	// Add non-mergeable imports, deduped
	result.push(...[ ...new Set(nonMergeableImports) ]);

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
	/** d.ts Bundle Options (internally mutable for caching - stores pre-processed declarations) */
	private readonly declarationFiles: Map<AbsolutePath, CachedDeclaration> = new Map();

	/** d.ts Bundle Options */
	private readonly options: DtsBundleOptions;

	/** WeakMap cache for identifier collection to avoid re-parsing same source files */
	private readonly identifierCache = new WeakMap<SourceFile, IdentifierMap>();

	/** Module resolution cache for this bundler instance */
	private readonly moduleResolutionCache = new Map<string, AbsolutePath>();

	// Create a proper module resolution host that supports both in-memory files and disk files
	private readonly moduleResolutionHost: ModuleResolutionHost = {
		fileExists: (fileName: AbsolutePath) => {
			// Check in-memory declarations first, then disk when resolve is enabled
			return this.declarationFiles.has(fileName) || this.options.resolve && sys.fileExists(fileName);
		},
		readFile: (fileName: AbsolutePath): string | undefined => {
			const cached = this.declarationFiles.get(fileName);
			// Return the code from the CachedDeclaration
			if (cached) { return cached.code }

			if (!this.options.resolve) { return undefined }

			// When resolve is enabled, read from disk and pre-process
			const rawContent = sys.readFile(fileName, Encoding.utf8);
			if (rawContent !== undefined) {
				// Pre-process external files loaded from disk
				const preProcessOutput = DeclarationProcessor.preProcess(createSourceFile(fileName, rawContent, ScriptTarget.Latest, true));
				this.declarationFiles.set(fileName, preProcessOutput);

				return preProcessOutput.code;
			}

			/* v8 ignore next */
			return undefined;
		},
		directoryExists: (dirName: AbsolutePath) => {
			// Check if any file in our declarations starts with this directory
			const normalizedDir = dirName.endsWith('/') ? dirName : dirName + '/' as AbsolutePath;
			for (const filePath of this.declarationFiles.keys()) {
				if (filePath.startsWith(normalizedDir)) { return true }
			}

			// When resolve is enabled, check disk
			return this.options.resolve ? sys.directoryExists(dirName) : false;
		},
		getCurrentDirectory: () => this.options.currentDirectory,
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
			this.declarationFiles.set(sys.resolvePath(filePath) as AbsolutePath, cachedDecl);
		}

		this.options = dtsBundleOptions;
	}

	/**
	 * Convert a source file path to its corresponding declaration file path
	 * @param sourcePath - Absolute path to a source file (.ts, .tsx)
	 * @returns The corresponding .d.ts path, or undefined if not found
	 */
	private sourceToDeclarationPath(sourcePath: AbsolutePath): AbsolutePath {
		const { outDir, rootDir } = this.options.compilerOptions;
		const sourceWithoutExt = sourcePath.substring(0, sourcePath.lastIndexOf('.') || sourcePath.length);

		if (rootDir) {
			// With explicit rootDir, calculate relative path and append to outDir
			// TODO - Why are we using posix here?
			const dtsPath = posix.normalize(Paths.join(outDir, Paths.relative(rootDir, sourceWithoutExt) + FileExtension.DTS)) as AbsolutePath;
			return this.declarationFiles.has(dtsPath) ? dtsPath : sourcePath;
		}

		// Without rootDir, find .d.ts file by stripping outDir and matching the suffix
		// TypeScript preserves directory structure, so /path/to/project/src/foo/bar.ts
		// becomes /path/to/project/dist/foo/bar.d.ts
		// We can match by checking if they share the same relative path structure
		for (const dtsPath of this.declarationFiles.keys()) {
			if (!dtsPath.endsWith(FileExtension.DTS)) { continue }

			// Strip outDir prefix from declaration path: /path/to/project/dist/foo/bar.d.ts -> foo/bar.d.ts
			const withoutOutDir = dtsPath.startsWith(outDir + '/') ? dtsPath.slice(outDir.length + 1) : dtsPath;

			// Remove .d.ts extension to get relative path: foo/bar.d.ts -> foo/bar
			const relativeDtsPath = withoutOutDir.slice(0, -FileExtension.DTS.length);

			// Check if source path ends with the same relative path structure
			// Ensure it's a complete path segment match by checking for '/' before the match
			if (sourceWithoutExt === relativeDtsPath || sourceWithoutExt.endsWith('/' + relativeDtsPath)) {
				return dtsPath;
			}
		}

		return sourcePath;
	}

	/**
	 * Extract import statements from declaration file content using AST
	 * Handles: import { X } from 'module', import * as X from 'module', export { X } from 'module'
	 * @param sourceFile - The parsed source file AST
	 * @returns Array of module specifiers that are imported
	 */
	private extractImports({ statements }: SourceFile): string[] {
		const imports: string[] = [];

		for (const statement of statements) {
			if ((isImportDeclaration(statement) || isExportDeclaration(statement)) && statement.moduleSpecifier) {
				// Handle import declarations: import { X } from 'module'
				// Handle export declarations with module specifier: export { X } from 'module'
				imports.push((statement.moduleSpecifier as StringLiteral).text);
			}
		}

		return imports;
	}

	/**
	 * Check if a module specifier matches a pattern list
	 * @param moduleSpecifier - The module specifier to check
	 * @param patterns - Array of patterns to match against
	 * @returns True if the module matches any pattern
	 */
	private matchesPattern(moduleSpecifier: string, patterns: readonly Pattern[]): boolean {
		return patterns.some((pattern) => {
			return typeof pattern === 'string' ? moduleSpecifier === pattern || moduleSpecifier.startsWith(`${pattern}/`) : pattern.test(moduleSpecifier);
		});
	}

	/**
	 * Check if a module specifier matches explicit external patterns
	 * @param moduleSpecifier - The module specifier to check
	 * @returns True if the module should be treated as external
	 */
	private isExternal(moduleSpecifier: string): boolean {
		return this.matchesPattern(moduleSpecifier, this.options.external);
	}

	/**
	 * Resolve a module import using TypeScript's resolution algorithm with path mapping support
	 * For bundles with resolve enabled, also loads declaration files from node_modules
	 * @param importPath - The module specifier to resolve
	 * @param containingFile - The file containing the import
	 * @returns Resolved file path or undefined
	 */
	private resolveModule(importPath: string, containingFile: string): AbsolutePath | undefined {
		// Create cache key (resolve option is constant for bundler lifetime)
		const cacheKey = `${importPath}|${containingFile}`;

		// Check cache
		if (this.moduleResolutionCache.has(cacheKey)) { return this.moduleResolutionCache.get(cacheKey) }

		const { resolvedModule } = resolveModuleName(importPath, containingFile, this.options.compilerOptions, this.moduleResolutionHost);

		if (resolvedModule === undefined) { return }

		let resolvedFileName = resolvedModule.resolvedFileName as AbsolutePath;

		// If TypeScript resolved to a source file (.ts/.tsx), convert to the corresponding .d.ts file
		// This handles cases where tsconfig paths point to source files instead of declarations
		if (this.options.compilerOptions.paths && resolvedFileName.match(sourceScriptExtensionExpression)) {
			resolvedFileName = this.sourceToDeclarationPath(resolvedFileName);
		}

		// Cache the result
		this.moduleResolutionCache.set(cacheKey, resolvedFileName);

		return resolvedFileName;
	}

	/**
	 * Build a dependency graph of all modules starting from entry point
	 * @param entryPoint - The entry point file path
	 * @returns Map of file paths to module information with bundled specifiers tracked
	 */
	private buildModuleGraph(entryPoint: AbsolutePath): ModuleDependencyGraph {
		const modules = new Map<string, ModuleInfo>();
		const visited: Set<string> = new Set();
		const bundledSpecifiers = new Map<string, string[]>(); // Maps module path to bundled import specifiers

		/**
		 * Recursively visit and process a module and its dependencies
		 * @param path - Path to the module file
		 */
		const visit = (path: AbsolutePath): void => {
			// Normalize the path to ensure we don't visit the same file twice with different path representations
			path = sys.resolvePath(path) as AbsolutePath;

			if (visited.has(path)) { return }

			visited.add(path);

			const cached = this.declarationFiles.get(path);

			// File not in our declaration map - it's external
			if (cached === undefined) { return }

			// Declarations are already pre-processed - just use the cached code and references
			const { code, typeReferences, fileReferences } = cached;

			// Create SourceFile from pre-processed code
			const sourceFile = createSourceFile(path, code, ScriptTarget.Latest, true);

			// Cache identifiers from source (since that's what we'll use)
			const identifiers = this.collectIdentifiers(sourceFile.statements, sourceFile);

			// Create module info - note: code is already pre-processed, typeReferences/fileReferences come from cache
			const module: ModuleInfo = { path, code, imports: new Set(), typeReferences: new Set(typeReferences), fileReferences: new Set(fileReferences), sourceFile, identifiers };
			const bundledSpecs: string[] = [];

			// Extract and resolve imports using AST
			for (const specifier of this.extractImports(sourceFile)) {
				// Skip explicit external modules
				if (this.isExternal(specifier)) { continue }

				const resolvedPath = this.resolveModule(specifier, path);

				// Skip node_modules packages unless they're in noExternal list
				if (resolvedPath?.includes(nodeModules) && !this.matchesPattern(specifier, this.options.noExternal)) { continue }

				// If resolved and not already in memory, load it from disk when resolve is enabled
				if (resolvedPath && !this.declarationFiles.has(resolvedPath)) {
					if (this.options.resolve && sys.fileExists(resolvedPath)) {
						const rawContent = sys.readFile(resolvedPath, Encoding.utf8);
						if (rawContent !== undefined) {
							// Pre-process external files loaded from disk
							this.declarationFiles.set(resolvedPath, DeclarationProcessor.preProcess(createSourceFile(resolvedPath, rawContent, ScriptTarget.Latest, true)));
						}
					}
				}

				if (resolvedPath && this.declarationFiles.has(resolvedPath)) {
					module.imports.add(resolvedPath);
					// Track the original specifier
					bundledSpecs.push(specifier);
					// Recursively process dependencies
					visit(resolvedPath);
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
	private sortModules(modules: ReadonlyMap<string, ModuleInfo>, entryPoint: string): ModuleInfo[] {
		const sorted: ModuleInfo[] = [];
		const visited = new Set<string>();
		const visiting = new Set<string>();

		/**
		 * Visit a module and its dependencies in topological order
		 * @param path - Module path to visit
		 */
		const visit = (path: string): void => {
			// Circular dependency - not ideal but we'll handle it
			if (visited.has(path) || visiting.has(path)) { return }

			visiting.add(path);

			const module = modules.get(path);
			if (!module) { return }

			// Visit dependencies first
			for (const importPath of module.imports) { visit(importPath) }

			visiting.delete(path);
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
	private collectIdentifiers<const S extends Iterable<Node>>(statements: S, sourceFile?: SourceFile): IdentifierMap {
		let result: IdentifierMap | undefined;

		// Check cache if we have the source file
		if (sourceFile) {
			result = this.identifierCache.get(sourceFile);
			if (result) { return result }
		}

		const types = new Set<string>();
		const values = new Set<string>();

		const collectNestedIdentifiers = (subStatements: Iterable<Node>) => {
			const { types: subTypes, values: subValues } = this.collectIdentifiers(subStatements);
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
			} else if (isModuleBlock(statement)) {
				// Recurse into module blocks
				collectNestedIdentifiers(statement.statements);
			} else if (isModuleDeclaration(statement)) {
				// Module/namespace declarations are values
				if (statement.name && isIdentifier(statement.name)) { values.add(statement.name.text) }
				collectNestedIdentifiers(statement.getChildren());
			}
		}

		result = { types, values };

		// Cache if we have the source file
		if (sourceFile) { this.identifierCache.set(sourceFile, result) }

		return result;
	}

	/**
	 * Remove import/export statements from code, but preserve external imports
	 * Fully AST-based approach using magic-string for efficient code manipulation
	 * @param code - Declaration file content
	 * @param sourceFile - Parsed source file AST (required to avoid re-parsing)
	 * @param identifiers - Pre-computed type and value identifiers (to avoid re-computation)
	 * @param bundledImportPaths - Array of resolved file paths that were bundled (to exclude from external imports)
	 * @param renameMap - Map of renamed identifiers (name:path -> newName)
	 * @param modulePath - Path of current module for looking up renames
	 * @returns Object with processed code, collected external imports, and exported names (separated by type/value)
	 */
	private stripImportsExports(code: string, sourceFile: SourceFile, identifiers: IdentifierMap, bundledImportPaths: readonly string[], renameMap: Map<string, string>, modulePath: string): DeclarationCode {
		const externalImports: string[] = [];
		const typeExports: string[] = [];
		const valueExports: string[] = [];
		// Use pre-computed identifiers directly - they're already Sets
		const { types: typeIdentifiers, values: valueIdentifiers } = identifiers;
		// Use MagicString for efficient code manipulation
		const magic = new MagicString(code);

		const moduleRenames = new Map<string, string>();
		const exportsMapper = (name: string) => moduleRenames.get(name) ?? name;

		// Apply renaming for identifiers from this module
		for (const name of [ ...typeIdentifiers, ...valueIdentifiers ]) {
			const renamed = renameMap.get(`${name}:${modulePath}`);
			if (renamed) { moduleRenames.set(name, renamed) }
		}

		// Process all statements using the source file AST
		for (const statement of sourceFile.statements) {
			if (isImportDeclaration(statement)) {
				const moduleSpecifier = (statement.moduleSpecifier as StringLiteral).text;

				// Keep as external if:
				// 1. It explicitly matches external patterns, OR
				// 2. It's NOT in the bundled specifiers (meaning it didn't get bundled in module graph)
				// Bundled specifiers are those that were successfully resolved and added to the module graph
				// Keep as external import if it's explicitly external OR wasn't bundled
				if (this.isExternal(moduleSpecifier) || !bundledImportPaths.includes(moduleSpecifier)) {
					// Keep external imports - extract the text
					externalImports.push(code.substring(statement.pos, statement.end).trim());
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

		// Apply renaming to all identifier occurrences in the code
		if (moduleRenames.size > 0) {
			const visit = (node: Node): void => {
				if (isIdentifier(node)) {
					const renamed = moduleRenames.get(node.text);
					// Rename the identifier
					if (renamed) { magic.overwrite(node.pos, node.end, renamed) }
				}
				forEachChild(node, visit);
			};

			forEachChild(sourceFile, visit);
		}

		// Value exports take precedence - remove any types that are also values
		const finalValueExports = [...new Set(valueExports.map(exportsMapper))];
		const valueExportsSet = new Set(finalValueExports);
		const finalTypeExports = [...new Set(typeExports.map(exportsMapper).filter(t => !valueExportsSet.has(t)))];

		return { code: magic.toString(), externalImports, typeExports: finalTypeExports, valueExports: finalValueExports };
	}

	/**
	 * Combine modules into a single output string
	 * @param sortedModules - Modules in dependency order
	 * @param bundledSpecifiers - Map of module paths to their bundled import specifiers
	 * @returns Object containing combined code, all exported identifiers, and all declarations from bundled modules
	 */
	private combineModules(sortedModules: ModuleInfo[], bundledSpecifiers: ReadonlyMap<string, readonly string[]>): BundledDeclaration {
		const allTypeReferences: string[] = [];
		const allFileReferences: string[] = [];
		const allExternalImports: string[] = [];
		const allTypeExports: string[] = [];
		const allValueExports: string[] = [];
		const codeBlocks: string[] = [];
		const allDeclarations = new Set<string>();

		// Track declarations per module to detect conflicts and rename
		const declarationSources = new Map<string, Set<string>>(); // identifier -> Set of module paths
		const renameMap = new Map<string, string>(); // original name + module -> renamed identifier

		// First pass: collect all declarations and detect conflicts
		for (const { path, identifiers } of sortedModules) {
			for (const name of identifiers.types) {
				if (!declarationSources.has(name)) { declarationSources.set(name, new Set()) }
				declarationSources.get(name)!.add(path);
			}
			for (const name of identifiers.values) {
				if (!declarationSources.has(name)) { declarationSources.set(name, new Set()) }
				declarationSources.get(name)!.add(path);
			}
		}

		// Second pass: generate unique names for conflicting identifiers
		for (const [name, sourcesSet] of declarationSources) {
			if (sourcesSet.size > 1) {
				const sources = Array.from(sourcesSet);
				// First module keeps original name, subsequent modules get $1, $2, etc.
				sources.slice(1).forEach((modulePath, index) => {
					renameMap.set(`${name}:${modulePath}`, `${name}$${index + 1}`);
				});
			}
		}

		// Collect all references and code
		for (const { path, typeReferences, fileReferences, sourceFile, code, identifiers } of sortedModules) {
			// Collect references
			allTypeReferences.push(...typeReferences);
			allFileReferences.push(...fileReferences);

			// Strip import/export statements, preserving external imports
			// Use cached identifiers and sourceFile (both always present after buildModuleGraph)

			// Get the bundled specifiers for this module from the map built during module graph construction
			const bundledForThisModule = bundledSpecifiers.get(path) || [];

			// Calculate used declarations for this module
			// We pass the global set of used declarations to stripImportsExports
			const { code: strippedCode, externalImports, typeExports, valueExports } = this.stripImportsExports(code, sourceFile, identifiers, bundledForThisModule, renameMap, path);

			// Collect external imports from all modules
			allExternalImports.push(...externalImports);

			// Collect exports from project modules, but not from bundled npm packages
			// This prevents unused types from dependencies being re-exported
			// while still allowing re-exports from the project's own modules
			if (!path.includes(nodeModules)) {
				allValueExports.push(...valueExports);
				allTypeExports.push(...typeExports);

				// Collect ALL declarations from project modules (exported or not)
				// These should be preserved during tree-shaking since TypeScript emitted them
				for (const name of identifiers.types) { allDeclarations.add(name) }
				for (const name of identifiers.values) { allDeclarations.add(name) }
			}

			// Skip modules that only contain imports/exports (pure re-export files)
			if (strippedCode.trim().length > 0) { codeBlocks.push(strippedCode.trim()) }
		}

		// Deduplicate using Sets for these collections since we're combining from many modules
		const uniqueTypeReferences = [...new Set(allTypeReferences)];
		const uniqueFileReferences = [...new Set(allFileReferences)];
		// Merge imports from the same module instead of simple deduplication
		const mergedExternalImports = mergeImports(allExternalImports);

		// Value exports take precedence - remove any types that are also values
		// Use Set for O(1) lookup instead of Array.includes() O(n) to avoid O(n²) complexity
		const finalValueExports = [...new Set(allValueExports)];
		const finalValueExportsSet = new Set(finalValueExports);
		const finalTypeExports = [...new Set(allTypeExports.filter((typeExport) => !finalValueExportsSet.has(typeExport)))];

		// Build output using array for better performance than string concatenation
		const outputParts: string[] = [];

		// Add file references
		if (uniqueFileReferences.length > 0) {
			outputParts.push(...uniqueFileReferences.map((ref) => `/// <reference path="${ref}" />`), '');
		}

		// Add type references
		if (uniqueTypeReferences.length > 0) {
			outputParts.push(...uniqueTypeReferences.map((ref) => `/// <reference types="${ref}" />`), '');
		}

		// Add external imports. Add a blank line after imports
		if (mergedExternalImports.length > 0) { outputParts.push(...mergedExternalImports, '') }

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
	 * Extract exported names from a processed source file
	 * @param processedSourceFile - The processed source file
	 * @returns Array of exported names
	 */
	private getModuleExports(processedSourceFile: SourceFile): string[] {
		const exports: string[] = [];
		for (const statement of processedSourceFile.statements) {
			if (isExportDeclaration(statement) && statement.exportClause && isNamedExports(statement.exportClause)) {
				for (const element of statement.exportClause.elements) {
					exports.push(element.name.text);
				}
			}
		}
		return exports;
	}

	/**
	 * Main bundling orchestration method
	 * @param entryPoint - The entry point file path
	 * @returns The bundled declaration file content
	 */
	bundle(entryPoint: AbsolutePath): string {
		// Convert source path to declaration path
		const dtsEntryPoint = this.resolveEntryPoint(entryPoint, this.options.compilerOptions);

		// Build the module dependency graph
		const { modules, bundledSpecifiers } = this.buildModuleGraph(dtsEntryPoint);

		// Combine modules and collect exports and all declarations
		const { code } = this.combineModules(this.sortModules(modules, dtsEntryPoint), bundledSpecifiers);

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
	private resolveEntryPoint(entryPoint: AbsolutePath, compilerOptions: DtsCompilerOptions): AbsolutePath {
		// Convert source path to declaration path and normalize to POSIX format (TypeScript expects forward slashes)
		const dtsEntryPoint = sys.resolvePath(entryPoint.endsWith(FileExtension.DTS) ? entryPoint : this.sourceToDeclarationPath(entryPoint)) as AbsolutePath;

		// Validate the file exists
		if (!this.declarationFiles.has(dtsEntryPoint)) {
			// Provide detailed error for debugging
			const availableFiles = Array.from(this.declarationFiles.keys());
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

		return dtsEntryPoint;
	}
}

/**
 * Bundle TypeScript declaration files into a single output
 * @param options Bundling options
 * @returns The bundled declaration file content
 */
export async function bundleDeclarations(options: DtsBundleOptions): Promise<WrittenFile[]> {
	// Ensure output directory exists
	await mkdir(options.compilerOptions.outDir, defaultDirOptions);

	const dtsBundler = new DeclarationBundler(options);

	// Bundle each entry point in parallel for better performance
	const bundleTasks = Object.entries(options.entryPoints).map(async ([entryName, entryPoint]) => {
		const outPath = Paths.join(options.compilerOptions.outDir, `${entryName}.d.ts`);
		const content = dtsBundler.bundle(entryPoint);

		await writeFile(outPath, content, Encoding.utf8);

		return { path: Paths.relative(options.currentDirectory, outPath), size: content.length };
	});

	return Promise.all(bundleTasks);
}