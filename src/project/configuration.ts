import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { formatDiagnostics } from 'typescript/sync';
import { toRootedDirectoryPath } from 'typescript/path';
import { Paths } from '../paths';
import { Json } from '../json';
import { Logger } from '../logger';
import { ConfigurationError } from '../errors';
import { IncrementalBuildCache } from '../incremental-build-cache';
import { inferEntryPoints, normalizeEntryPoints, type PackageJson } from '../entry-points';
import { compilerOptionOverrides, defaultSourceDirectory, defaultOutDirectory, defaultEntryPoint, defaultEntryFile, Platform, BuildOutputStyle } from '../constants';
import { diagnosticsHost } from './diagnostics';
import type { API } from 'typescript/sync';
import type { AbsolutePath, RelativePath, CommandLineOptions, TypeScriptOptions, TypeScriptConfiguration, ReadConfigResult, EntryPoints, JsonString, BuildConfiguration } from '../@types';

/** Default CLI-only runtime options for project construction. */
export const defaultCommandLineOptions: CommandLineOptions = { clearCache: false, force: false, watch: false, minify: false };

const domPredicate = (lib: string) => [ 'DOM', 'LIB.DOM.D.TS' ].includes(lib.toUpperCase());
const jsonTsbuildKeys = [ 'entryPoints', 'platform', 'bundle', 'clean', 'outputStyle', 'packages', 'external', 'noExternal', 'dts', 'env', 'sourceMap', 'splitting', 'banner', 'footer', 'plugins', 'iife' ] as const;
const jsonDtsKeys = [ 'entryPoints', 'resolve' ] as const;
const jsonBannerFooterKeys = [ 'js', 'css' ] as const;
const jsonIifeKeys = [ 'globalName' ] as const;
const declarationFileExpression = /\.d\.(?:[^./]+\.)?[cm]?ts$/;

/**
 * Computes the deepest directory containing every non-declaration root file.
 * TypeScript 7 no longer infers this layout root for `outDir` and reports TS5011 instead, so tsbuild supplies it as the implicit `rootDir`.
 * @param fileNames - Absolute root file names from the parsed configuration
 * @returns The common source directory, or undefined when there are no source roots
 */
function commonSourceDirectory(fileNames: readonly string[]) {
	let common: string[] | undefined;

	for (const fileName of fileNames) {
		if (declarationFileExpression.test(fileName)) { continue }

		const segments = Paths.directoryName(fileName).split('/');

		if (common === undefined) { common = segments; continue }

		let length = 0;
		while (length < common.length && common[length] === segments[length]) { length++ }

		common.length = length;
	}

	return common && (common.join('/') || '/');
}

/**
 * Finds the nearest tsconfig.json by walking up from a directory.
 * @param directory - Directory to start searching from
 * @returns Absolute path of the nearest tsconfig.json, or undefined when none exists
 */
function findConfigFile(directory: AbsolutePath): AbsolutePath | undefined {
	for (let current = directory, parent = dirname(current) as AbsolutePath; ; current = parent, parent = dirname(current) as AbsolutePath) {
		const candidate = Paths.join(current, 'tsconfig.json');
		if (existsSync(candidate)) { return candidate }
		if (parent === current) { return undefined }
	}
}

/**
 * Reads a UTF-8 file, returning undefined when it cannot be read.
 * @param path - Absolute file path
 */
function readOptionalFile(path: AbsolutePath): string | undefined {
	try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/**
 * Rejects unknown keys in a JSON configuration object.
 * @param value - Configuration object to inspect
 * @param path - Dot-delimited path to the object
 * @param keys - Valid keys for the object
 */
function validateJsonObjectKeys(value: unknown, path: string, keys: readonly string[]) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) { return }

	const allowedKeys = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			throw new ConfigurationError(`Unknown configuration key "${path}.${key}". Valid keys: ${keys.join(', ')}`);
		}
	}
}

/**
 * Narrows a value to a non-array JSON object.
 * @param value - The value to narrow
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates the JSON-only tsbuild configuration surface.
 * @param tsbuild - Raw tsbuild value read from tsconfig.json
 */
