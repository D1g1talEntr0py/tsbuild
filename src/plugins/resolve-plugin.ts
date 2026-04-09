import { resolve } from 'node:path';
import { Paths } from 'src/paths';
import { Logger } from 'src/logger';
import { ConfigurationError } from 'src/errors';
import type { Plugin } from 'esbuild';
import type { PluginReference } from 'src/@types';

/**
 * Checks whether a value is an esbuild Plugin object (has `name` string and `setup` function).
 * @param value The value to check
 * @returns True if the value is a Plugin object
 */
function isPlugin(value: unknown): value is Plugin {
	if (typeof value !== 'object' || value === null) { return false }
	return 'name' in value && typeof value.name === 'string' && 'setup' in value && typeof value.setup === 'function';
}

type PluginFactory = (options: Record<string, unknown> | undefined) => unknown;

/**
 * Checks whether a value is a function that can be called as a plugin factory.
 * @param value The value to check
 * @returns True if the value is a function
 */
function isFactory(value: unknown): value is PluginFactory {
	return typeof value === 'function';
}

/**
 * Resolves a single plugin reference (string or tuple) to an esbuild Plugin.
 * @param reference The plugin reference to resolve
 * @param projectDir The project root directory for resolving relative paths
 * @returns The resolved esbuild Plugin
 */
async function resolveReference(reference: PluginReference, projectDir: string): Promise<Plugin> {
	const [ specifier, options ] = typeof reference === 'string' ? [ reference, undefined ] : reference;
	const resolved = Paths.isPath(specifier) ? resolve(projectDir, specifier) : specifier;

	let module: Record<string, unknown>;
	try {
		module = await import(resolved) as Record<string, unknown>;
	} catch (error) {
		throw new ConfigurationError(`Failed to load plugin "${specifier}": ${error instanceof Error ? error.message : String(error)}`);
	}

	const defaultExport = module.default;
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
 * @param plugins The array of plugins and/or plugin references
 * @param projectDir The project root directory for resolving relative paths
 * @returns An array of resolved esbuild Plugin objects
 */
export async function resolvePlugins(plugins: (Plugin | PluginReference)[], projectDir: string): Promise<Plugin[]> {
	const resolved: Plugin[] = [];
	for (const entry of plugins) {
		if (isPlugin(entry)) {
			resolved.push(entry);
		} else {
			resolved.push(await resolveReference(entry, projectDir));
		}
	}
	return resolved;
}
