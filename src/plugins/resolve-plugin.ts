import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Paths } from '../paths';
import { Logger } from '../logger';
import { ConfigurationError } from '../errors';
import { nodeModulesPathPattern } from '../constants';
import { discoverLocalDependencies } from './plugin-dependencies';
import type { Plugin } from 'esbuild';
import type { NamespacedUnregister } from '@d1g1tal/tsnode/api';
import type { CompilerOptions } from 'typescript';
import type { PluginReference, PluginFactory, AbsolutePath } from '../@types';

/** Per-project options controlling the isolated tsnode scope used to load local TypeScript plugins. */
export type PluginScopeOptions = {
	/** Unique namespace identifying this project's plugin module graph to tsnode's scoped loader hooks */
	namespace: string;
	/** Absolute path to the project's tsconfig.json, used by tsnode to resolve path aliases/compiler options for local TS plugins */
	tsconfigPath: AbsolutePath;
	/** Resolved options used by the dependency-tracking fallback */
	compilerOptions: CompilerOptions;
};

/** Result of resolving a project's configured plugins into esbuild Plugin objects. */
export type PluginResolution = {
	plugins: Plugin[];
	/**
	 * Absolute paths of local TypeScript files loaded through the tsnode plugin scope — the
	 * plugin module itself plus anything it (transitively) imports from the local filesystem.
	 * Empty when none of the configured plugins required TypeScript support.
	 */
	dependencies: ReadonlySet<AbsolutePath>;
	/**
	 * Unregisters the per-project tsnode scope, if one was created for this resolution.
	 * Always safe to call — a no-op when no local TypeScript plugin was loaded. Must be called
	 * only after all plugin `setup`/`onEnd` callbacks that may run during the build have
	 * finished, since those callbacks may dynamically import further TypeScript modules.
	 */
	dispose: () => void;
};

/** Matches local file extensions that require TypeScript's on-demand loader (tsnode) rather than native `import()`. */
const typeScriptExtensionPattern = /\.tsx?$/;

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
 * Checks whether a plugin specifier is a local TypeScript source file that needs tsnode's
 * on-demand TypeScript support. Bare/package specifiers are intentionally excluded — published
 * plugin packages are expected to ship pre-compiled JavaScript, and routing them through the
 * project's tsconfig-scoped loader could leak this project's path aliases/compiler options into
 * an unrelated package's module graph.
 * @param specifier The original plugin specifier as written in configuration
 * @param resolvedPath The specifier resolved against the project directory
 * @returns True when the plugin should be loaded through the tsnode scope
 */
function isLocalTypeScriptPlugin(specifier: string, resolvedPath: string): boolean {
	return Paths.isPath(specifier) && typeScriptExtensionPattern.test(resolvedPath);
}

/**
 * Determines whether any configured plugin reference requires the tsnode plugin scope.
 * @param plugins The array of plugins and/or plugin references
 * @param projectDir The project root directory for resolving relative paths
 * @returns True when at least one entry is a local TypeScript plugin reference
 */
function requiresPluginScope(plugins: (Plugin | PluginReference)[], projectDir: string): boolean {
	for (const entry of plugins) {
		if (isPlugin(entry)) { continue }

		const specifier = typeof entry === 'string' ? entry : entry[0];
		const resolvedPath = Paths.isPath(specifier) ? resolve(projectDir, specifier) : specifier;

		if (isLocalTypeScriptPlugin(specifier, resolvedPath)) { return true }
	}

	return false;
}

/**
 * Resolves a single plugin reference (string or tuple) to an esbuild Plugin.
 * @param reference The plugin reference to resolve
 * @param projectDir The project root directory for resolving relative paths
 * @param scope The tsnode scope handle (when created) and stable parent URL for scoped imports
 * @returns The resolved esbuild Plugin
 */
async function resolveReference(reference: PluginReference, projectDir: string, scope: { handle: NamespacedUnregister | undefined; parentURL: string; compilerOptions: CompilerOptions; dependencies: Set<AbsolutePath> }): Promise<Plugin> {
	const [ specifier, options ] = typeof reference === 'string' ? [ reference, undefined ] : reference;
	const resolved = Paths.isPath(specifier) ? resolve(projectDir, specifier) : specifier;
	const isLocalTypeScript = isLocalTypeScriptPlugin(specifier, resolved);

	let module: Record<string, unknown>;
	try {
		module = (scope.handle && isLocalTypeScript) ? await scope.handle.import(resolved, scope.parentURL) as Record<string, unknown> : await import(resolved) as Record<string, unknown>;
	} catch (error) {
		throw new ConfigurationError(`Failed to load plugin "${specifier}": ${error instanceof Error ? error.message : String(error)}`);
	}

	if (isLocalTypeScript) {
		for (const dependency of discoverLocalDependencies(resolved as AbsolutePath, scope.compilerOptions)) {
			scope.dependencies.add(dependency);
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
 * The returned `dispose()` must be called by the caller only once the build (including plugin `onEnd` callbacks)
 * has finished, since those callbacks may dynamically import further local TypeScript modules.
 * @param plugins The array of plugins and/or plugin references
 * @param projectDir The project root directory for resolving relative paths
 * @param scopeOptions Namespace/tsconfig path/compiler options used to isolate and resolve this project's TypeScript plugin scope
 * @returns Resolved esbuild Plugin objects, the discovered local TypeScript dependency graph, and a dispose callback
 */
export async function resolvePlugins(plugins: (Plugin | PluginReference)[], projectDir: string, scopeOptions: PluginScopeOptions): Promise<PluginResolution> {
	const dependencies = new Set<AbsolutePath>();

	let handle: NamespacedUnregister | undefined;
	if (requiresPluginScope(plugins, projectDir)) {
		handle = (await import('@d1g1tal/tsnode/api')).register({
			namespace: scopeOptions.namespace,
			tsconfig: scopeOptions.tsconfigPath,
			/**
			 * Records local files loaded while the scoped plugin graph is active.
			 * @param url Loaded module URL
			 */
			onImport(url) {
				if (!url.startsWith('file:')) { return }

				const path = fileURLToPath(url);
				if (!nodeModulesPathPattern.test(path)) { dependencies.add(Paths.absolute(path)) }
			}
		});
	}

	const scope = { handle, parentURL: pathToFileURL(scopeOptions.tsconfigPath).href, compilerOptions: scopeOptions.compilerOptions, dependencies };

	try {
		const resolved: Plugin[] = [];
		for (const entry of plugins) {
			resolved.push(isPlugin(entry) ? entry : await resolveReference(entry, projectDir, scope));
		}

		return { plugins: resolved, dependencies, dispose: () => handle?.unregister() };
	} catch (error) {
		// Loading failed before the caller ever receives a dispose handle — unregister here so the
		// scope never leaks past this function on any failure path.
		handle?.unregister();
		throw error;
	}
}
