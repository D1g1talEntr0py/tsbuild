import { sys } from 'typescript';
import { Files } from '../files';
import { Paths } from '../paths';
import { Json } from '../json';
import { Logger } from '../logger';
import { randomUUID } from 'node:crypto';
import { resolvePlugins } from '../plugins/resolve-plugin';
import { createIifePluginHandle } from '../plugins/iife';
import { createWriteOutputPlugin } from '../plugins/output';
import { externalModulesPlugin } from '../plugins/external-modules';
import { BuildError, BundleError, ConfigurationError, castError } from '../errors';
import { BuildMessageType, format, processEnvExpansionPattern, toJsxRenderingMode } from '../constants';

import type { CompilerOptions } from 'typescript';
import type { PackageJson } from '../entry-points';
import type { BuildContext, BuildFailure, BuildOptions, Message, OutputFile } from 'esbuild';
import type { AbsolutePath, EntryPoints, JsonString, Plugin, ProjectBuildConfiguration, WrittenFile } from '../@types';

type RunnerBuildOptions = Pick<ProjectBuildConfiguration, 'watch' | 'iife' | 'plugins' | 'noExternal' | 'env' | 'bundle' | 'packages' | 'platform' | 'sourceMap' | 'target' | 'banner' | 'footer' | 'outDir' | 'splitting' | 'minify'>;
type RunnerOptions = { directory: AbsolutePath; compilerOptions: CompilerOptions; configFilePath: AbsolutePath; buildOptions: RunnerBuildOptions };

/**
 * Narrows a caught esbuild error to its structured failure shape (`{ errors, warnings }`).
 * esbuild rejects with a plain object, not necessarily an Error instance.
 * @param error - The caught value to narrow
 */
function isBuildFailure(error: unknown): error is BuildFailure {
	return typeof error === 'object' && error !== null && Array.isArray((error as BuildFailure).errors);
}

/** Owns esbuild execution, plugin scopes, and reusable watch resources. */
export class EsbuildRunner implements AsyncDisposable {
	#dependencyPaths?: Promise<string[]>;
	#context?: BuildContext;
	#contextDefine?: string;
	#files: WrittenFile[] = [];
	#disposePromise?: Promise<void>;
	readonly #directory: AbsolutePath;
	readonly #compilerOptions: CompilerOptions;
	readonly #configFilePath: AbsolutePath;
	readonly #buildOptions: RunnerBuildOptions;
	readonly #pluginDependencies: Set<AbsolutePath> = new Set();

	/**
	 * Starts optional package metadata reads using the resolved project configuration.
	 * @param options - Directory, compiler configuration, and esbuild build settings
	 */
	constructor({ directory, compilerOptions, configFilePath, buildOptions }: RunnerOptions) {
		this.#directory = directory;
		this.#compilerOptions = compilerOptions;
		this.#configFilePath = configFilePath;
		this.#buildOptions = buildOptions;

		if (buildOptions.noExternal.length > 0) {
			this.#dependencyPaths = Files.read<JsonString<PackageJson>>(Paths.absolute(directory, 'package.json'))
				.then((content) => {
					const { dependencies = {}, peerDependencies = {} } = Json.parse(content);
					return Array.from(new Set([ ...Object.keys(dependencies), ...Object.keys(peerDependencies) ]));
				})
				.catch(() => []);
		}
	}

	/** Returns the latest plugin dependency snapshot, including dependencies discovered during failed builds. */
	get pluginDependencies(): ReadonlySet<AbsolutePath> {
		return this.#pluginDependencies;
	}

