import { Paths } from 'src/paths';
import type { Pattern } from 'src/@types';
import type { OnResolveResult, Plugin } from 'esbuild';

type ExternalModulesPluginOptions = { dependencies?: Pattern[],	noExternal?: Pattern[] };

const match = (id: string, patterns: Pattern[]): boolean => {
	return patterns.some((pattern) => pattern instanceof RegExp ? pattern.test(id) : id === pattern || id.startsWith(`${pattern}/`));
};

export const externalModulesPlugin = ({ dependencies = [], noExternal = [] }: ExternalModulesPluginOptions): Plugin => {
	return {
		name: 'esbuild:external-modules',
		/**
		 * Configure the plugin to handle external modules
		 * @param build The esbuild build instance
		 */
		setup(build): void {
			const external = true;
			build.onResolve({ filter: /.*/ }, ({ path }): OnResolveResult | undefined => {
				switch (true) {
					case match(path, noExternal): return;
					case match(path, dependencies): return { external };
					case !Paths.isPath(path): return { path, external };
					default: return;
				}
			});
		}
	};
};