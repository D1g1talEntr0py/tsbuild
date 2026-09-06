import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as esbuild from 'esbuild';
import { build, context, formatMessages } from 'esbuild';
import { vol } from 'memfs';
import { JsxEmit } from 'typescript';
import { EsbuildRunner } from '../../src/project/esbuild-runner';
import { Paths } from '../../src/paths';
import { Files } from '../../src/files';
import { Logger } from '../../src/logger';
import { BuildError, BundleError, ConfigurationError } from '../../src/errors';
import { resolvePlugins } from '../../src/plugins/resolve-plugin';
import type { AbsolutePath } from '../../src/@types';
import type { BuildContext, BuildOptions, BuildResult, Message, PluginBuild } from 'esbuild';
import type { CompilerOptions } from 'typescript';

vi.mock('esbuild', () => ({ build: vi.fn(), context: vi.fn(), formatMessages: vi.fn() }));
vi.mock('../../src/plugins/resolve-plugin', () => ({ resolvePlugins: vi.fn() }));
vi.mock('node:fs', async () => (await import('memfs')).fs);
vi.mock('node:fs/promises', async () => (await import('memfs')).fs.promises);

const directory = Paths.absolute('/project');
const entryPoints = { index: Paths.absolute(directory, 'src/index.ts') };
const result: BuildResult = { errors: [], warnings: [], metafile: { inputs: {}, outputs: {} } };
const rebuild = vi.fn<BuildContext['rebuild']>();
const dispose = vi.fn<BuildContext['dispose']>();
const buildContext: BuildContext = { rebuild, dispose, watch: vi.fn(), serve: vi.fn(), cancel: vi.fn() };

function createRunner(overrides: Partial<ConstructorParameters<typeof EsbuildRunner>[0]['buildOptions']> = {}, compilerOptions: CompilerOptions = {}): EsbuildRunner {
	return new EsbuildRunner({
		directory,
		configFilePath: Paths.absolute(directory, 'tsconfig.json'),
		compilerOptions,
		buildOptions: {
			watch: { enabled: true, recursive: true, persistent: true, ignoreInitial: true },
			noExternal: [], bundle: true, sourceMap: false, target: 'ESNext', outDir: Paths.absolute(directory, 'dist'), splitting: true, minify: false,
			...overrides
		}
	});
}

async function setupPlugins(options: BuildOptions) {
	const onEnd = vi.fn<PluginBuild['onEnd']>();
	const onResolve = vi.fn<PluginBuild['onResolve']>();
	const pluginBuild: PluginBuild = {
		initialOptions: options, onEnd, onResolve, esbuild,
		onStart: vi.fn(), onLoad: vi.fn(), onDispose: vi.fn(), resolve: vi.fn()
	};
	for (const plugin of options.plugins ?? []) { await plugin.setup(pluginBuild) }
	return {
		onResolve,
		async finish(buildResult: BuildResult) {
			for (const [ callback ] of onEnd.mock.calls) { await callback(buildResult) }
			return buildResult;
		}
	};
}

function outputResult(name: string, text: string): BuildResult {
	const path = Paths.absolute(directory, `dist/${name}`);
	return {
		errors: [], warnings: [],
		outputFiles: [{ path, text, contents: Buffer.from(text), hash: name }],
		metafile: { inputs: {}, outputs: { [path]: { entryPoint: 'src/index.ts', inputs: {}, imports: [], exports: [], bytes: Buffer.byteLength(text) } } }
	};
}

function message(text: string): Message {
	return { id: '', pluginName: '', text, location: null, notes: [], detail: undefined };
}

