import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { externalModulesPlugin } from '../../src/plugins/external-modules';
import type { OnResolveArgs, OnResolveResult, PluginBuild } from 'esbuild';
import { TestHelper } from '../scripts/test-helper';

describe('externalModulesPlugin', () => {
	let mockBuild: PluginBuild;
	let onResolveCallback: (args: OnResolveArgs) => OnResolveResult | undefined;

	const createOnResolveArgs = (path: string): OnResolveArgs => ({
		path,
		importer: '',
		namespace: 'file',
		resolveDir: '',
		kind: 'import-statement'
	});

	const setupPlugin = (options: Parameters<typeof externalModulesPlugin>[0] = {}) => {
		const plugin = externalModulesPlugin(options);
		const build: Partial<PluginBuild> = {
			onResolve: vi.fn((options, callback) => {
				expect(options.filter).toEqual(/.*/);
				onResolveCallback = callback;
			}),
		};
		mockBuild = build as PluginBuild;
		plugin.setup(mockBuild);
	};

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		vi.resetAllMocks();
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	it('should have the correct name', () => {
		const plugin = externalModulesPlugin({});
		expect(plugin.name).toBe('esbuild:external-modules');
	});

	it('should register onResolve callback with the correct filter', () => {
		setupPlugin();
		expect(mockBuild.onResolve).toHaveBeenCalledWith({ filter: /.*/ }, expect.any(Function));
	});

	describe('onResolve callback logic', () => {
		describe('with default options', () => {
			beforeEach(() => {
				setupPlugin();
			});

			it('should mark a bare module specifier as external', () => {
				const result = onResolveCallback(createOnResolveArgs('some-external-module'));
				expect(result).toEqual({ path: 'some-external-module', external: true });
			});

			it('should mark a scoped bare module specifier as external', () => {
				const result = onResolveCallback(createOnResolveArgs('@scope/pkg'));
				expect(result).toEqual({ path: '@scope/pkg', external: true });
			});

			it('should not mark relative paths as external', () => {
				expect(onResolveCallback(createOnResolveArgs('./local'))).toBeUndefined();
				expect(onResolveCallback(createOnResolveArgs('../local'))).toBeUndefined();
			});

			it('should not mark absolute paths as external', () => {
				expect(onResolveCallback(createOnResolveArgs('/abs/path'))).toBeUndefined();
				expect(onResolveCallback(createOnResolveArgs('C:\\win\\path'))).toBeUndefined();
			});
		});

		describe('with "dependencies" option', () => {
			it('should mark modules matching dependencies as external', () => {
				setupPlugin({ dependencies: ['forced-external', /^@my-scope\//] });

				let result = onResolveCallback(createOnResolveArgs('forced-external'));
				expect(result).toEqual({ external: true });

				result = onResolveCallback(createOnResolveArgs('forced-external/deep'));
				expect(result).toEqual({ external: true });

				result = onResolveCallback(createOnResolveArgs('@my-scope/pkg'));
				expect(result).toEqual({ external: true });
			});

			it('should still mark other bare specifiers as external', () => {
				setupPlugin({ dependencies: ['forced-external'] });
				const result = onResolveCallback(createOnResolveArgs('another-bare-specifier'));
				expect(result).toEqual({ path: 'another-bare-specifier', external: true });
			});
		});

		describe('with "noExternal" option', () => {
			it('should not mark modules matching noExternal as external', () => {
				setupPlugin({ noExternal: ['not-external', /^@not-external\//] });

				let result = onResolveCallback(createOnResolveArgs('not-external'));
				expect(result).toBeUndefined();

				result = onResolveCallback(createOnResolveArgs('not-external/deep'));
				expect(result).toBeUndefined();

				result = onResolveCallback(createOnResolveArgs('@not-external/pkg'));
				expect(result).toBeUndefined();
			});

			it('should prioritize noExternal over other rules', () => {
				// 'bare-specifier' would normally be external
				setupPlugin({ noExternal: ['bare-specifier'] });
				const result = onResolveCallback(createOnResolveArgs('bare-specifier'));
				expect(result).toBeUndefined();
			});

			it('should prioritize noExternal over dependencies', () => {
				setupPlugin({ dependencies: ['my-dep'], noExternal: ['my-dep'] });
				const result = onResolveCallback(createOnResolveArgs('my-dep'));
				expect(result).toBeUndefined();
			});
		});
	});
});
