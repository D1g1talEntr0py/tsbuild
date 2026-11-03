import { Paths } from '../paths';
import { Logger } from '../logger';
import { ConfigurationError } from '../errors';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverLocalDependencies } from './plugin-dependencies';
import { nodeModulesPathPattern, typeScriptExtensionExpression } from '../constants';
import type { Plugin } from 'esbuild';
import type { API, CompilerOptions } from 'typescript/sync';
import type { NamespacedUnregister, OnImport } from '@d1g1tal/tsnode/api';
import type { PluginDescriptor, PluginIdentifier, PluginFactory, AbsolutePath, PackageSpecifier, PluginSpecifier } from '../@types';

type PluginScope = {
	handle: NamespacedUnregister | undefined;
	parentURL: string;
	compilerOptions: CompilerOptions;
	api: API;
	dependencies: Set<AbsolutePath>;
};

/** A normalized plugin reference, including its resolved import target and optional local TypeScript path. */
type PluginReference = {
	descriptor: PluginDescriptor;
	resolved: PackageSpecifier | AbsolutePath;
	localTypeScriptPath: AbsolutePath | undefined;
};

/** Per-project options controlling the isolated tsnode scope used to load local TypeScript plugins. */
export type PluginScopeOptions = {
	/** Unique namespace identifying this project's plugin module graph to tsnode's scoped loader hooks */
	namespace: string;
	/** Absolute path to the project's tsconfig.json, used by tsnode to resolve path aliases/compiler options for local TS plugins */
	tsconfigPath: AbsolutePath;
	/** Resolved options used by the dependency-tracking fallback */
	compilerOptions: CompilerOptions;
	/** TypeScript API session used by the dependency-tracking fallback */
	api: API;
};

/** Result of resolving a project's configured plugins into esbuild Plugin objects. */
export interface PluginConfiguration extends Disposable {
	plugins: Plugin[];
	/**
	 * Absolute paths of local TypeScript files loaded through the tsnode plugin scope — the
	 * plugin module itself plus anything it (transitively) imports from the local filesystem.
	 * Empty when none of the configured plugins required TypeScript support.
	 */
	dependencies: ReadonlySet<AbsolutePath>;
}

/**
 * Checks whether a value is an esbuild Plugin object (has `name` string and `setup` function).
 * @param value The value to check
 * @returns True if the value is a Plugin object
 */
function isPlugin(value: unknown): value is Plugin {
	if (typeof value !== 'object' || value === null) { return false }

	return 'name' in value && typeof value.name === 'string' && 'setup' in value && typeof value.setup === 'function';
}

/**
 * Checks whether a value is a function that can be called as a plugin factory.
 * @param value The value to check
 * @returns True if the value is a function
 */
function isFactory(value: unknown): value is PluginFactory {
	return typeof value === 'function';
}

/**
 * Normalizes a plugin reference and caches its import target and TypeScript path, if any.
 * @param reference The raw plugin reference from configuration
 * @param projectDir The project root directory for resolving local paths
 * @returns The normalized plugin reference
 */
function resolvePluginReference(reference: PluginIdentifier, projectDir: AbsolutePath): PluginReference {
	let specifier: PluginSpecifier;
	let resolved: PackageSpecifier | AbsolutePath;
	let localTypeScriptPath: AbsolutePath | undefined;
	const rawSpecifier = typeof reference === 'string' ? reference : reference[0];

	if (Paths.isPath(rawSpecifier)) {
		specifier = rawSpecifier;
		resolved = Paths.absolute(projectDir, specifier);
		localTypeScriptPath = typeScriptExtensionExpression.test(resolved) ? resolved : undefined;
	} else {
		specifier = rawSpecifier as PackageSpecifier;
		resolved = specifier;
	}

	return { descriptor: typeof reference === 'string' ? specifier : [ specifier, reference[1] ], resolved, localTypeScriptPath };
}

/**
 * Resolves a single plugin reference (string or tuple) to an esbuild Plugin.
 * @param entry The plugin reference and its pre-resolved path classification
 * @param scope The tsnode scope handle (when created) and stable parent URL for scoped imports
 * @returns The resolved esbuild Plugin
 */
