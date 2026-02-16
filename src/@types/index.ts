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

type Optional<T> = T | undefined | void;
type OptionalReturn<T extends TypedFunction<T>> = Optional<ReturnType<T>>;

type Function<P = any, R = any> = (...args: P[]) => R;
type TypedFunction<T extends (...args: Parameters<T>) => ReturnType<T>> = (...args: Parameters<T>) => ReturnType<T>;
type InferredFunction<T = Function> = T extends (...args: infer P) => infer R ? (...args: P) => R : never;
/**
 * Type representing a method function signature with typed this, arguments, and return type.
 * Used to avoid inlining the method signature type repeatedly in decorator code.
 *
 * @template T - The type of 'this' context for the method
 * @template A - The types of the method arguments as a tuple
 * @template R - The return type of the method
 */
type MethodFunction<T = any, A extends any[] = any[], R = any> = (this: T, ...args: A) => R;
type Callable = Function<never, void>;
type Constructor<P extends unknown[] = unknown[], R = unknown> = new (...args: P) => R;

interface Closable { close: Callable };
type ClosableConstructor = Constructor<any[], Closable>;

type PerformanceEntryDetail<T = unknown[]> = { message: string, result?: T };
type DetailedPerformanceMeasureOptions<R> = PrettyModify<PerformanceMeasureOptions, { detail: PerformanceEntryDetail<R> }>;
type DetailedPerformanceEntry<D> = Prettify<PerformanceEntry & { detail: PerformanceEntryDetail<D> }>;

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
type JsonArray<T> = JsonValue<T>[];
type JsonObject<T> = { [K in keyof T as[JsonObject<T[K]>] extends [never] ? never : K]: JsonValue<T[K]> }
type JsonValue<T> = T extends string | number | boolean | null ? T : T extends { toJSON: () => infer R } ? R : T extends undefined | ((...args: any[]) => any) ? never : T extends JsonObject<T> ? JsonObject<T> : T extends JsonArray<T> ? JsonArray<T> : never;
type JsonString<T> = Brand<string, T>;

type DtsOptions = {
	/** Names of the projects `entryPoints` to be used to generate the DTS files */
	entryPoints?: string[];
	/** Resolve external types used in dts files from node_modules */
	resolve?: boolean;
};
type DtsConfiguration = MarkRequired<DtsOptions, 'resolve'>;

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
	/** Entry points for the build */
	entryPoints?: EntryPoints<RelativePath>;
	/** Platform target. Auto-detected from tsconfig lib (DOM = browser, no DOM = node) */
	platform?: 'browser' | 'node' | 'neutral';
	/** Whether to bundle source files together */
	bundle?: boolean;
	/** Remove all files from the output directory before building. Defaults to true */
	clean?: boolean;
	/** Default behavior for node_modules dependencies */
	packages?: 'bundle' | 'external';
	/** Specific dependencies to externalize (don't bundle) */
	external?: Pattern[];
	/** Specific dependencies to bundle (override packages setting) */
	noExternal?: Pattern[];
	/** Enable code splitting */
	splitting?: boolean;
	/** Minify the output */
	minify?: boolean;
	/** Source map options. Overrides the value in tsconfig.json CompilerOptions */
	sourceMap?: boolean | 'inline' | 'external' | 'both';
	/** Banner to inject at the start of output files */
	banner?: BannerOrFooter;
	/** Footer to inject at the end of output files */
	footer?: BannerOrFooter;
	/** Environment variables to inject */
	env?: Record<string, string>;
	/** Declaration bundling configuration */
	dts?: DtsOptions;
	/** Watch mode configuration */
	watch?: WatchOptions;
	/** Emit decorator metadata (requires `@swc/core` as optional dependency) */
	decoratorMetadata?: boolean;
	/** Custom esbuild plugins */
	plugins?: Plugin[];
};

type BuildConfiguration = PrettyModify<MarkRequired<BuildOptions, 'entryPoints' | 'splitting' | 'minify' | 'bundle' | 'noExternal' | 'sourceMap'>, { watch: WatchConfiguration, dts: DtsConfiguration }>;

type EntryPoints<out T extends Path> = Record<string, T>;
type AsyncEntryPoints = Promise<EntryPoints<AbsolutePath>>;

/** Project build options used internally (includes values from both tsbuild config and compiler options) */
type ProjectBuildConfiguration = Readonly<PrettyModify<BuildConfiguration, {
	entryPoints: AsyncEntryPoints,
	target: EsTarget,
	outDir: string,
	sourceMap: boolean | 'inline' | 'external' | 'both'
}>>;

type TypeScriptCompilerOptions = PrettyModify<Pick<CompilerOptions, KnownKeys<CompilerOptions>>, { target?: ScriptTarget }>;
type TypeScriptCompilerConfiguration = MarkRequired<TypeScriptCompilerOptions, 'target' | 'outDir' | 'noEmit' | 'sourceMap' | 'lib' | 'incremental' | 'tsBuildInfoFile'>;

type TypeScriptOptions = {
	clearCache?: boolean;
	compilerOptions?: TypeScriptCompilerOptions;
	tsbuild?: BuildOptions;
};

/** Cached declaration file with pre-processed code and extracted references */
type CachedDeclaration = {
	/** Pre-processed declaration code */
	code: string;
	/** Triple-slash type reference directives extracted during pre-processing */
	typeReferences: Set<string>;
	/** Triple-slash file reference directives extracted during pre-processing */
	fileReferences: Set<string>;
};

/** Interface for build cache operations */
interface BuildCache {
	invalidate(): void;
	restore(target: Map<string, CachedDeclaration>): Promise<void>;
	save(source: ReadonlyMap<string, CachedDeclaration>): Promise<void>;
	isBuildInfoFile(filePath: AbsolutePath): boolean;
};

type TypeScriptConfiguration = Readonly<PrettyModify<TypeScriptOptions, {
	clean: boolean;
	compilerOptions: TypeScriptCompilerConfiguration;
	tsbuild: BuildConfiguration;
	/** Project root directory */
	directory: AbsolutePath;
	/** Absolute paths of root names used to create the TypeScript program */
	rootNames: string[];
	/** Diagnostics encountered while parsing the config file */
	configFileParsingDiagnostics: Diagnostic[];
	/** Build cache instance for incremental builds */
	buildCache: BuildCache | undefined;
	/** Module Specifiers in 'include', 'exclude', & 'files' */
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
	sources: AbsolutePath[];
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
	Function,
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
	WrittenFile,
	Pattern,
	Closable,
	ClosableConstructor,
	CompilerOptionOverrides,
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
	CachedDeclaration
};