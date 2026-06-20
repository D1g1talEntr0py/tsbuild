import type { Plugin, TsconfigRaw } from 'esbuild';
import type { FileSystemEvent, WatchrOptions } from '@d1g1tal/watchr';
import type { CompilerOptions, Diagnostic, ProjectReference, ScriptTarget } from 'typescript';
import type { PerformanceEntry, PerformanceMeasureOptions } from 'node:perf_hooks';

declare global {
	interface ImportMeta {
		env?: {
			tsbuild_version?: string;
		};
	}
}

type Prettify<T> = T extends infer U ? { [K in keyof U]: U[K] } : never;
type KnownKeys<T> = keyof RemoveIndex<T>;
type MarkRequired<T, K extends keyof T> = Prettify<T & { [P in K]-?: T[P] }>;
type RemoveIndex<T> = { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };
type PrettyModify<T, R extends Partial<Record<keyof T, unknown>>> = Prettify<Omit<T, keyof R> & R>;
type Modify<T, R extends Partial<Record<keyof T, unknown>>> = Omit<T, keyof R> & R;

type Optional<T> = T | undefined | void;
type OptionalReturn<T extends (...args: any[]) => any> = Optional<ReturnType<T>>;

type Fn<P = any, R = any> = (...args: P[]) => R;
type TypedFunction<T extends (...args: any[]) => any> = (...args: Parameters<T>) => ReturnType<T>;
type InferredFunction<T = Fn> = T extends (...args: infer P) => infer R ? (...args: P) => R : never;
/**
 * Type representing a method function signature with typed this, arguments, and return type.
 * Used to avoid inlining the method signature type repeatedly in decorator code.
 *
 * @template T - The type of 'this' context for the method
 * @template A - The types of the method arguments as a tuple
 * @template R - The return type of the method
 */
type MethodFunction<T = any, A extends any[] = any[], R = any> = (this: T, ...args: A) => R;
type Callable = Fn<never, void>;
type Constructor<P extends unknown[] = unknown[], R = unknown> = new (...args: P) => R;

interface Closable { close: Callable };
type ClosableConstructor = Constructor<any[], Closable>;

type PerformanceSubStep = { name: string; duration: string; ms: number };
type PerformanceEntryDetail<T = unknown[]> = { message: string, result?: T, steps?: PerformanceSubStep[], notes?: string[] };
type DetailedPerformanceMeasureOptions<R> = Modify<PerformanceMeasureOptions, { detail: PerformanceEntryDetail<R> }>;
type DetailedPerformanceEntry<D> = PerformanceEntry & { detail: PerformanceEntryDetail<D> };

type Pattern = string | RegExp;

const ES_VERSIONS = [6, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] as const;
type EsVersion = typeof ES_VERSIONS[number];
type EsTarget = `ES${EsVersion}` | 'ESNext';

type BannerOrFooter = { [type in 'js' | 'css']?: string };

/**
 * Creates a "branded" type with nominal typing.
 * This adds a unique, non-existent property to 'T' to make it
 * incompatible with other types that are structurally the same.
 *
 * @template T - The base type to brand
 * @template U - The brand identifier (symbol type or any other type)
 *
 * @example Symbol brands (stronger nominal typing):
 * declare const PathSymbol: unique symbol;
 * type Path = Brand<string, typeof PathSymbol>;
 *
 * @example Generic brands:
 * type JsonString<T> = Brand<string, T>;
 */
type Brand<T, U> = U extends symbol ? T & { readonly [K in U]: true } : T & { readonly __brand: U };

// Branded path types for type safety without runtime overhead
declare const AbsolutePathBrand: unique symbol;
declare const RelativePathBrand: unique symbol;

/** An absolute file system path (e.g., `/home/user/project` or `C:\Users\project`) */
type AbsolutePath = Brand<string, typeof AbsolutePathBrand>;

/** A relative file system path (e.g., `./src` or `../lib`) */
type RelativePath = Brand<string, typeof RelativePathBrand>;

/** A file system path that can be either absolute or relative */
type Path = AbsolutePath | RelativePath;

type ConditionalPath<T extends string | Path> = T extends AbsolutePath ? AbsolutePath : T extends RelativePath ? RelativePath : Path;

// JSON types
type JsonString<T> = Brand<string, T>;