async function resolveReference({ descriptor, resolved, localTypeScriptPath }: PluginReference, { handle, parentURL, compilerOptions, api, dependencies }: PluginScope) {
	const [ specifier, options ] = typeof descriptor === 'string' ? [ descriptor, undefined ] : descriptor;

	let module: Record<string, unknown>;

	try {
		module = handle && localTypeScriptPath ? await handle.import(localTypeScriptPath, parentURL) : await import(resolved) as Record<string, unknown>;
	} catch (error) {
		throw new ConfigurationError(`Failed to load plugin "${specifier}": ${Error.isError(error) ? error.message : String(error)}`);
	}

	if (localTypeScriptPath !== undefined) {
		for (const dependency of discoverLocalDependencies(api, localTypeScriptPath, compilerOptions)) {
			dependencies.add(dependency);
		}
	}

	const defaultExport = module['default'];
	if (defaultExport === undefined) {
		throw new ConfigurationError(`Plugin "${specifier}" has no default export. The module must export a plugin factory function or Plugin object as its default export.`);
	}

	if (isFactory(defaultExport)) {
		const result = defaultExport(options);
		if (!isPlugin(result)) {
			throw new ConfigurationError(`Plugin "${specifier}" factory did not return a valid esbuild Plugin (expected { name: string, setup: function }).`);
		}

		return result;
	}

	if (isPlugin(defaultExport)) {
		if (options !== undefined) { Logger.warn(`Plugin "${specifier}" is a Plugin object, not a factory function. The provided options will be ignored.`) }

		return defaultExport;
	}

	throw new ConfigurationError(`Plugin "${specifier}" default export is not a function or valid esbuild Plugin object.`);
}

/**
 * Resolves an array of plugin entries (Plugin objects or PluginReferences) into esbuild Plugin objects.
 * Existing Plugin objects are passed through. String/tuple references are dynamically imported and resolved.
 *
 * Local TypeScript plugin references (relative/absolute paths ending in a TypeScript extension) are loaded
 * through a uniquely namespaced tsnode scope, configured with the project's own tsconfig.json, so path aliases,
 * decorators, and other non-erasable syntax work the same as in the rest of the project. JS files and bare
 * package specifiers continue to load via native `import()`, unchanged from prior behavior.
 *
 * The returned configuration must be disposed by the caller only once the build (including plugin `onEnd` callbacks)
 * has finished, since those callbacks may dynamically import further local TypeScript modules.
 * @param plugins The array of plugins and/or plugin references
 * @param projectDir The project root directory for resolving relative paths
 * @param scopeOptions Namespace/tsconfig path/compiler options used to isolate and resolve this project's TypeScript plugin scope
 * @returns Resolved esbuild Plugin objects, the discovered local TypeScript dependency graph, and a disposable scope
 */
export async function resolvePlugins(plugins: Array<Plugin | PluginIdentifier>, projectDir: AbsolutePath, { namespace, tsconfigPath: tsconfig, compilerOptions, api }: PluginScopeOptions): Promise<PluginConfiguration> {
	let handle: NamespacedUnregister | undefined;
	const dependencies = new Set<AbsolutePath>();
	const resolved: Plugin[] = [];
	const parentURL = pathToFileURL(tsconfig).href;
	/**
	 * Records local files loaded while the scoped plugin graph is active.
	 * @param url Loaded module URL
	 */
	const onImport: OnImport = (url) => {
		if (!url.startsWith('file:')) { return }

		const path = fileURLToPath(url);

		if (!nodeModulesPathPattern.test(path)) { dependencies.add(Paths.absolute(path)) }
	};

	try {
		for (const entry of plugins) {
			if (isPlugin(entry)) {
				resolved.push(entry);
				continue;
			}

			const reference = resolvePluginReference(entry, projectDir);

			if (handle === undefined && reference.localTypeScriptPath !== undefined) {
				handle = (await import('@d1g1tal/tsnode/api')).register({ namespace, tsconfig, onImport });
			}

			resolved.push(await resolveReference(reference, { handle, parentURL, compilerOptions, api, dependencies }));
		}

		return { plugins: resolved, dependencies, [Symbol.dispose]: () => handle?.unregister() };
	} catch (error) {
		handle?.unregister();
		throw error;
	}
}
