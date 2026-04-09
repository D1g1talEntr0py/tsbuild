import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvePlugins } from 'src/plugins/resolve-plugin';
import type { Plugin } from 'esbuild';

const projectDir = '/test-project';

const validPlugin: Plugin = { name: 'test-plugin', setup: vi.fn() };

const pluginFactory = (options?: Record<string, unknown>): Plugin => ({
	name: 'factory-plugin',
	setup: vi.fn(),
	...options && { options }
});

describe('resolvePlugins', () => {
	beforeEach(() => { vi.resetAllMocks(); vi.restoreAllMocks() });

	describe('pass-through of Plugin objects', () => {
		it('passes through a Plugin object unchanged', async () => {
			const result = await resolvePlugins([ validPlugin ], projectDir);
			expect(result).toEqual([ validPlugin ]);
		});

		it('passes through multiple Plugin objects', async () => {
			const second: Plugin = { name: 'second', setup: vi.fn() };
			const result = await resolvePlugins([ validPlugin, second ], projectDir);
			expect(result).toEqual([ validPlugin, second ]);
		});
	});

	describe('string references', () => {
		it('resolves a bare specifier and calls the factory with undefined', async () => {
			const factory = vi.fn(() => validPlugin);
			vi.doMock('some-esbuild-plugin', () => ({ default: factory }));

			const result = await resolvePlugins([ 'some-esbuild-plugin' ], projectDir);
			expect(factory).toHaveBeenCalledWith(undefined);
			expect(result).toEqual([ validPlugin ]);

			vi.doUnmock('some-esbuild-plugin');
		});

		it('resolves a bare specifier with a direct Plugin export', async () => {
			vi.doMock('direct-plugin', () => ({ default: validPlugin }));

			const result = await resolvePlugins([ 'direct-plugin' ], projectDir);
			expect(result).toEqual([ validPlugin ]);

			vi.doUnmock('direct-plugin');
		});

		it('resolves a relative path against the project directory', async () => {
			const factory = vi.fn(() => validPlugin);
			vi.doMock('/test-project/plugins/my-plugin.js', () => ({ default: factory }));

			const result = await resolvePlugins([ './plugins/my-plugin.js' ], projectDir);
			expect(factory).toHaveBeenCalledWith(undefined);
			expect(result).toEqual([ validPlugin ]);

			vi.doUnmock('/test-project/plugins/my-plugin.js');
		});
	});

	describe('tuple references', () => {
		it('calls factory with provided options', async () => {
			const factory = vi.fn(pluginFactory);
			vi.doMock('tuple-plugin', () => ({ default: factory }));

			const options = { key: 'value', nested: { a: 1 } };
			const result = await resolvePlugins([ [ 'tuple-plugin', options ] ], projectDir);

			expect(factory).toHaveBeenCalledWith(options);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('factory-plugin');

			vi.doUnmock('tuple-plugin');
		});

		it('warns when options are provided to a non-factory Plugin object', async () => {
			vi.doMock('non-factory-with-opts', () => ({ default: validPlugin }));

			const result = await resolvePlugins([ [ 'non-factory-with-opts', { key: 'value' } ] ], projectDir);
			expect(result).toEqual([ validPlugin ]);

			vi.doUnmock('non-factory-with-opts');
		});
	});

	describe('mixed entries', () => {
		it('handles Plugin objects, strings, and tuples together', async () => {
			const stringFactory = vi.fn(() => ({ name: 'from-string', setup: vi.fn() }));
			const tupleFactory = vi.fn(() => ({ name: 'from-tuple', setup: vi.fn() }));
			vi.doMock('string-plugin', () => ({ default: stringFactory }));
			vi.doMock('tuple-plugin-mix', () => ({ default: tupleFactory }));

			const result = await resolvePlugins([
				validPlugin,
				'string-plugin',
				[ 'tuple-plugin-mix', { opt: true } ]
			], projectDir);

			expect(result).toHaveLength(3);
			expect(result[0]).toBe(validPlugin);
			expect(result[1].name).toBe('from-string');
			expect(result[2].name).toBe('from-tuple');
			expect(tupleFactory).toHaveBeenCalledWith({ opt: true });

			vi.doUnmock('string-plugin');
			vi.doUnmock('tuple-plugin-mix');
		});
	});

	describe('error handling', () => {
		it('throws ConfigurationError when module cannot be found', async () => {
			await expect(resolvePlugins([ 'nonexistent-plugin-xyzzy' ], projectDir))
				.rejects.toThrow('Failed to load plugin "nonexistent-plugin-xyzzy"');
		});

		it('throws ConfigurationError when module has no default export', async () => {
			vi.doMock('no-default', () => ({ default: undefined, notDefault: 'something' }));

			await expect(resolvePlugins([ 'no-default' ], projectDir))
				.rejects.toThrow('has no default export');

			vi.doUnmock('no-default');
		});

		it('throws ConfigurationError when factory returns invalid object', async () => {
			vi.doMock('bad-factory', () => ({ default: () => ({ not: 'a-plugin' }) }));

			await expect(resolvePlugins([ 'bad-factory' ], projectDir))
				.rejects.toThrow('factory did not return a valid esbuild Plugin');

			vi.doUnmock('bad-factory');
		});

		it('throws ConfigurationError when default export is neither function nor Plugin', async () => {
			vi.doMock('bad-export', () => ({ default: 'just a string' }));

			await expect(resolvePlugins([ 'bad-export' ], projectDir))
				.rejects.toThrow('not a function or valid esbuild Plugin object');

			vi.doUnmock('bad-export');
		});
	});

	describe('empty input', () => {
		it('returns empty array for empty input', async () => {
			const result = await resolvePlugins([], projectDir);
			expect(result).toEqual([]);
		});
	});
});
