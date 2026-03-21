import { Paths } from 'src/paths';
import type { Pattern } from 'src/@types';
import type { OnResolveResult, Plugin } from 'esbuild';

type ExternalModulesPluginOptions = { dependencies?: Pattern[],	noExternal?: Pattern[] };

/**
 * Extracts the npm package name from a module specifier.
 * For unscoped packages (`lodash/fp` → `lodash`), returns everything before the first `/`.
 * For scoped packages (`@scope/pkg/deep` → `@scope/pkg`), returns everything before the second `/`.
 * @param id The module specifier to extract the package name from
 * @returns The package name portion of the module specifier
 * @example
 * packageName('lodash/fp') // 'lodash'
 * packageName('@scope/pkg/deep') // '@scope/pkg'
 * packageName('react') // 'react'
 * packageName('@scope/pkg') // '@scope/pkg'
 * packageName('./local') // './local' (not a package)
 */
function packageName(id: string): string {
	if (id.charCodeAt(0) === 64) { // '@' — scoped package
		const first = id.indexOf('/');
		if (first === -1) { return id }
		const second = id.indexOf('/', first + 1);
		return second === -1 ? id : id.slice(0, second);
	}
	const slash = id.indexOf('/');
	return slash === -1 ? id : id.slice(0, slash);
}

/**
 * Builds an O(1) matcher from a mixed Pattern array by splitting into a Set<string> for
 * exact/sub-path checks and a RegExp[] for regex tests. Called once per plugin setup.
 * @param patterns The array of string and RegExp patterns to match against module specifiers
 * @returns A function that takes a module specifier and returns true if it matches any of the patterns
 */
function buildMatcher(patterns: Pattern[]): (id: string) => boolean {
	const exact = new Set<string>();
	const regexps: RegExp[] = [];
	for (const p of patterns) {
		if (typeof p === 'string') { exact.add(p) } else { regexps.push(p) }
	}
	if (exact.size === 0 && regexps.length === 0) { return () => false }
	return (id: string): boolean => {
		if (exact.has(id)) { return true }
		const pkg = packageName(id);
		if (pkg !== id && exact.has(pkg)) { return true }
		return regexps.length > 0 && regexps.some((r) => r.test(id));
	};
}

export const externalModulesPlugin = ({ dependencies = [], noExternal = [] }: ExternalModulesPluginOptions): Plugin => {
	return {
		name: 'esbuild:external-modules',
		/**
		 * Configure the plugin to handle external modules
		 * @param build The esbuild build instance
		 */
		setup(build): void {
			const external = true;
			const matchNoExternal = buildMatcher(noExternal);
			const matchDependencies = buildMatcher(dependencies);
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