	/**
	 * Transpiles the current entry points and captures plugin dependencies after execution settles.
	 * @param entryPoints - Resolved entry points for this build
	 * @returns Files written by the output plugin
	 */
	async run(entryPoints: EntryPoints<AbsolutePath>): Promise<WrittenFile[]> {
		const { build: esbuild, context: createEsbuildContext, formatMessages } = await import('esbuild');
		const { plugins, iifeFiles, define, pluginDependencies, pluginResolution } = await this.#configureTranspileOptions();
		using _ = pluginResolution;
		const writtenFiles: WrittenFile[] = [];
		const canReuseContext = this.#buildOptions.watch.enabled && this.#buildOptions.iife === undefined && !this.#buildOptions.plugins?.length;
		const defineKey = Json.serialize(define);

		if (canReuseContext && this.#context !== undefined && this.#contextDefine !== defineKey) { await this.invalidateContext() }

		plugins.push(createWriteOutputPlugin(this.#directory, (files) => {
			if (canReuseContext) {
				this.#files = files;
			} else {
				writtenFiles.push(...files);
			}
		}, iifeFiles));

		try {
			if (canReuseContext) { this.#files = [] }

			const options: BuildOptions = {
				format,
				plugins,
				define,
				write: false,
				metafile: true,
				treeShaking: true,
				logLevel: 'warning',
				absWorkingDir: this.#directory,
				tsconfigRaw: {
					compilerOptions: {
						alwaysStrict: this.#compilerOptions.alwaysStrict,
						jsx: toJsxRenderingMode(this.#compilerOptions.jsx),
						jsxFactory: this.#compilerOptions.jsxFactory,
						jsxFragmentFactory: this.#compilerOptions.jsxFragmentFactory,
						jsxImportSource: this.#compilerOptions.jsxImportSource,
						paths: this.#compilerOptions.paths,
						strict: this.#compilerOptions.strict,
						target: this.#buildOptions.target,
						useDefineForClassFields: this.#compilerOptions.useDefineForClassFields,
						verbatimModuleSyntax: this.#compilerOptions.verbatimModuleSyntax
					}
				},
				entryPoints,
				bundle: this.#buildOptions.bundle,
				packages: this.#buildOptions.packages,
				platform: this.#buildOptions.platform,
				sourcemap: this.#buildOptions.sourceMap,
				target: this.#buildOptions.target,
				banner: this.#buildOptions.banner,
				footer: this.#buildOptions.footer,
				outdir: this.#buildOptions.outDir,
				splitting: this.#buildOptions.splitting,
				chunkNames: '[hash]',
				minify: this.#buildOptions.minify,
				supported: { decorators: false }
			};

			let result: Awaited<ReturnType<typeof esbuild>>;
			if (canReuseContext) {
				this.#contextDefine = defineKey;
				result = await (this.#context ??= await createEsbuildContext(options)).rebuild();
			} else {
				result = await esbuild(options);
			}

			const { warnings, errors, metafile: { outputs } = {} } = result;

			if (outputs === undefined) { return [] }

			await this.#reportEsbuildErrors(formatMessages, warnings, errors);

			return canReuseContext ? this.#files : writtenFiles;
		} catch (error) {
			if (error instanceof BuildError) { throw error }

			const errors = isBuildFailure(error) ? error.errors : undefined;
			const message = errors !== undefined && errors.length > 0 ? (await formatMessages(errors, { kind: 'error', color: true })).join(sys.newLine) : castError(error).message;

			Logger.error(message);

			throw new BundleError(message);
		} finally {
			this.#pluginDependencies.clear();
			for (const dependency of pluginDependencies) { this.#pluginDependencies.add(dependency) }

		}
	}

	/** Releases the current context before a subsequent run uses renamed entry points. */
	async invalidateContext(): Promise<void> {
		const context = this.#context;
		this.#context = undefined;
		this.#contextDefine = undefined;
		await context?.dispose();
	}

	/** Releases reusable resources once; the caller must first await its active build. */
	dispose(): Promise<void> {
		return this.#disposePromise ??= this.invalidateContext();
	}

	/**
	 * Releases reusable resources once; the caller must first await its active build.
	 * This method is called automatically when the runner is used in a `using` statement.
	 * @returns Promise that resolves when the runner has released its resources
	 */
	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	/**
	 * Logs esbuild diagnostics and throws when the build produced errors.
	 * @param formatMessages - esbuild formatter function
	 * @param warnings - Build warnings
	 * @param errors - Build errors
	 */
	async #reportEsbuildErrors(formatMessages: (messages: Message[], options: { kind: 'warning' | 'error'; color: boolean }) => Promise<string[]>, warnings: Message[], errors: Message[]) {
		for (const [ kind, logEntryType, messages ] of [[ BuildMessageType.WARNING, Logger.EntryType.Warn, warnings ], [ BuildMessageType.ERROR, Logger.EntryType.Error, errors ]] as const) {
			if (messages.length > 0) {
				for (const message of await formatMessages(messages, { kind, color: true })) { Logger.log(message, logEntryType) }
			}

			if (kind === BuildMessageType.ERROR && errors.length > 0) {
				throw new BundleError(`Bundling failed with ${errors.length} error${errors.length === 1 ? '' : 's'}`);
			}
		}
	}

	/**
	 * Prepares ordered plugins and a fresh scope that remains active through esbuild settlement.
	 * @returns Plugins, output buffers, defines, dependencies, and the optional plugin resource
	 */
	async #configureTranspileOptions() {
		this.#assertSupportedDecoratorConfiguration();
		const plugins: Plugin[] = [];
		let iifeFiles: OutputFile[] | undefined;
		let plugin: Plugin | undefined;
		if (this.#buildOptions.iife) {
			({ files: iifeFiles, plugin } = createIifePluginHandle(this.#buildOptions.iife === true ? undefined : this.#buildOptions.iife));
			plugins.push(plugin);
		}

		if (this.#buildOptions.noExternal.length > 0) {
			plugins.push(externalModulesPlugin({ dependencies: await this.#dependencyPaths ?? [], noExternal: this.#buildOptions.noExternal, paths: this.#compilerOptions.paths }));
		}

		let pluginDependencies: ReadonlySet<AbsolutePath> = new Set();
		let pluginResolution: Disposable | undefined;
		if (this.#buildOptions.plugins?.length) {
			const { plugins: resolvedPlugins, dependencies, ...resolution } = await resolvePlugins(this.#buildOptions.plugins, this.#directory, {
				namespace: `tsbuild-plugins:${randomUUID()}`,
				tsconfigPath: this.#configFilePath,
				compilerOptions: this.#compilerOptions
			});
			plugins.push(...resolvedPlugins);
			pluginDependencies = dependencies;
			pluginResolution = resolution;
		}

		return { plugins, iifeFiles, define: this.#buildDefineMap(), pluginDependencies, pluginResolution };
	}

	/** Rejects unsupported legacy decorator compiler options before plugin setup. */
	#assertSupportedDecoratorConfiguration() {
		if (this.#compilerOptions.experimentalDecorators || this.#compilerOptions.emitDecoratorMetadata) {
			throw new ConfigurationError('Legacy decorators are not supported. Remove "experimentalDecorators"/"emitDecoratorMetadata" from tsconfig.json and migrate to TC39 standard decorators.');
		}
	}

	/**
	 * Expands configured environment values into esbuild definitions.
	 * @returns Serialized import.meta.env definitions
	 */
	#buildDefineMap() {
		const define: Record<string, string> = {};
		if (this.#buildOptions.env === undefined) { return define }

		const envExpansion = new RegExp(processEnvExpansionPattern, 'g');
		const warnedMissingVariables = new Set<string>();
		for (const [ key, value ] of Object.entries(this.#buildOptions.env)) {
			define[`import.meta.env.${key}`] = Json.serialize(value.replace(envExpansion, (_, envVar: string) => {
				if (process.env[envVar] === undefined && !warnedMissingVariables.has(envVar)) {
					warnedMissingVariables.add(envVar);
					Logger.warn(`Environment variable ${envVar} is not set; substituting an empty string.`);
				}

				return process.env[envVar] ?? '';
			}));
		}

		return define;
	}
}