function validateJsonTsbuildConfiguration(tsbuild: unknown) {
	if (isPlainObject(tsbuild)) {
		for (const option of [ 'clearCache', 'force', 'minify', 'watch' ]) {
			if (option in tsbuild) { throw new ConfigurationError(`Configuration option "tsbuild.${option}" is CLI-only; use the "--${option}" command-line option.`) }
		}
	}

	validateJsonObjectKeys(tsbuild, 'tsbuild', jsonTsbuildKeys);

	if (!isPlainObject(tsbuild)) { return }

	validateJsonObjectKeys(tsbuild['dts'], 'tsbuild.dts', jsonDtsKeys);
	validateJsonObjectKeys(tsbuild['banner'], 'tsbuild.banner', jsonBannerFooterKeys);
	validateJsonObjectKeys(tsbuild['footer'], 'tsbuild.footer', jsonBannerFooterKeys);
	validateJsonObjectKeys(tsbuild['iife'], 'tsbuild.iife', jsonIifeKeys);
}

/**
 * Resolves configuration by merging options with tsconfig.json.
 * @param api - TypeScript API session used to read and parse the configuration
 * @param directory - Project root directory
 * @param typeScriptOptions - Partial TypeScript options to merge
 * @param options - Command-line options
 * @param options.minify - Minify output
 * @param options.force - Force rebuild
 * @param options.watch - Watch mode
 * @returns Resolved configuration and TypeScript parser results
 */