beforeEach(() => {
	vol.reset();
	vol.mkdirSync(directory, { recursive: true });
	vi.mocked(context).mockResolvedValue(buildContext);
	vi.mocked(build).mockResolvedValue(result);
	vi.mocked(formatMessages).mockImplementation(async (messages) => messages.map(({ text }) => `formatted: ${text}`));
	vi.mocked(resolvePlugins).mockResolvedValue({ plugins: [], dependencies: new Set(), [Symbol.dispose]: vi.fn() });
	rebuild.mockResolvedValue(result);
	dispose.mockResolvedValue(undefined);
	vi.spyOn(Logger, 'log').mockImplementation(() => {});
	vi.spyOn(Logger, 'error').mockImplementation(() => {});
	vi.spyOn(Logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetAllMocks();
	vi.unstubAllEnvs();
	vol.reset();
});

describe('EsbuildRunner', () => {
	it('reuses the watch context across runs', async () => {
		const runner = createRunner();
		await expect(runner.run(entryPoints)).resolves.toEqual([]);
		await runner.run(entryPoints);
		expect(context).toHaveBeenCalledTimes(1);
		expect(rebuild).toHaveBeenCalledTimes(2);
		expect(build).not.toHaveBeenCalled();
		await runner.dispose();
	});

	it('recreates the watch context when expanded environment definitions change', async () => {
		vi.stubEnv('RUNNER_VALUE', 'first');
		const runner = createRunner({ env: { value: '${process.env.RUNNER_VALUE}' } });

		await runner.run(entryPoints);
		vi.stubEnv('RUNNER_VALUE', 'second');
		await runner.run(entryPoints);

		expect(context).toHaveBeenCalledTimes(2);
		expect(vi.mocked(context).mock.calls[1]?.[0]?.define).toEqual({ 'import.meta.env.value': '"second"' });
		expect(rebuild).toHaveBeenCalledTimes(2);
		await runner.dispose();
	});

	it('invalidates a context once and creates a replacement with renamed entries', async () => {
		const runner = createRunner();
		await runner.run(entryPoints);
		await Promise.all([ runner.invalidateContext(), runner.invalidateContext() ]);
		expect(dispose).toHaveBeenCalledTimes(1);
		const renamedEntries = { index: Paths.absolute(directory, 'src/renamed.ts') };
		await runner.run(renamedEntries);
		expect(context).toHaveBeenCalledTimes(2);
		expect(vi.mocked(context).mock.calls[1]?.[0]?.entryPoints).toEqual(renamedEntries);
		await runner.dispose();
		expect(dispose).toHaveBeenCalledTimes(2);
	});

	it('shares disposal completion and disposes only once', async () => {
		const runner = createRunner();
		await runner.run(entryPoints);
		const pending = Promise.withResolvers<void>();
		dispose.mockReturnValue(pending.promise);
		const closing = runner.dispose();
		expect(runner.dispose()).toBe(closing);
		expect(dispose).toHaveBeenCalledTimes(1);
		pending.resolve();
		await closing;
		expect(runner.dispose()).toBe(closing);
	});

	it('disposes a context created during an active run after that run drains', async () => {
		const runner = createRunner();
		const creating = Promise.withResolvers<BuildContext>();
		const started = Promise.withResolvers<void>();
		vi.mocked(context).mockImplementation(() => {
			started.resolve();
			return creating.promise;
		});
		const running = runner.run(entryPoints);
		await started.promise;
		const closing = running.then(() => runner.dispose());
		expect(dispose).not.toHaveBeenCalled();
		creating.resolve(buildContext);
		await closing;
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('keeps a failed disposal idempotent', async () => {
		const runner = createRunner();
		await runner.run(entryPoints);
		dispose.mockRejectedValue(new Error('dispose failed'));
		const closing = runner.dispose();
		await expect(closing).rejects.toThrow('dispose failed');
		expect(runner.dispose()).toBe(closing);
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('can dispose without ever creating a context', async () => {
		const runner = createRunner();
		await runner.dispose();
		await runner.dispose();
		expect(context).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
	});

	it.each([
		{ watch: { enabled: false, recursive: true, persistent: true, ignoreInitial: true } },
		{ iife: false },
		{ iife: true },
		{ iife: { globalName: 'Library' } },
		{ plugins: [ './plugin.ts' ] }
	])('does not reuse contexts for %j', async (options) => {
		const runner = createRunner(options);
		await runner.run(entryPoints);
		await runner.run(entryPoints);
		expect(context).not.toHaveBeenCalled();
		expect(build).toHaveBeenCalledTimes(2);
	});

	it('allows reuse with an empty custom plugin list', async () => {
		const runner = createRunner({ plugins: [] });
		await runner.run(entryPoints);
		await runner.run(entryPoints);
		expect(context).toHaveBeenCalledOnce();
		expect(resolvePlugins).not.toHaveBeenCalled();
		await runner.dispose();
	});

	it('forwards build and compiler options without changing esbuild defaults', async () => {
		const compilerOptions: CompilerOptions = {
			alwaysStrict: true, strict: true, jsx: JsxEmit.ReactJSX, jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment', jsxImportSource: 'custom-jsx',
			paths: { '@local/*': [ './src/*' ] }, useDefineForClassFields: true, verbatimModuleSyntax: true
		};
		const runner = createRunner({ packages: 'bundle', platform: 'browser', target: 'ES2024', sourceMap: 'external', banner: { js: 'banner' }, footer: { js: 'footer' }, minify: true }, compilerOptions);
		await runner.run(entryPoints);
		expect(context).toHaveBeenCalledWith(expect.objectContaining({
			format: 'esm', write: false, metafile: true, treeShaking: true, logLevel: 'warning', absWorkingDir: directory,
			entryPoints, bundle: true, packages: 'bundle', platform: 'browser', sourcemap: 'external', target: 'ES2024', banner: { js: 'banner' }, footer: { js: 'footer' },
			outdir: '/project/dist', splitting: true, chunkNames: '[hash]', minify: true, supported: { decorators: false },
			tsconfigRaw: { compilerOptions: { ...compilerOptions, jsx: 'react-jsx', target: 'ES2024' } }, define: {}
		}));
		await runner.dispose();
	});

	it('resets reusable output state even when the next rebuild writes nothing', async () => {
		const runner = createRunner();
		vi.mocked(context).mockImplementation(async (options) => {
			const plugins = await setupPlugins(options);
			rebuild.mockImplementationOnce(() => plugins.finish(outputResult('index.js', 'first')))
				.mockImplementationOnce(() => plugins.finish({ errors: [], warnings: [] }))
				.mockResolvedValueOnce(result);
			return buildContext;
		});
		await expect(runner.run(entryPoints)).resolves.toEqual([{ path: 'dist/index.js', size: 5 }]);
		await expect(runner.run(entryPoints)).resolves.toEqual([]);
		await expect(runner.run(entryPoints)).resolves.toEqual([]);
		expect(vol.readFileSync('/project/dist/index.js', 'utf8')).toBe('first');
		await runner.dispose();
	});

	it('returns only the current run outputs for one-shot builds', async () => {
		const runner = createRunner({ iife: false });
		vi.mocked(build).mockImplementationOnce(async (options) => (await setupPlugins(options)).finish(outputResult('first.js', 'first')))
			.mockImplementationOnce(async (options) => (await setupPlugins(options)).finish(outputResult('next.js', 'next')));
		await expect(runner.run(entryPoints)).resolves.toEqual([{ path: 'dist/first.js', size: 5 }]);
		await expect(runner.run(entryPoints)).resolves.toEqual([{ path: 'dist/next.js', size: 4 }]);
	});

	it('starts metadata I/O in the constructor and registers IIFE, external, user, output plugins in order', async () => {
		vol.writeFileSync('/project/package.json', JSON.stringify({ dependencies: { bundled: '*', shared: '*' }, peerDependencies: { shared: '*', peer: '*' } }));
		const read = vi.spyOn(Files, 'read');
		vi.mocked(resolvePlugins).mockResolvedValue({ plugins: [{ name: 'user', setup() {} }], dependencies: new Set(), [Symbol.dispose]: vi.fn() });
		const runner = createRunner({ iife: true, noExternal: [ /^bundled/ ], plugins: [ './plugin.ts' ] }, { paths: { '@local/*': [ './src/*' ] } });
		expect(read).toHaveBeenCalledWith('/project/package.json');
		expect(build).not.toHaveBeenCalled();
		await runner.run(entryPoints);
		const options = vi.mocked(build).mock.calls[0]![0];
		expect(options.plugins?.map(({ name }) => name)).toEqual([ 'esbuild:iife', 'esbuild:external-modules', 'user', 'tsbuild:write-output' ]);
		const { onResolve } = await setupPlugins(options);
		const resolve = onResolve.mock.calls[0]![1];
		const resolvePath = (path: string) => resolve({ path, importer: '', namespace: 'file', resolveDir: directory, kind: 'import-statement', pluginData: undefined, with: {} });
		expect(await resolvePath('bundled/subpath')).toBeUndefined();
		expect(await resolvePath('@local/module')).toBeUndefined();
		expect(await resolvePath('shared')).toEqual({ external: true });
		expect(await resolvePath('peer')).toEqual({ external: true });
		expect(await resolvePath('other')).toEqual({ path: 'other', external: true });
		expect(await resolvePath('./local')).toBeUndefined();
	});

	it.each([ 'missing', 'invalid', 'empty' ])('tolerates %s package metadata', async (metadata) => {
		if (metadata !== 'missing') { vol.writeFileSync('/project/package.json', metadata === 'invalid' ? '{' : '{}') }
		const runner = createRunner({ noExternal: [ 'bundled' ] });
		await expect(runner.run(entryPoints)).resolves.toEqual([]);
		expect(vi.mocked(context).mock.calls[0]?.[0]?.plugins?.map(({ name }) => name)).toEqual([ 'esbuild:external-modules', 'tsbuild:write-output' ]);
		await runner.dispose();
	});

	it('does not read metadata or register external handling without noExternal', async () => {
		const read = vi.spyOn(Files, 'read');
		const runner = createRunner({ packages: 'bundle' });
		await runner.run(entryPoints);
		expect(read).not.toHaveBeenCalled();
		expect(vi.mocked(context).mock.calls[0]?.[0]?.plugins?.map(({ name }) => name)).toEqual([ 'tsbuild:write-output' ]);
		await runner.dispose();
	});

	it('keeps plugin scopes alive through async onEnd and snapshots dependencies before disposal', async () => {
		const dependencies = new Set<AbsolutePath>([ Paths.absolute(directory, 'plugin.ts') ]);
		const disposeScope = vi.fn(() => dependencies.clear());
		const endStarted = Promise.withResolvers<void>();
		const endCompleted = Promise.withResolvers<void>();
		vi.mocked(resolvePlugins).mockResolvedValue({
			dependencies, [Symbol.dispose]: disposeScope,
			plugins: [{ name: 'scoped', setup(pluginBuild) {
				expect(disposeScope).not.toHaveBeenCalled();
				dependencies.add(Paths.absolute(directory, 'setup.ts'));
				pluginBuild.onEnd(async () => {
					endStarted.resolve();
					await endCompleted.promise;
					expect(disposeScope).not.toHaveBeenCalled();
					dependencies.add(Paths.absolute(directory, 'on-end.ts'));
				});
			} }]
		});
		vi.mocked(build).mockImplementation(async (options) => (await setupPlugins(options)).finish(result));
		const runner = createRunner({ plugins: [ './plugin.ts' ] });
		const running = runner.run(entryPoints);
		await endStarted.promise;
		expect(disposeScope).not.toHaveBeenCalled();
		endCompleted.resolve();
		await running;
		expect(disposeScope).toHaveBeenCalledOnce();
		expect(runner.pluginDependencies).toEqual(new Set([ '/project/plugin.ts', '/project/setup.ts', '/project/on-end.ts' ]));
	});

	it.each([ 'setup', 'onEnd', 'build' ])('preserves dependencies and disposes scope after %s failure', async (stage) => {
		const dependencies = new Set<AbsolutePath>();
		const disposeScope = vi.fn();
		const fail = () => {
			expect(disposeScope).not.toHaveBeenCalled();
			dependencies.add(Paths.absolute(directory, `${stage}.ts`));
			throw new Error(`${stage} failed`);
		};
		vi.mocked(resolvePlugins).mockResolvedValue({
			dependencies, [Symbol.dispose]: disposeScope,
			plugins: [{ name: 'failing', setup(pluginBuild) {
				if (stage === 'setup') { fail() }
				if (stage === 'onEnd') { pluginBuild.onEnd(fail) }
			} }]
		});
		vi.mocked(build).mockImplementation(async (options) => {
			const plugins = await setupPlugins(options);
			if (stage === 'build') { fail() }
			return plugins.finish(result);
		});
		const runner = createRunner({ plugins: [ './plugin.ts' ] });
		await expect(runner.run(entryPoints)).rejects.toThrow(`${stage} failed`);
		expect(disposeScope).toHaveBeenCalledOnce();
		expect(runner.pluginDependencies).toEqual(new Set([ `/project/${stage}.ts` ]));
	});

	it('uses fresh plugin namespaces and replaces dependencies only after resolved execution', async () => {
		const firstDispose = vi.fn();
		const nextDispose = vi.fn();
		vi.mocked(resolvePlugins).mockResolvedValueOnce({ plugins: [], dependencies: new Set([ Paths.absolute(directory, 'first.ts') ]), [Symbol.dispose]: firstDispose })
			.mockRejectedValueOnce(new ConfigurationError('resolution failed'))
			.mockResolvedValueOnce({ plugins: [], dependencies: new Set([ Paths.absolute(directory, 'next.ts') ]), [Symbol.dispose]: nextDispose });
		const compilerOptions = { paths: { '@local/*': [ './src/*' ] } };
		const runner = createRunner({ plugins: [ './plugin.ts' ] }, compilerOptions);
		await runner.run(entryPoints);
		await expect(runner.run(entryPoints)).rejects.toThrow('resolution failed');
		expect(runner.pluginDependencies).toEqual(new Set([ '/project/first.ts' ]));
		await runner.run(entryPoints);
		expect(runner.pluginDependencies).toEqual(new Set([ '/project/next.ts' ]));
		const namespaces = vi.mocked(resolvePlugins).mock.calls.map(([, projectDirectory, scope]) => {
			expect(projectDirectory).toBe(directory);
			expect(scope).toMatchObject({ tsconfigPath: '/project/tsconfig.json', compilerOptions });
			expect(scope.namespace).toMatch(/^tsbuild-plugins:/);
			return scope.namespace;
		});
		expect(new Set(namespaces).size).toBe(3);
		expect(firstDispose).toHaveBeenCalledOnce();
		expect(nextDispose).toHaveBeenCalledOnce();
	});

	it.each([ 'experimentalDecorators', 'emitDecoratorMetadata' ])('rejects %s before resolving plugins', async (option) => {
		const runner = createRunner({ plugins: [ './plugin.ts' ] }, { [option]: true });
		await expect(runner.run(entryPoints)).rejects.toThrow(ConfigurationError);
		expect(resolvePlugins).not.toHaveBeenCalled();
		expect(build).not.toHaveBeenCalled();
		expect(context).not.toHaveBeenCalled();
	});

	it('expands and serializes env values, warning once per missing variable per run', async () => {
		vi.stubEnv('RUNNER_VALUE', 'quote"\nline');
		vi.stubEnv('RUNNER_MISSING', undefined);
		const runner = createRunner({ iife: false, env: { value: '${process.env.RUNNER_VALUE}', missing: '${process.env.RUNNER_MISSING}:${process.env.RUNNER_MISSING}', alsoMissing: '${process.env.RUNNER_MISSING}' } });
		await runner.run(entryPoints);
		expect(vi.mocked(build).mock.calls[0]?.[0].define).toEqual({
			'import.meta.env.value': JSON.stringify('quote"\nline'), 'import.meta.env.missing': '":"', 'import.meta.env.alsoMissing': '""'
		});
		expect(Logger.warn).toHaveBeenCalledExactlyOnceWith('Environment variable RUNNER_MISSING is not set; substituting an empty string.');
		vi.stubEnv('RUNNER_VALUE', 'updated');
		await runner.run(entryPoints);
		expect(vi.mocked(build).mock.calls[1]?.[0].define?.['import.meta.env.value']).toBe('"updated"');
		expect(Logger.warn).toHaveBeenCalledTimes(2);
	});

	it('formats warnings without failing a successful build', async () => {
		const warnings = [ message('warning') ];
		vi.mocked(build).mockResolvedValue({ ...result, warnings });
		await expect(createRunner({ iife: false }).run(entryPoints)).resolves.toEqual([]);
		expect(formatMessages).toHaveBeenCalledExactlyOnceWith(warnings, { kind: 'warning', color: true });
		expect(Logger.log).toHaveBeenCalledWith('formatted: warning', Logger.EntryType.Warn);
	});

	it.each([ 1, 2 ])('reports %i returned errors without duplicate logging', async (count) => {
		const errors = Array.from({ length: count }, () => message('error'));
		vi.mocked(build).mockResolvedValue({ ...result, warnings: [ message('warning') ], errors });
		await expect(createRunner({ iife: false }).run(entryPoints)).rejects.toThrow(`Bundling failed with ${count} error${count === 1 ? '' : 's'}`);
		expect(formatMessages).toHaveBeenNthCalledWith(1, [ message('warning') ], { kind: 'warning', color: true });
		expect(formatMessages).toHaveBeenNthCalledWith(2, errors, { kind: 'error', color: true });
		expect(Logger.log).toHaveBeenCalledWith('formatted: error', Logger.EntryType.Error);
		expect(Logger.error).not.toHaveBeenCalled();
	});

	it('preserves the no-metafile early return before reporting diagnostics', async () => {
		vi.mocked(build).mockResolvedValue({ errors: [ message('error') ], warnings: [ message('warning') ] });
		await expect(createRunner({ iife: false }).run(entryPoints)).resolves.toEqual([]);
		expect(formatMessages).not.toHaveBeenCalled();
	});

	it('formats thrown esbuild diagnostics as a single logged BundleError', async () => {
		const errors = [ message('first'), message('second') ];
		vi.mocked(build).mockRejectedValue({ errors });
		await expect(createRunner({ iife: false }).run(entryPoints)).rejects.toThrow('formatted: first\nformatted: second');
		expect(formatMessages).toHaveBeenCalledExactlyOnceWith(errors, { kind: 'error', color: true });
		expect(Logger.error).toHaveBeenCalledExactlyOnceWith('formatted: first\nformatted: second');
	});

	it.each([ new Error('plain failure'), 'plain failure', Object.assign(new Error('plain failure'), { errors: [] }) ])('wraps ordinary build failures: %s', async (error) => {
		vi.mocked(build).mockRejectedValue(error);
		await expect(createRunner({ iife: false }).run(entryPoints)).rejects.toThrow(BundleError);
		expect(Logger.error).toHaveBeenCalledExactlyOnceWith('plain failure');
		expect(formatMessages).not.toHaveBeenCalled();
	});

	it('preserves already-reported build errors', async () => {
		const error = new BuildError('already reported');
		vi.mocked(build).mockRejectedValue(error);
		await expect(createRunner({ iife: false }).run(entryPoints)).rejects.toBe(error);
		expect(Logger.error).not.toHaveBeenCalled();
	});

	it('retries context creation after failure and reuses contexts after rebuild failure', async () => {
		const runner = createRunner();
		vi.mocked(context).mockRejectedValueOnce(new Error('context failed'));
		await expect(runner.run(entryPoints)).rejects.toThrow('context failed');
		rebuild.mockRejectedValueOnce(new Error('rebuild failed'));
		await expect(runner.run(entryPoints)).rejects.toThrow('rebuild failed');
		await runner.run(entryPoints);
		expect(context).toHaveBeenCalledTimes(2);
		await runner.dispose();
		expect(dispose).toHaveBeenCalledOnce();
	});
});