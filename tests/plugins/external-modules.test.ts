import { describe, it, expect, vi, beforeEach } from 'vitest';
import { externalModulesPlugin } from 'src/plugins/external-modules';
import type { OnResolveArgs, OnResolveResult, PluginBuild } from 'esbuild';

describe('externalModulesPlugin', () => {
	let onResolveCallback: (args: OnResolveArgs) => OnResolveResult | undefined;

	const args = (path: string): OnResolveArgs => ({
		path,
		importer: '',
		namespace: 'file',
		resolveDir: '',
		kind: 'import-statement',
		pluginData: undefined,
		with: {}
	});

	const setupPlugin = (options: Parameters<typeof externalModulesPlugin>[0] = {}) => {
		const plugin = externalModulesPlugin(options);
		const build: Partial<PluginBuild> = {
			onResolve: vi.fn((_options, callback) => { onResolveCallback = callback }),
		};
		plugin.setup(build as PluginBuild);
		return { plugin, build: build as PluginBuild };
	};

	beforeEach(() => { vi.resetAllMocks() });

	it('has the correct name', () => {
		expect(externalModulesPlugin({}).name).toBe('esbuild:external-modules');
	});

	it('registers onResolve with filter /.*/  ', () => {
		const { build } = setupPlugin();
		expect(build.onResolve).toHaveBeenCalledWith({ filter: /.*/ }, expect.any(Function));
	});

	describe('default options', () => {
		beforeEach(() => { setupPlugin() });

		const bareSpecifiers: [string][] = [
			['lodash'],
			['react'],
			['@scope/pkg'],
			['node:fs'],
			['esbuild'],
			['@scope/pkg/deep/import'],
		];

		it.each(bareSpecifiers)('marks bare specifier "%s" as external', (path) => {
			const result = onResolveCallback(args(path));
			expect(result).toEqual({ path, external: true });
		});

		const localPaths: [string][] = [
			['./local'],
			['../parent'],
			['/absolute/path'],
			['./foo/bar.js'],
			['C:\\win\\path'],
		];

		it.each(localPaths)('does not mark local path "%s" as external', (path) => {
			expect(onResolveCallback(args(path))).toBeUndefined();
		});
	});

	describe('dependencies option', () => {
		it('marks matching strings as external (no path in result)', () => {
			setupPlugin({ dependencies: ['forced-external'] });
			expect(onResolveCallback(args('forced-external'))).toEqual({ external: true });
		});

		it('matches deep imports via package name extraction', () => {
			setupPlugin({ dependencies: ['forced-external'] });
			expect(onResolveCallback(args('forced-external/deep'))).toEqual({ external: true });
		});

		it('matches regex patterns', () => {
			setupPlugin({ dependencies: [/^@my-scope\//] });
			expect(onResolveCallback(args('@my-scope/pkg'))).toEqual({ external: true });
		});

		it('still marks other bare specifiers as external', () => {
			setupPlugin({ dependencies: ['forced-external'] });
			const result = onResolveCallback(args('another-bare'));
			expect(result).toEqual({ path: 'another-bare', external: true });
		});
	});

	describe('noExternal option', () => {
		it('prevents matching modules from being marked external', () => {
			setupPlugin({ noExternal: ['not-external'] });
			expect(onResolveCallback(args('not-external'))).toBeUndefined();
		});

		it('matches deep imports via package name', () => {
			setupPlugin({ noExternal: ['not-external'] });
			expect(onResolveCallback(args('not-external/deep'))).toBeUndefined();
		});

		it('supports regex patterns', () => {
			setupPlugin({ noExternal: [/^@keep\//] });
			expect(onResolveCallback(args('@keep/pkg'))).toBeUndefined();
		});

		it('takes priority over bare specifier default', () => {
			setupPlugin({ noExternal: ['bare-specifier'] });
			expect(onResolveCallback(args('bare-specifier'))).toBeUndefined();
		});

		it('takes priority over dependencies', () => {
			setupPlugin({ dependencies: ['my-dep'], noExternal: ['my-dep'] });
			expect(onResolveCallback(args('my-dep'))).toBeUndefined();
		});
	});

	describe('packageName extraction', () => {
		it.each([
			['lodash/fp', 'lodash'],
			['@scope/pkg/deep', '@scope/pkg'],
			['react', 'react'],
			['@scope/pkg', '@scope/pkg'],
			['@scope', '@scope'],
		])('dependencies match "%s" via package name "%s"', (id, pkg) => {
			setupPlugin({ dependencies: [pkg] });
			expect(onResolveCallback(args(id))).toEqual({ external: true });
		});
	});
});