export function resolveConfiguration(api: API, directory: AbsolutePath, typeScriptOptions: TypeScriptOptions, { minify, force, watch, outputStyle }: CommandLineOptions): TypeScriptConfiguration {
	const configFile = findConfigFile(directory) ?? Paths.join(directory, './tsconfig.json');
	const configResult = api.readConfigFile(configFile) as ReadConfigResult;

	if (configResult.error !== undefined) {
		throw new ConfigurationError(formatDiagnostics([configResult.error], diagnosticsHost));
	}

	validateJsonTsbuildConfiguration(configResult.config.tsbuild);
	const outputStyles = Object.values(BuildOutputStyle);
	const isBuildOutputStyle = (value: unknown): value is BuildOutputStyle => outputStyles.some((style) => style === value);
	if (outputStyle !== undefined && !isBuildOutputStyle(outputStyle)) {
		throw new ConfigurationError(`Invalid value for "--outputStyle": ${String(outputStyle)}. Valid values: ${outputStyles.join(', ')}`);
	}

	for (const outputStyle of [ configResult.config.tsbuild?.outputStyle, typeScriptOptions.tsbuild?.outputStyle ]) {
		if (outputStyle !== undefined && !isBuildOutputStyle(outputStyle)) {
			throw new ConfigurationError(`Invalid value for "tsbuild.outputStyle": ${String(outputStyle)}. Valid values: ${outputStyles.join(', ')}`);
		}
	}

	const bundle = typeScriptOptions.tsbuild?.bundle ?? configResult.config.tsbuild?.bundle ?? true;
	const { lib } = api.parseJsonConfigFileContent({ ...configResult.config, compilerOptions: { ...configResult.config.compilerOptions, ...typeScriptOptions.compilerOptions } }, { configFileName: configFile }).options;
	const platform = typeScriptOptions.tsbuild?.platform ?? configResult.config.tsbuild?.platform ?? (lib?.some(domPredicate) ? Platform.BROWSER : Platform.NODE);
	const noExternal = typeScriptOptions.tsbuild?.noExternal ?? configResult.config.tsbuild?.noExternal ?? [];
	const hasExplicitEntryPoints = typeScriptOptions.tsbuild?.entryPoints !== undefined || configResult.config.tsbuild?.entryPoints !== undefined;

	// When no entry points are explicitly configured, try to infer them from package.json
	let inferredEntryPoints: EntryPoints<RelativePath> | undefined;
	if (!hasExplicitEntryPoints && bundle) {
		const packageJsonPath = Paths.join(directory, 'package.json');
		const packageJsonContent = readOptionalFile(packageJsonPath) as JsonString<PackageJson> | undefined;
		if (packageJsonContent) {
			try {
				const pkgJson = Json.parse<PackageJson>(packageJsonContent);
				const outDir = typeScriptOptions.compilerOptions?.outDir ?? configResult.config.compilerOptions?.outDir ?? defaultOutDirectory;

				inferredEntryPoints = inferEntryPoints(pkgJson, outDir);
				if ((pkgJson.exports !== undefined || pkgJson.bin !== undefined || pkgJson.main !== undefined || pkgJson.module !== undefined) && inferredEntryPoints === undefined) {
					Logger.warn(`Could not infer entry points from package.json exports (output paths do not match outDir "${outDir}"). Add explicit entryPoints to your tsconfig.json tsbuild configuration.`);
				}
			} catch {
				Logger.warn(`Could not parse package.json at "${packageJsonPath}" while inferring entry points. Configure explicit entryPoints in your tsconfig.json tsbuild configuration.`);
			}
		}
	}

	const defaultTsbuildConfig: BuildConfiguration = {
		splitting: bundle,
		minify,
		force,
		bundle,
		sourceMap: typeScriptOptions.compilerOptions?.sourceMap ?? configResult.config.compilerOptions?.sourceMap ?? false,
		noExternal,
		packages: noExternal.length > 0 ? undefined : (platform === Platform.BROWSER ? 'bundle' : 'external'),
		platform,
		dts: { resolve: platform !== Platform.NODE, entryPoints: bundle ? undefined : [] },
		watch: { enabled: watch, recursive: true, emitInitial: false, persistent: true, renameTimeout: 150 },
		entryPoints: inferredEntryPoints ?? (bundle ? { [defaultEntryPoint]: defaultEntryFile } : { src: defaultSourceDirectory })
	};

	const baseConfig = {
		...configResult.config,
		clean: typeScriptOptions.tsbuild?.clean ?? configResult.config.tsbuild?.clean ?? true,
		tsbuild: {
			...defaultTsbuildConfig,
			...configResult.config.tsbuild,
			...typeScriptOptions.tsbuild,
			outputStyle: outputStyle ?? typeScriptOptions.tsbuild?.outputStyle ?? configResult.config.tsbuild?.outputStyle ?? BuildOutputStyle.SUMMARY,
			dts: { ...defaultTsbuildConfig.dts, ...configResult.config.tsbuild?.dts, ...typeScriptOptions.tsbuild?.dts },
			watch: defaultTsbuildConfig.watch
		},
		compilerOptions: {
			...{ outDir: defaultOutDirectory, noEmit: false, sourceMap: false, incremental: true, lib: [] },
			...configResult.config.compilerOptions,
			...typeScriptOptions.compilerOptions,
			// Auto-inject 'node' only on Node platform — browser/neutral builds shouldn't pay the cost of loading @types/node (~3 MB of declarations).
			// Users can still opt in by listing 'node' explicitly in their tsconfig types array.
			types: (() => {
				const typesSet = new Set<string>();

				if (platform === Platform.NODE) { typesSet.add('node') }

				for (const t of configResult.config.compilerOptions?.types ?? []) { typesSet.add(t) }

				for (const t of typeScriptOptions.compilerOptions?.types ?? []) { typesSet.add(t) }

				return Array.from(typesSet);
			})()
		}
	};

	baseConfig.tsbuild.entryPoints = normalizeEntryPoints(baseConfig.tsbuild.entryPoints);

	// Resolve relative to the requested project directory even when the config was found in an ancestor; TypeScript still needs a config file name to accept `incremental`
	const { options, fileNames, errors } = api.parseJsonConfigFileContent(baseConfig, { configFileName: Paths.join(directory, basename(configFile)) });
	const rootDir = options.rootDir ?? commonSourceDirectory(fileNames);

	// Build final configuration with all required fields
	// Note: compilerOptionOverrides must be spread last to ensure they take precedence
	return {
		...baseConfig,
		compilerOptions: {
			...options,
			lib: lib ?? options.lib,
			...(rootDir === undefined ? {} : { rootDir: toRootedDirectoryPath(rootDir, undefined) }),
			...compilerOptionOverrides
		},
		directory,
		configFilePath: configFile,
		rootNames: fileNames,
		configFileParsingDiagnostics: errors,
		buildCache: baseConfig.compilerOptions.incremental ? new IncrementalBuildCache(directory) : undefined
	};
}