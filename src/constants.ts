import { JsxEmit, ScriptTarget } from 'typescript';
import type { CompilerOptionOverrides, EsTarget, JsxRenderingMode, RelativePath } from './@types';

/** Build system constants and configurations */
const dataUnits = [ 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB' ] as const;
const Package = { BUNDLE: 'bundle', EXTERNAL: 'external' } as const;
const Platform = { NODE: 'node', BROWSER: 'browser', NEUTRAL: 'neutral' } as const;
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
	target: ScriptTarget.ESNext,
};

/** Maps TypeScript ScriptTarget enum to esbuild-compatible EsTarget string */
const scriptTargetToEsTarget: Record<ScriptTarget, EsTarget> = {
	[ScriptTarget.ES3]: 'ES6',
	[ScriptTarget.ES5]: 'ES6',
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
 * @param target - The TypeScript ScriptTarget enum value
 * @returns The corresponding EsTarget string (e.g., 'ES2022', 'ESNext')
 */
const toEsTarget = (target: ScriptTarget): EsTarget => scriptTargetToEsTarget[target];

/**
 * Converts TypeScript's JsxEmit enum to an esbuild-compatible jsx string.
 * @param jsxEmit - The TypeScript JsxEmit enum value
 * @returns The corresponding jsx string (e.g., 'react', 'preserve'), or undefined for JsxEmit.None
 */
const toJsxRenderingMode = (jsxEmit?: JsxEmit): JsxRenderingMode | undefined => jsxEmit !== undefined ? jsxEmitMap[jsxEmit] : undefined;

const NodeType = {
	Program: 'Program',
	Identifier: 'Identifier',
	Literal: 'Literal',
	ImportSpecifier: 'ImportSpecifier',
	ImportNamespaceSpecifier: 'ImportNamespaceSpecifier',
	ImportDeclaration: 'ImportDeclaration',
	ImportDefaultSpecifier: 'ImportDefaultSpecifier',
	ExportSpecifier: 'ExportSpecifier',
	ExportNamedDeclaration: 'ExportNamedDeclaration',
	ExportAllDeclaration: 'ExportAllDeclaration',
	ExportDefaultDeclaration: 'ExportDefaultDeclaration',
	FunctionDeclaration: 'FunctionDeclaration',
	FunctionExpression: 'FunctionExpression',
	MemberExpression: 'MemberExpression',
	ArrayExpression: 'ArrayExpression',
	CallExpression: 'CallExpression',
	ExpressionStatement: 'ExpressionStatement',
	BlockStatement: 'BlockStatement',
	ReturnStatement: 'ReturnStatement',
	AssignmentPattern: 'AssignmentPattern'
} as const;

const FileExtension = {
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
const buildInfoFile = 'tsconfig.tsbuildinfo';
const dtsCacheFile = 'dts_cache.v8.br';
/** Cache format version - increment when cache structure changes (v2: V8 serialization + pre-processed declarations) */
const dtsCacheVersion = 2;
const format = 'esm';
const newLine = '\n';
const typeMatcher: RegExp = /\btype\b/;
const sourceScriptExtensionExpression: RegExp = /(?<!\.d)\.[jt]sx?$/;
const typeScriptExtensionExpression: RegExp = /(\.tsx?)$/;
/** Pattern to match and expand process.env references in config values (e.g., "${process.env.npm_package_version}") */
const processEnvExpansionPattern: RegExp = /\$\{process\.env\.([^}]+)\}/g;
/** Pattern to match inline type specifiers in imports (e.g., `import { foo, type Bar }`) */
const inlineTypePattern: RegExp = /([{,]\s+)type\s+/g;

export {
	dataUnits,
	compilerOptionOverrides,
	Package,
	Platform,
	BuildMessageType,
	DependencyEntryType,
	NodeType,
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
	buildInfoFile,
	dtsCacheFile,
	dtsCacheVersion,
	format,
	newLine,
	typeMatcher,
	FileExtension,
	toEsTarget,
	toJsxRenderingMode
};
