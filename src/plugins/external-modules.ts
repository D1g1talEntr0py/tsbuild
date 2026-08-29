import { Paths } from '../paths';
import { createPatternMatcher } from '../pattern-matcher';
import type { Pattern } from '../@types';
import type { OnResolveResult, Plugin } from 'esbuild';
import type { MapLike } from 'typescript';

type ExternalModulesPluginOptions = { dependencies?: Pattern[], noExternal?: Pattern[], paths?: MapLike<string[]> };

/**
 * Converts a tsconfig `paths` key to an exact string or wildcard matcher.
 * @param key The tsconfig paths key.
 * @returns An exact string or anchored wildcard pattern.
 */
const createPathAliasPattern = (key: string): Pattern => {
	const wildcardIndex = key.indexOf('*');

	if (wildcardIndex === -1) { return key }

	// Escape the suffix after the wildcard, if any, and anchor it to the end of the string.
	return new RegExp(`^${RegExp.escape(key.slice(0, wildcardIndex))}.*${RegExp.escape(key.slice(wildcardIndex + 1))}$`);
};

export const externalModulesPlugin = ({ dependencies = [], noExternal = [], paths = {} }: ExternalModulesPluginOptions): Plugin => {
	return {
		name: 'esbuild:external-modules',
		/**
		 * Configure the plugin to handle external modules
		 * @param build The esbuild build instance
		 */
		setup(build): void {
			const external = true;
			const matchNoExternal = createPatternMatcher(noExternal, { allowSubpaths: true });
			const matchDependencies = createPatternMatcher(dependencies, { allowSubpaths: true });
			const matchPathAlias = createPatternMatcher(Object.keys(paths).map(createPathAliasPattern));
			build.onResolve({ filter: /.*/ }, ({ path }): OnResolveResult | undefined => {
				switch (true) {
					case matchNoExternal(path): return;
					case matchPathAlias(path): return;
					case matchDependencies(path): return { external };
					case !Paths.isPath(path): return { path, external };
					default: return;
				}
			});
		}
	};
};