type DtsOptions = {
	/** Names of the projects `entryPoints` to be used to generate the DTS files */
	entryPoints?: string[];
	/** Resolve external types used in dts files from node_modules */
	resolve?: boolean;
};
type DtsConfiguration = MarkRequired<DtsOptions, 'resolve'>;

type IifeOptions = {
	/** Global variable name for the IIFE bundle (e.g., 'MyLib' becomes `globalThis.MyLib`) */
	globalName?: string;
};

type WatchOptions = PrettyModify<WatchrOptions, { enabled: boolean, recursive?: boolean, persistent?: boolean, ignoreInitial?: boolean, ignore?: string[] }>;
type WatchConfiguration = MarkRequired<WatchOptions, 'recursive' | 'persistent' | 'ignoreInitial'>;
type PendingFileChange = { event: FileSystemEvent; path: AbsolutePath; nextPath?: AbsolutePath; };
type JsxRenderingMode = NonNullable<Required<TsconfigRaw>['compilerOptions']['jsx']>;

/** User-facing tsbuild configuration (excludes TypeScript compiler options like target, outDir, sourceMap) */
type BuildOptions = {
	/** Project directory (relative or absolute). Defaults to the current directory. Resolved to absolute internally. */
	project?: Path;
	/** Force a full rebuild, even if no files have changed. Applicable for incremental builds */
	force?: boolean;
	entryPoints?: EntryPoints<RelativePath>;
	/** Platform target. Auto-detected from tsconfig lib (DOM = browser, no DOM = node) */
	platform?: 'browser' | 'node' | 'neutral';
	bundle?: boolean;
	/** Remove all files from the output directory before building. Defaults to true */
	clean?: boolean;
	/** Default behavior for node_modules dependencies */
	packages?: 'bundle' | 'external';
	/** Specific dependencies to externalize (don't bundle) */
	external?: Pattern[];
	/** Specific dependencies to bundle (override packages setting) */
	noExternal?: Pattern[];
	splitting?: boolean;
	minify?: boolean;
	/** Source map options. Overrides the value in tsconfig.json CompilerOptions */
	sourceMap?: boolean | 'inline' | 'external' | 'both';
	banner?: BannerOrFooter;
	footer?: BannerOrFooter;
	env?: Record<string, string>;
	dts?: DtsOptions;
	watch?: WatchOptions;
	/** Emit decorator metadata (requires `@swc/core` as optional dependency) */
	decoratorMetadata?: boolean;
	/** Produce additional IIFE output alongside ESM. Set to `true` for default IIFE or provide options. */
	iife?: boolean | IifeOptions;
	/** Custom esbuild plugins (Plugin objects via programmatic API, or string/tuple references via config) */
	plugins?: (Plugin | PluginReference)[];
};

/**
 * A reference to an esbuild plugin resolved at build time.
 * - `string` — bare npm specifier or relative path to a plugin module
 * - `[string, Record<string, unknown>]` — module specifier with options passed to the factory function
 */
type PluginReference = string | [string, Record<string, unknown>];

type BuildConfiguration = PrettyModify<MarkRequired<BuildOptions, 'entryPoints' | 'splitting' | 'minify' | 'bundle' | 'noExternal' | 'sourceMap'>, { watch: WatchConfiguration, dts: DtsConfiguration }>;

type EntryPoints<out T extends Path> = Record<string, T>;
type AsyncEntryPoints = Promise<EntryPoints<AbsolutePath>>;

/** Project build options used internally (includes values from both tsbuild config and compiler options) */
type ProjectBuildConfiguration = Readonly<Modify<BuildConfiguration, {
	entryPoints: AsyncEntryPoints,
	target: EsTarget,
	outDir: string,
	sourceMap: boolean | 'inline' | 'external' | 'both'
}>>;

type TypeScriptCompilerOptions = Modify<Pick<CompilerOptions, KnownKeys<CompilerOptions>>, { target?: ScriptTarget }>;
type TypeScriptCompilerConfiguration = MarkRequired<TypeScriptCompilerOptions, 'target' | 'outDir' | 'noEmit' | 'sourceMap' | 'lib' | 'incremental' | 'tsBuildInfoFile'>;

type TypeScriptOptions = {
	clearCache?: boolean;
	compilerOptions?: TypeScriptCompilerOptions;
	tsbuild?: BuildOptions;
};

