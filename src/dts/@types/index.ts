import type { SourceFile } from 'typescript/ast';
import type { API, ModuleResolutionKind } from 'typescript/sync';
import type { AbsolutePath, Brand, CachedDeclaration, EntryPoints, Pattern } from 'src/@types/index';

declare const NameRangeBrand: unique symbol;
type NameRange = Brand<[start: number, end: number], typeof NameRangeBrand>;

type SourceDeclaration = { text: string; sourceFile: SourceFile };

/** Minimal compiler options needed for DTS bundling - only what's required for module resolution and path remapping */
type DtsCompilerOptions = {
	/** Path mapping entries for module resolution */
	paths?: Record<string, string[]>;
	/** Root directory of source files (used for path remapping) - optional, defaults to common root */
	rootDir?: AbsolutePath;
	/** Output directory (used for path remapping and entry point resolution) - guaranteed from TypeScriptConfiguration */
	outDir: AbsolutePath;
	moduleResolution?: ModuleResolutionKind;
	/** Path of the tsconfig, used to anchor relative `paths` when no `baseUrl` is set */
	configFilePath?: string;
};

type DtsBundleOptions = {
	/** TypeScript API used for parsing and module resolution (owned by the caller) */
	api: API;
	currentDirectory: AbsolutePath;
	declarationFiles: ReadonlyMap<string, CachedDeclaration>;
	/** Project-owned syntax cache for unchanged, preprocessed declaration text */
	sourceFileCache?: Map<AbsolutePath, SourceDeclaration>;
	entryPoints: EntryPoints<AbsolutePath>;
	/** Resolve external types used in dts files from node_modules */
	resolve: boolean;
	external: Pattern[];
	/** Force bundling of these packages even if they're in node_modules */
	noExternal: Pattern[];
	compilerOptions: DtsCompilerOptions;
	/** Whether transpile is running in parallel (only yield if true) */
	parallelTranspile: boolean;
	/** Synchronous work, in milliseconds, between event-loop yields when `parallelTranspile` is true (default 10; 0 yields at every checkpoint) */
	yieldIntervalMs?: number;
};

/** Type and value identifier collections from AST analysis */
type IdentifierMap = {
	/** Type identifiers (interfaces, type aliases) */
	types: Set<string>;
	/** Value identifiers (classes, functions, enums, variables) */
	values: Set<string>;
};

type ModuleInfo = {
	path: AbsolutePath;
	code: string;
	imports: Set<AbsolutePath>;
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
	start: number;
	end: number;
	/** Optional replacement text (if undefined, the range is deleted) */
	replacement?: string;
};

/** Structured external import preserved during DTS bundling. Avoids re-parsing import text via regex. */
type ExternalImport =
	| { kind: 'named'; specifier: string; isType: boolean; names: string[]; attributes?: string }
	| { kind: 'raw'; text: string };

type ExportedName = {
	localName: string;
	exportedName: string;
	isType: boolean;
};

/** A bundled `export * as name from './module'`, emitted as a `declare namespace` that re-exports the module's bindings */
type NamespaceExport = {
	exportedName: string;
	isType: boolean;
	members: ExportedName[];
};

/** Declaration code with collected export information */
type DeclarationCode = {
	code: string;
	/** External import statements to preserve (structured, not text) */
	externalImports: ExternalImport[];
	typeExports: ExportedName[];
	valueExports: ExportedName[];
	namespaceExports: NamespaceExport[];
};

/** Module dependency graph with bundled specifier tracking */
type ModuleDependencyGraph = {
	readonly modules: ReadonlyMap<AbsolutePath, ModuleInfo>;
	readonly bundledSpecifiers: ReadonlyMap<string, ReadonlySet<string>>;
	/** Per module: specifiers resolving to another entry point, mapped to the relative specifier of that entry's bundled output */
	readonly entrySpecifiers: ReadonlyMap<string, ReadonlyMap<string, string>>;
};

/** How an import binds another entry's export: as a value, through `import type`, or through an inline `type` marker */
type EntryImportMode = 'value' | 'type' | 'inline-type';

/** An export of another entry point bound by a bundled module instead of being inlined */
type EntryImportBinding = {
	/** Relative specifier of the referenced entry's bundled output (e.g. `./other.js`) */
	readonly specifier: string;
	/** Export name in the referenced entry (`*` for namespace imports) */
	readonly importedName: string;
	/** Name bound in the bundle (renamed when it conflicts with another binding) */
	localName: string;
	mode: EntryImportMode;
};

/** Other entry points referenced by a single bundled module */
type EntryReferences = {
	/** Source specifiers resolving to another entry, mapped to the relative specifier of that entry's bundled output */
	readonly specifiers: ReadonlyMap<string, string>;
	/** Bindings keyed by their local name in the module */
	readonly bindings: ReadonlyMap<string, EntryImportBinding>;
	/** Named re-exports of a non-entry module, keyed by exported name. They are imported as bindings and exported to importing modules. */
	readonly reexports: ReadonlyMap<string, EntryImportBinding>;
	/** Whether the module is the entry being bundled, whose re-exports form the public API */
	readonly isEntryModule: boolean;
};

export type { NameRange, SourceDeclaration, DtsBundleOptions, DtsCompilerOptions, ModuleInfo, PreProcessOutput, CodeTransformation, IdentifierMap, ExportedName, NamespaceExport, DeclarationCode, ExternalImport, ModuleDependencyGraph, EntryImportMode, EntryImportBinding, EntryReferences };
