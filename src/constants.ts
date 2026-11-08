import { JsxEmit } from 'typescript/sync';
import { ScriptTarget } from 'typescript/ast';
import type { CompilerOptionOverrides, EsTarget, JsxRenderingMode, RelativePath } from './@types';
import { PerformancePhase } from './performance-phase';

/** Build system constants and configurations */
const dataUnits = [ 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB' ] as const;
const Package = { BUNDLE: 'bundle', EXTERNAL: 'external' } as const;
const Platform = { NODE: 'node', BROWSER: 'browser', NEUTRAL: 'neutral' } as const;
const BuildOutputStyle = { DASHBOARD: 'dashboard', PIPELINE: 'pipeline', ARTIFACTS: 'artifacts', SUMMARY: 'summary', DETAILED: 'detailed' } as const;
type BuildOutputStyle = typeof BuildOutputStyle[keyof typeof BuildOutputStyle];
const BuildMessageType = { ERROR: 'error', WARNING: 'warning' } as const;
const DependencyEntryType = { DEPENDENCIES: 'dependencies', PEER_DEPENDENCIES: 'peerDependencies' } as const;
const compilerOptionOverrides: CompilerOptionOverrides = {
	// Skip code generation when error occurs
	noEmitOnError: true,
	// Do not allow JavaScript files to be imported into TypeScript files
	allowJs: false,
	// Skip type-checking JavaScript files
	checkJs: false,
	// Skip declaration map generation. TODO - Would love to figure out how to combine them into a single file / entry point
	declarationMap: false,
	// Skip type-checking all dependencies
	skipLibCheck: true,
	// Ensure TS2742 errors are visible when `true`. TODO - Figure out how to have this work with a value of `true`
	preserveSymlinks: false,
	// Ensure we can parse the latest code
	target: ScriptTarget.ESNext
};

/** Maps TypeScript ScriptTarget enum to esbuild-compatible EsTarget string */
const scriptTargetToEsTarget: Record<ScriptTarget, EsTarget> = {
	[ScriptTarget.ES2015]: 'ES2015',
	[ScriptTarget.ES2016]: 'ES2016',
	[ScriptTarget.ES2017]: 'ES2017',
	[ScriptTarget.ES2018]: 'ES2018',
	[ScriptTarget.ES2019]: 'ES2019',
	[ScriptTarget.ES2020]: 'ES2020',
	[ScriptTarget.ES2021]: 'ES2021',
	[ScriptTarget.ES2022]: 'ES2022',
	[ScriptTarget.ES2023]: 'ES2023',
	[ScriptTarget.ES2024]: 'ES2024',
	[ScriptTarget.ES2025]: 'ES2025',
	// esbuild has no es2026 target yet
	[ScriptTarget.ES2026]: 'ESNext',
	[ScriptTarget.ESNext]: 'ESNext',
	[ScriptTarget.JSON]: 'ESNext'
};

const jsxEmitMap: Partial<Record<JsxEmit, JsxRenderingMode>> = {
	[JsxEmit.Preserve]: 'preserve',
	[JsxEmit.React]: 'react',
	[JsxEmit.ReactNative]: 'react-native',
	[JsxEmit.ReactJSX]: 'react-jsx',
	[JsxEmit.ReactJSXDev]: 'react-jsxdev'
};

/**
 * Converts TypeScript's ScriptTarget enum to an esbuild-compatible EsTarget string.
 * @param target - The TypeScript ScriptTarget enum value. Defaults to ScriptTarget.ESNext if not provided.
 * @returns The corresponding EsTarget string (e.g., 'ES2022', 'ESNext')
 */
const toEsTarget: (target?: ScriptTarget) => EsTarget = (target: ScriptTarget = ScriptTarget.ESNext) => scriptTargetToEsTarget[target];

/** Returns undefined for any input, useful for defaulting optional values. */
const alwaysUndefined = () => undefined;

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Converts TypeScript's JsxEmit enum to an esbuild-compatible jsx string.
 * @param jsxEmit - The TypeScript JsxEmit enum value
 * @returns The corresponding jsx string (e.g., 'react', 'preserve'), or undefined for JsxEmit.None
 */
const toJsxRenderingMode: (jsxEmit?: JsxEmit) => JsxRenderingMode | undefined = (jsxEmit?: JsxEmit) => jsxEmit !== undefined ? jsxEmitMap[jsxEmit] : undefined;

const FileExtension = {
	TS: '.ts',
	TSX: '.tsx',
	JSX: '.jsx',
	JS: '.js',
	DTS: '.d.ts',
	CSS: '.css',
	JSON: '.json'
} as const;

type FileExtension = typeof FileExtension[keyof typeof FileExtension];

const Encoding = {
	utf8: 'utf8',
	base64: 'base64'
} as const;

const defaultDirOptions = { recursive: true } as const;
const defaultCleanOptions = { recursive: true, force: true } as const;
const defaultOutDirectory = 'dist';
const defaultEntryPoint = 'index';
const defaultSourceDirectory = './src' as RelativePath;
const defaultEntryFile = 'src/index.ts' as RelativePath;
const cacheDirectory = '.tsbuild' as RelativePath;
/** Cache version - increment when structure or declaration preprocessing changes (v7: deduplicate explicit exports) */
const dtsCacheVersion = 7;
// Version-stamped so stale structures and preprocessed declarations have a different filename and are never read.
const dtsCacheFile: string = `dts_cache.v${dtsCacheVersion}.br`;
const format = 'esm';
const newLine = '\n';
const typeMatcher: RegExp = /\btype\b/;
const nodeModulesPathPattern: RegExp = /\/node_modules\//;
const sourceScriptExtensionExpression: RegExp = /(?<!\.d)\.[jt]sx?$/;
const typeScriptExtensionExpression: RegExp = /(\.tsx?)$/;
/** Pattern to match and expand process.env references in config values (e.g., "${process.env.npm_package_version}") */
const processEnvExpansionPattern: RegExp = /\$\{process\.env\.([^}]+)\}/;
/** Pattern to match inline type specifiers in imports (e.g., `import { foo, type Bar }`) */
const inlineTypePattern: RegExp = /([{,]\s+)type\s+/;

export {
	dataUnits,
	compilerOptionOverrides,
	Package,
	Platform,
	BuildOutputStyle,
	PerformancePhase,
	BuildMessageType,
	DependencyEntryType,
	sourceScriptExtensionExpression,
	typeScriptExtensionExpression,
	processEnvExpansionPattern,
	inlineTypePattern,
	Encoding,
	defaultDirOptions,
	defaultCleanOptions,
	defaultSourceDirectory,
	defaultOutDirectory,
	defaultEntryPoint,
	defaultEntryFile,
	cacheDirectory,
	dtsCacheFile,
	dtsCacheVersion,
	format,
	newLine,
	typeMatcher,
	nodeModulesPathPattern,
	FileExtension,
	toEsTarget,
	alwaysUndefined,
	isString,
	toJsxRenderingMode
};
