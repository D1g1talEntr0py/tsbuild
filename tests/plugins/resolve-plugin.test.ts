import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePlugins } from 'src/plugins/resolve-plugin';
import type { Plugin } from 'esbuild';
import type { CompilerOptions } from 'typescript';
import type { AbsolutePath } from 'src/@types';

const projectDir = '/test-project';
const scopeOptions = { namespace: 'test-resolve-plugin', tsconfigPath: '/test-project/tsconfig.json' as AbsolutePath, compilerOptions: {} as CompilerOptions };

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
			const result = await resolvePlugins([ validPlugin ], projectDir, scopeOptions);
			expect(result.plugins).toEqual([ validPlugin ]);
		});

		it('passes through multiple Plugin objects', async () => {
			const second: Plugin = { name: 'second', setup: vi.fn() };
			const result = await resolvePlugins([ validPlugin, second ], projectDir, scopeOptions);
			expect(result.plugins).toEqual([ validPlugin, second ]);
		});
	});

	describe('string references', () => {
		it('resolves a bare specifier and calls the factory with undefined', async () => {
			const factory = vi.fn(() => validPlugin);
			vi.doMock('some-esbuild-plugin', () => ({ default: factory }));

			const result = await resolvePlugins([ 'some-esbuild-plugin' ], projectDir, scopeOptions);
			expect(factory).toHaveBeenCalledWith(undefined);
			expect(result.plugins).toEqual([ validPlugin ]);

			vi.doUnmock('some-esbuild-plugin');
		});

		it('resolves a bare specifier with a direct Plugin export', async () => {
			vi.doMock('direct-plugin', () => ({ default: validPlugin }));

			const result = await resolvePlugins([ 'direct-plugin' ], projectDir, scopeOptions);
			expect(result.plugins).toEqual([ validPlugin ]);

			vi.doUnmock('direct-plugin');
		});

		it('resolves a relative path against the project directory', async () => {
			const factory = vi.fn(() => validPlugin);
			vi.doMock('/test-project/plugins/my-plugin.js', () => ({ default: factory }));

			const result = await resolvePlugins([ './plugins/my-plugin.js' ], projectDir, scopeOptions);
			expect(factory).toHaveBeenCalledWith(undefined);
			expect(result.plugins).toEqual([ validPlugin ]);

			vi.doUnmock('/test-project/plugins/my-plugin.js');
		});
	});

	describe('tuple references', () => {
		it('calls factory with provided options', async () => {
			const factory = vi.fn(pluginFactory);
			vi.doMock('tuple-plugin', () => ({ default: factory }));

			const options = { key: 'value', nested: { a: 1 } };
			const result = await resolvePlugins([ [ 'tuple-plugin', options ] ], projectDir, scopeOptions);

			expect(factory).toHaveBeenCalledWith(options);
			expect(result.plugins).toHaveLength(1);
			expect(result.plugins[0]?.name).toBe('factory-plugin');

			vi.doUnmock('tuple-plugin');
		});

		it('warns when options are provided to a non-factory Plugin object', async () => {
			vi.doMock('non-factory-with-opts', () => ({ default: validPlugin }));

			const result = await resolvePlugins([ [ 'non-factory-with-opts', { key: 'value' } ] ], projectDir, scopeOptions);
			expect(result.plugins).toEqual([ validPlugin ]);

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
			], projectDir, scopeOptions);

			expect(result.plugins).toHaveLength(3);
			expect(result.plugins[0]).toBe(validPlugin);
			expect(result.plugins[1]?.name).toBe('from-string');
			expect(result.plugins[2]?.name).toBe('from-tuple');
			expect(tupleFactory).toHaveBeenCalledWith({ opt: true });

			vi.doUnmock('string-plugin');
			vi.doUnmock('tuple-plugin-mix');
		});
	});

	describe('error handling', () => {
		it('throws ConfigurationError when module cannot be found', async () => {
			await expect(resolvePlugins([ 'nonexistent-plugin-xyzzy' ], projectDir, scopeOptions))
				.rejects.toThrow('Failed to load plugin "nonexistent-plugin-xyzzy"');
		});

		it('throws ConfigurationError when module has no default export', async () => {
			vi.doMock('no-default', () => ({ default: undefined, notDefault: 'something' }));

			await expect(resolvePlugins([ 'no-default' ], projectDir, scopeOptions))
				.rejects.toThrow('has no default export');

			vi.doUnmock('no-default');
		});

		it('throws ConfigurationError when factory returns invalid object', async () => {
			vi.doMock('bad-factory', () => ({ default: () => ({ not: 'a-plugin' }) }));

			await expect(resolvePlugins([ 'bad-factory' ], projectDir, scopeOptions))
				.rejects.toThrow('factory did not return a valid esbuild Plugin');

			vi.doUnmock('bad-factory');
		});

		it('throws ConfigurationError when default export is neither function nor Plugin', async () => {
			vi.doMock('bad-export', () => ({ default: 'just a string' }));

			await expect(resolvePlugins([ 'bad-export' ], projectDir, scopeOptions))
				.rejects.toThrow('not a function or valid esbuild Plugin object');

			vi.doUnmock('bad-export');
		});
	});

	describe('empty input', () => {
		it('returns empty array for empty input', async () => {
			const result = await resolvePlugins([], projectDir, scopeOptions);
			expect(result.plugins).toEqual([]);
		});
	});

	describe('tsnode plugin scope', () => {
		it('does not create a scope (or track dependencies) when no local TypeScript plugin is configured', async () => {
			const factory = vi.fn(() => validPlugin);
			vi.doMock('plain-js-plugin', () => ({ default: factory }));

			const result = await resolvePlugins([ 'plain-js-plugin' ], projectDir, scopeOptions);

			expect(result.dependencies.size).toBe(0);
			expect(() => result.dispose()).not.toThrow();

			vi.doUnmock('plain-js-plugin');
		});

		describe('with a real local TypeScript plugin', () => {
			let dir: string;
			let compilerOptions: CompilerOptions;

			beforeEach(async () => {
				dir = await mkdtemp(join(tmpdir(), 'tsbuild-resolve-plugin-'));
				await mkdir(join(dir, 'lib'), { recursive: true });
				compilerOptions = { baseUrl: dir, paths: { '@lib/*': [ './lib/*' ] } };

				await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({
					compilerOptions: { baseUrl: '.', paths: { '@lib/*': [ './lib/*' ] } }
				}));
				await writeFile(join(dir, 'lib', 'message.ts'), "export const MESSAGE = 'hello-from-alias';\n");
				await writeFile(join(dir, 'util.ts'), "export const suffix = '-util';\n");
				await writeFile(join(dir, 'plugin.ts'), [
					'import type { Plugin } from \'esbuild\';',
					'import { MESSAGE } from \'@lib/message\';',
					'import { suffix } from \'./util\';',
					'',
					'// Enum is non-erasable TypeScript syntax — native type stripping can\'t run this,',
					'// so this fixture demonstrates real value over erasable-syntax-only execution.',
					'enum Mode { Default = \'default\' }',
					'',
					'export default function (): Plugin {',
					'  return { name: `${MESSAGE}${suffix}-${Mode.Default}`, setup() {} };',
					'}',
					''
				].join('\n'));
				await writeFile(join(dir, 'js-plugin.js'), 'export default function () { return { name: \'js-plugin\', setup() {} }; }\n');
			});

			afterEach(async () => {
				await rm(dir, { recursive: true, force: true });
			});

			it('loads a local plugin using an enum and a tsconfig path-alias import', async () => {
				const result = await resolvePlugins([ './plugin.ts' ], dir, { namespace: 'resolve-plugin-ts-scope', tsconfigPath: join(dir, 'tsconfig.json') as AbsolutePath, compilerOptions });

				expect(result.plugins).toHaveLength(1);
				expect(result.plugins[0]?.name).toBe('hello-from-alias-util-default');

				expect(() => result.dispose()).not.toThrow();
			});

			it('tracks the plugin and its local module graph as dependencies, excluding node_modules', async () => {
				const result = await resolvePlugins([ './plugin.ts' ], dir, { namespace: 'resolve-plugin-ts-deps', tsconfigPath: join(dir, 'tsconfig.json') as AbsolutePath, compilerOptions });
				const dependencyPaths = [ ...result.dependencies ];

				expect(dependencyPaths.some((path) => path.endsWith('plugin.ts'))).toBe(true);
				expect(dependencyPaths.some((path) => path.endsWith(join('util.ts')))).toBe(true);
				expect(dependencyPaths.some((path) => path.endsWith(join('lib', 'message.ts')))).toBe(true);
				expect(dependencyPaths.every((path) => !path.includes('node_modules'))).toBe(true);

				result.dispose();
			});

			it('does not route a local JS plugin through the scope even when a TS plugin is also configured', async () => {
				const result = await resolvePlugins([ './plugin.ts', './js-plugin.js' ], dir, { namespace: 'resolve-plugin-mixed-scope', tsconfigPath: join(dir, 'tsconfig.json') as AbsolutePath, compilerOptions });

				expect(result.plugins).toHaveLength(2);
				expect(result.plugins[1]?.name).toBe('js-plugin');
				expect([ ...result.dependencies ].some((path) => path.endsWith('js-plugin.js'))).toBe(false);

				result.dispose();
			});

			it('unregisters the scope on a failure path (invalid plugin export) without leaking it', async () => {
				await writeFile(join(dir, 'bad-plugin.ts'), 'enum Mode { Default }\nexport default \'not-a-plugin\';\n');

				await expect(resolvePlugins([ './bad-plugin.ts' ], dir, { namespace: 'resolve-plugin-ts-failure', tsconfigPath: join(dir, 'tsconfig.json') as AbsolutePath, compilerOptions }))
					.rejects.toThrow('not a function or valid esbuild Plugin object');

				// A second, independent resolution using the same tsconfig succeeds — proving the
				// failed resolution's scope was fully unregistered rather than left dangling.
				const result = await resolvePlugins([ './plugin.ts' ], dir, { namespace: 'resolve-plugin-ts-failure-recovery', tsconfigPath: join(dir, 'tsconfig.json') as AbsolutePath, compilerOptions });
				expect(result.plugins).toHaveLength(1);
				result.dispose();
			});
		});
	});
});
