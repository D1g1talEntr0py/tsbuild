import type { AbsolutePath, Brand, CachedDeclaration, EntryPoints, Pattern } from '../../@types/index.js';
import type { ModuleResolutionKind, SourceFile } from 'typescript';

declare const NameRangeBrand: unique symbol;
type NameRange = Brand<[start: number, end: number], typeof NameRangeBrand>;

/** Minimal compiler options needed for DTS bundling - only what's required for module resolution and path remapping */
type DtsCompilerOptions = {
	/** Path mapping entries for module resolution */
	paths?: Record<string, string[]>;
	/** Root directory of source files (used for path remapping) - optional, defaults to common root */
	rootDir?: AbsolutePath;
	/** Output directory (used for path remapping and entry point resolution) - guaranteed from TypeScriptConfiguration */
	outDir: AbsolutePath;
	moduleResolution?: ModuleResolutionKind;
};

type DtsBundleOptions = {
	currentDirectory: AbsolutePath;
	declarationFiles: ReadonlyMap<string, CachedDeclaration>;
	entryPoints: EntryPoints<AbsolutePath>;
	/** Resolve external types used in dts files from node_modules */
	resolve: boolean;
	external: Pattern[];
	/** Force bundling of these packages even if they're in node_modules */
	noExternal: Pattern[];
	compilerOptions: DtsCompilerOptions;
	/** Whether transpile is running in parallel (only yield if true) */
	parallelTranspile: boolean;
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
	start: number;
	end: number;
	/** Optional replacement text (if undefined, the range is deleted) */
	replacement?: string;
};

/** Structured external import preserved during DTS bundling. Avoids re-parsing import text via regex. */
type ExternalImport =
	| { kind: 'named'; specifier: string; isType: boolean; names: string[] }
	| { kind: 'raw'; text: string };

/** Declaration code with collected export information */
type DeclarationCode = {
	code: string;
	/** External import statements to preserve (structured, not text) */
	externalImports: ExternalImport[];
	typeExports: string[];
	valueExports: string[];
};

/** Module dependency graph with bundled specifier tracking */
type ModuleDependencyGraph = {
	readonly modules: ReadonlyMap<string, ModuleInfo>;
	readonly bundledSpecifiers: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Bundled declaration with exports and all declarations */
type BundledDeclaration = {
	code: string;
	exports: string[];
	allDeclarations: Set<string>;
};

export type { NameRange, DtsBundleOptions, DtsCompilerOptions, ModuleInfo, PreProcessOutput, CodeTransformation, IdentifierMap, DeclarationCode, ExternalImport, ModuleDependencyGraph, BundledDeclaration };