/** Cached declaration file with pre-processed code and extracted references */
type CachedDeclaration = {
	code: string;
	/** Triple-slash type reference directives extracted during pre-processing */
	typeReferences: ReadonlySet<string>;
	/** Triple-slash file reference directives extracted during pre-processing */
	fileReferences: ReadonlySet<string>;
};

/** Persistent cache payload stored in the version-stamped .tsbuild/dts_cache.v{N}.br */
type BuildCache = {
	/** Cache format version for compatibility checking */
	version: number;
	/** Cached declaration files: path -> pre-processed code with extracted references */
	files: Map<string, CachedDeclaration>;
	/** Build configuration fingerprint: hash of output-affecting options (minify, iife, declaration, platform, etc.) */
	fingerprint?: string;
};

interface BuildCacheManager {
	invalidate(): void;
	restore(target: Map<string, CachedDeclaration>): Promise<void>;
	save(source: ReadonlyMap<string, CachedDeclaration>, fingerprint: string): Promise<void>;
	isValid(): boolean;
	isBuildInfoFile(filePath: AbsolutePath): boolean;
	/** Synchronously checks whether persisted incremental state exists on disk (i.e. .tsbuildinfo). */
	hasPersistedState(): boolean;
	/** Synchronously checks whether a manifest snapshot from a prior build is available. */
	hasPersistedManifest(): boolean;
	/** Returns the project-relative output paths recorded by the previous build, or undefined if none. */
	getPreviousOutputs(): readonly string[] | undefined;
	/** Persists the project-relative output paths produced by the current build. Fire-and-forget. */
	saveOutputs(outputs: readonly string[]): Promise<void>;
	/** Checks whether the build configuration has changed since the cache was last saved. */
	fingerprintMatches(currentFingerprint: string): Promise<boolean>;
};

type TypeScriptConfiguration = Readonly<Modify<TypeScriptOptions, {
	clean: boolean;
	compilerOptions: TypeScriptCompilerConfiguration;
	tsbuild: BuildConfiguration;
	directory: AbsolutePath;
	/** Absolute paths of root names used to create the TypeScript program */
	rootNames: string[];
	configFileParsingDiagnostics: Diagnostic[];
	buildCache: BuildCacheManager | undefined;
	include?: string[];
	exclude?: string[];
	files?: string[];
	extends?: string;
	projectReferences?: ProjectReference[];
}>>;

type ProjectDependencies = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
};

type ReadConfigSuccess = { config: TypeScriptOptions; error: undefined };
type ReadConfigError = { config: undefined; error: Diagnostic };
type ReadConfigResult = ReadConfigSuccess | ReadConfigError;

type WrittenFile = {
	readonly path: RelativePath;
	readonly size: number;
};

// Compiler option overrides type
type CompilerOptionOverrides = Readonly<{
	noEmitOnError: true;
	allowJs: false;
	checkJs: false;
	declarationMap: false;
	skipLibCheck: true;
	preserveSymlinks: false;
	target: ScriptTarget.ESNext;
}>;

type SourceMap = {
	version: number;
	sources: string[];
	names: string[];
	mappings: string;
	file?: string;
	sourceRoot?: string;
	sourcesContent?: string[];
};

// Text formatting function type
type FormatSupplier = (text: string) => string;
type LogEntryType = 'info' | 'success' | 'done' | 'error' | 'warn';

export type {
	Fn,
	TypedFunction,
	InferredFunction,
	Brand,
	MethodFunction,
	OptionalReturn,
	JsonString,
	DetailedPerformanceMeasureOptions as PerformanceMeasureOptions,
	DetailedPerformanceEntry,
	ProjectDependencies,
	ReadConfigResult,
	EntryPoints,
	AsyncEntryPoints,
	TypeScriptOptions,
	TypeScriptConfiguration,
	ProjectBuildConfiguration,
	BuildConfiguration,
	BuildCache,
	BuildCacheManager,
	WrittenFile,
	Pattern,
	Closable,
	ClosableConstructor,
	CompilerOptionOverrides,
	PerformanceSubStep,
	SourceMap,
	PendingFileChange,
	JsxRenderingMode,
	FormatSupplier,
	Path,
	AbsolutePath,
	RelativePath,
	ConditionalPath,
	LogEntryType,
	EsTarget,
	CachedDeclaration,
	PluginReference,
	IifeOptions,
	Plugin,
}