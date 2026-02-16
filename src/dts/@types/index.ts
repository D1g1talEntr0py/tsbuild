import type { AbsolutePath, Brand, CachedDeclaration, EntryPoints, Pattern, RelativePath } from '../../@types/index.js';
import type { ModuleResolutionKind, Node, SourceFile } from 'typescript';

declare const NameRangeBrand: unique symbol;
type NameRange = Brand<[start: number, end: number], typeof NameRangeBrand>;

/** Minimal compiler options needed for DTS bundling - only what's required for module resolution and path remapping */
type DtsCompilerOptions = {
	/** Path mapping entries for module resolution */
	paths?: Record<string, RelativePath[]>;
	/** Root directory of source files (used for path remapping) - optional, defaults to common root */
	rootDir?: AbsolutePath;
	/** Output directory (used for path remapping and entry point resolution) - guaranteed from TypeScriptConfiguration */
	outDir: AbsolutePath;
	/** Module resolution strategy for resolving imports */
	moduleResolution?: ModuleResolutionKind;
};

type DtsBundleOptions = {
	/** Current working directory */
	currentDirectory: AbsolutePath;
	declarationFiles: ReadonlyMap<string, CachedDeclaration>;
	entryPoints: EntryPoints<AbsolutePath>;
	/** Resolve external types used in dts files from node_modules */
	resolve: boolean;
	external: Pattern[];
	/** Force bundling of these packages even if they're in node_modules */
	noExternal: Pattern[];
	compilerOptions: DtsCompilerOptions;
};

/** Type and value identifier collections from AST analysis */
type IdentifierMap = {
	/** Type identifiers (interfaces, type aliases) */
	types: Set<string>;
	/** Value identifiers (classes, functions, enums, variables) */
	values: Set<string>;
};

type ModuleInfo = {
	/** Absolute file path */
	path: AbsolutePath;
	/** Pre-processed declaration file content */
	code: string;
	/** Modules this one imports */
	imports: Set<string>;
	/** Triple-slash type references */
	typeReferences: ReadonlySet<string>;
	/** Triple-slash file references */
	fileReferences: ReadonlySet<string>;
	/** Cached processed source file AST (always present, used for bundling) */
	sourceFile: SourceFile;
	/** Cached type and value identifiers (always present, computed from processed AST) */
	identifiers: IdentifierMap;
};

type PreProcessOutput = {
	code: string;
	typeReferences: Set<string>;
	fileReferences: Set<string>;
};

type CodeTransformation = {
	/** Start position in the source code */
	start: number;
	/** End position in the source code */
	end: number;
	/** Optional replacement text (if undefined, the range is deleted) */
	replacement?: string;
};

/** Versioned cache structure for upgrade safety */
type VersionedCache = {
	/** Cache format version for compatibility checking */
	version: number;
	/** Cached declaration files: path -> pre-processed code with extracted references */
	files: Record<string, CachedDeclaration>;
};

/** Declaration code with collected export information */
type DeclarationCode = {
	/** The processed code with imports/exports removed */
	code: string;
	/** External import statements to preserve */
	externalImports: string[];
	/** Type-only exports */
	typeExports: string[];
	/** Value exports */
	valueExports: string[];
};

/** Module dependency graph with bundled specifier tracking */
type ModuleDependencyGraph = {
	/** Map of file paths to module information */
	readonly modules: ReadonlyMap<string, ModuleInfo>;
	/** Map of module paths to their bundled import specifiers */
	readonly bundledSpecifiers: ReadonlyMap<string, readonly string[]>;
};

/** Bundled declaration with exports and all declarations */
type BundledDeclaration = {
	/** The combined declaration code */
	code: string;
	/** All exported identifiers */
	exports: string[];
	/** All declarations from bundled modules */
	allDeclarations: Set<string>;
};

export type { NameRange, DtsBundleOptions, DtsCompilerOptions, ModuleInfo, PreProcessOutput, CodeTransformation, VersionedCache, IdentifierMap, DeclarationCode, ModuleDependencyGraph, BundledDeclaration };