import { Paths } from '../paths';
import { createPatternMatcher } from '../pattern-matcher';
import type { Pattern } from '../@types';
import type { OnResolveResult, Plugin } from 'esbuild';

type ExternalModulesPluginOptions = { dependencies?: Pattern[],	noExternal?: Pattern[] };

export const externalModulesPlugin = ({ dependencies = [], noExternal = [] }: ExternalModulesPluginOptions): Plugin => {
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
			build.onResolve({ filter: /.*/ }, ({ path }): OnResolveResult | undefined => {
				switch (true) {
					case matchNoExternal(path): return;
					case matchDependencies(path): return { external };
					case !Paths.isPath(path): return { path, external };
					default: return;
				}
			});
		}
	};
};