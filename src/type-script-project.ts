import { Files } from './files';
import { Paths } from './paths.js';
import { Json } from './json.js';
import { Logger } from './logger';
import { rm } from 'node:fs/promises';
import { TextFormat } from './text-formatter';
import { bundleDeclarations } from './dts/declaration-bundler';
import { outputPlugin } from './plugins/output';
import { externalModulesPlugin } from './plugins/external-modules';
import { resolvePlugins } from './plugins/resolve-plugin';
import { iifePlugin, type IifePluginInstance } from './plugins/iife';
import { closeOnExit } from './decorators/close-on-exit';
import { logPerformance } from './decorators/performance-logger';
import { debounce } from './decorators/debounce';
import { BuildError, ConfigurationError, TypeCheckError } from './errors';
import { FileManager } from './file-manager';
import { IncrementalBuildCache } from './incremental-build-cache';
import { inferEntryPoints, type PackageJson } from './entry-points';
import { performance } from 'node:perf_hooks';
import { sys, createIncrementalProgram, formatDiagnostics, formatDiagnosticsWithColorAndContext, parseJsonConfigFileContent, readConfigFile, findConfigFile } from 'typescript';
import { compilerOptionOverrides, BuildMessageType, defaultSourceDirectory, defaultOutDirectory, defaultEntryPoint, defaultEntryFile, cacheDirectory, buildInfoFile, Platform, format, toEsTarget, processEnvExpansionPattern, toJsxRenderingMode } from 'src/constants';
import type { Watchr, WatchrStats, FileSystemEvent } from '@d1g1tal/watchr';
import type { BuilderProgram, CompilerOptions, Diagnostic, FormatDiagnosticsHost } from 'typescript';
import type { Closable, ProjectBuildConfiguration, TypeScriptConfiguration, BuildConfiguration, TypeScriptOptions, WrittenFile, AbsolutePath, RelativePath, EntryPoints, AsyncEntryPoints, PendingFileChange, ReadConfigResult, JsonString, Pattern } from './@types';

const globCharacters = /[*?\\[\]!].*$/;
const domPredicate = (lib: string) => lib.toUpperCase() === 'DOM';
const tsLogo = TextFormat.bgBlue(TextFormat.bold(TextFormat.whiteBright(' TS ')));
const diagnosticsHost: FormatDiagnosticsHost = { getNewLine: () => sys.newLine, getCurrentDirectory: sys.getCurrentDirectory, getCanonicalFileName: (fileName) => fileName };
const serializePattern = (p: Pattern): string => p instanceof RegExp ? `/${p.source}/${p.flags}` : p;

/**
 * Computes a deterministic fingerprint of the build configuration.
 * Fingerprint mismatch on the next build forces a full rebuild.
 * @param buildConfig - The resolved build configuration
 * @param compilerOptions - The resolved compiler options
 * @returns A deterministic JSON string representing the build configuration
 */
function buildFingerprint(buildConfig: ProjectBuildConfiguration, compilerOptions: CompilerOptions): string {
	return JSON.stringify({
		minify: buildConfig.minify,
		iife: buildConfig.iife,
		declaration: compilerOptions.declaration,
		emitDeclarationOnly: compilerOptions.emitDeclarationOnly,
		bundle: buildConfig.bundle,
		splitting: buildConfig.splitting,
		format,
		target: buildConfig.target,
		platform: buildConfig.platform,
		sourceMap: buildConfig.sourceMap,
		banner: buildConfig.banner,
		footer: buildConfig.footer,
		noExternal: buildConfig.noExternal.map(serializePattern),
		dtsResolve: buildConfig.dts.resolve,
		dtsEntryPoints: buildConfig.dts.entryPoints,
		env: buildConfig.env
	});
}

/** Class representing a TypeScript project */
@closeOnExit
export class TypeScriptProject implements Closable {
	#fileWatcher?: Watchr;
	#builderProgram: BuilderProgram;
	readonly #directory: AbsolutePath;
	readonly #configuration: TypeScriptConfiguration;
	readonly #fileManager: FileManager;
	readonly #buildConfiguration: ProjectBuildConfiguration;
	readonly #pendingChanges: PendingFileChange[] = [];
	readonly #buildDependencies: Set<RelativePath> = new Set();
	#pendingStaleOutputsCleanup?: Promise<void>;
	/** Identity of the Program that populated buildDependencies — skip re-walking when unchanged */
	#buildDependenciesProgram: ReturnType<BuilderProgram['getProgram']> | undefined;
	#dependencyPaths?: Promise<string[]>;

	/**
	 * Creates a TypeScript project and prepares it for building/bundling.
	 * @param directory - Project root directory (defaults to current working directory)
	 * @param options - Project options to merge with tsconfig.json
	 */
	constructor(directory: string | AbsolutePath = sys.getCurrentDirectory(), options: TypeScriptOptions = {}) {
		this.#directory = Paths.absolute(directory);
		this.#configuration = TypeScriptProject.#resolveConfiguration(this.#directory, options);

		const { buildCache, rootNames, projectReferences, configFileParsingDiagnostics, tsbuild: { entryPoints, ...tsbuildOptions }, compilerOptions: { target, outDir } } = this.#configuration;

		// Invalidate cache BEFORE creating the TypeScript program (which reads .tsbuildinfo)
		if (buildCache !== undefined && options.clearCache) { buildCache.invalidate() }

		// Initialize file manager for tracking emissions
		this.#fileManager = new FileManager(buildCache);
		this.#builderProgram = createIncrementalProgram({ rootNames, options: this.#configuration.compilerOptions, projectReferences, configFileParsingDiagnostics });
		this.#buildConfiguration = { entryPoints: this.#getEntryPoints(entryPoints), target: toEsTarget(target), outDir, ...tsbuildOptions };

		// Eagerly read package.json in parallel with TS Program creation — overlaps I/O with CPU work.
		// `transpile()` only awaits this promise when it needs the dependency list.
		this.#dependencyPaths = Files.read<JsonString<PackageJson>>(Paths.absolute(this.#directory, 'package.json'))
			.then((content) => {
				const { dependencies = {}, peerDependencies = {} } = Json.parse(content);
				const dependencySet = new Set<string>();
				for (const key of Object.keys(dependencies)) { dependencySet.add(key) }
				for (const key of Object.keys(peerDependencies)) { dependencySet.add(key) }

				return Array.from(dependencySet);
			})
			.catch(() => []);
	}

	/**
	 * Cleans the output directory
	 * @returns A promise that resolves when the cleaning is complete.
	 */
	async clean(): Promise<void> {
		// Remove all files
		return Files.empty(this.#buildConfiguration.outDir);
	}

	/**
	 * Removes outputs that the previous build wrote but the current build did not — e.g. renamed
	 * entry points or content-hashed chunks whose hash changed. Restricted to files under outDir
	 * for safety. Fire-and-forget: scheduled after build completion so it never inflates timings.
	 * @param previous - Project-relative paths recorded by the previous build (or undefined)
	 * @param current - Project-relative paths produced by the current build
	 */
	#cleanupStaleOutputs(previous: readonly string[] | undefined, current: readonly string[]): void {
		if (previous === undefined || previous.length === 0) { return }

		const currentSet = new Set(current);
		const outDirRel = Paths.relative(this.#directory, this.#buildConfiguration.outDir);
		const prefix = `${outDirRel}/`;
		const stale: string[] = [];
		for (const path of previous) {
			if (currentSet.has(path)) { continue }
			if (path !== outDirRel && !path.startsWith(prefix)) { continue }
			stale.push(Paths.absolute(this.#directory, path));
		}

		if (stale.length === 0) { return }

		const removals = new Array<Promise<void>>(stale.length);
		for (let i = 0, length = stale.length; i < length; i++) {
			removals[i] = rm(stale[i], { force: true });
		}

		const cleanup = Promise.all(removals)
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => {
				if (this.#pendingStaleOutputsCleanup === cleanup) { this.#pendingStaleOutputsCleanup = undefined }
			});

		this.#pendingStaleOutputsCleanup = cleanup;
	}

	/**
	 * Builds the project
	 * @returns A promise that resolves when the build is complete.
	 */
	@logPerformance('Build')
	async build(): Promise<void> {
		Logger.header(`${tsLogo} tsbuild v${import.meta.env?.tsbuild_version ?? process.env['npm_package_version']}${this.#configuration.compilerOptions.incremental && this.#configuration.buildCache?.isValid() ? ' [incremental]' : ''}`);

		try {
			const processes: Array<Promise<WrittenFile[]>> = [];
			const buildCache = this.#configuration.buildCache;

			// Check if build configuration has changed (minify, iife, declaration, platform, etc.)
			// If so, invalidate the dts cache and force a full rebuild
			const currentFingerprint = buildFingerprint(this.#buildConfiguration, this.#configuration.compilerOptions);
			const fingerprintMatched = buildCache !== undefined && await buildCache.fingerprintMatches(currentFingerprint);
			const force = this.#configuration.tsbuild.force || !fingerprintMatched;

			const cleanEnabled = this.#configuration.clean && !this.#configuration.compilerOptions.noEmit;

			// Manifest-driven output cleanup: when a manifest snapshot from a prior build is available,
			// skip the upfront clean entirely — even on --force / --clearCache. dts/transpile overwrite
			// same-named files, and stale outputs are diffed and removed asynchronously after the build
			// phases complete (off the critical path). This keeps the parallel `clean()` from racing
			// libuv's threadpool with TypeScript's emit and esbuild's I/O. Pre-clean is reserved for
			// truly cold builds (no manifest snapshot at all).
			const useManifest = cleanEnabled && buildCache !== undefined && buildCache.hasPersistedManifest();
			const previousOutputs = useManifest ? buildCache.getPreviousOutputs() : undefined;

			// On a true cold build (no manifest available), pre-clean in parallel with typeCheck —
			// only when emission is guaranteed to follow (force, or no persisted incremental state).
			const willEmit = force || buildCache?.hasPersistedState() !== true;
			const eagerCleanPromise = cleanEnabled && willEmit && !useManifest ? this.clean() : undefined;

			const filesWereEmitted = await this.#typeCheck();

			if ((filesWereEmitted || force) && !this.#configuration.compilerOptions.noEmit) {
				if (eagerCleanPromise !== undefined) {
					await eagerCleanPromise;
				}	else if (cleanEnabled && !useManifest) {
					await this.clean();
				}

				// Process declarations if enabled
				if (this.#configuration.compilerOptions.declaration) { processes.push(this.#processDeclarations()) }

				if (!this.#configuration.compilerOptions.emitDeclarationOnly) { processes.push(this.#transpile()) }
			} else if (eagerCleanPromise !== undefined) {
				// We started a clean but won't emit — still wait for it to finish so the directory
				// is in a consistent state before returning.
				await eagerCleanPromise;
			}

			const settled = await Promise.allSettled(processes);

			// Collect successful outputs (project-relative paths) for the manifest and stale-file diff.
			const newOutputs: string[] = [];
			for (const result of settled) {
				if (result.status === 'rejected') { this.#handleBuildError(result.reason); continue }
				for (const { path } of result.value) { newOutputs.push(path) }
			}

			// Defer the dts cache Brotli compression until AFTER the parallel phases complete.
			// Running it during transpile inflates esbuild's wall time by 50-70ms via libuv threadpool contention.
			// Pass configChanged so the new fingerprint is persisted even when TypeScript had nothing
			// new to emit — without this, every subsequent build after a config change would see a
			// fingerprint mismatch and force an unnecessary full rebuild.
			this.#fileManager.persistCache(currentFingerprint, !fingerprintMatched);

			// Stale-file cleanup + new manifest persistence — both fire-and-forget after the build
			// has reported completion, so they never inflate the critical path.
			if (buildCache !== undefined && newOutputs.length > 0) {
				if (previousOutputs !== undefined) { this.#cleanupStaleOutputs(previousOutputs, newOutputs) }
				void buildCache.saveOutputs(newOutputs).catch(() => { /* best-effort manifest persistence */ });
			}
		} catch (error) {
			this.#handleBuildError(error);
		} finally {
			// In watch mode, populate buildDependencies from TypeScript program's source files.
			// This is necessary because esbuild's inputs are only available after transpile(),
			// which may not run on incremental builds with no changes.
			if (this.#buildConfiguration.watch.enabled) {
				// Only re-walk when the underlying Program changed (e.g., after rebuild creates a new one).
				// Incremental no-op builds reuse the same Program and skip this O(N) loop entirely.
				const program = this.#builderProgram.getProgram();
				if (this.#buildDependenciesProgram !== program) {
					this.#buildDependenciesProgram = program;
					this.#buildDependencies.clear();
					const dirWithSlash = this.#directory + '/';
					for (const { isDeclarationFile, fileName } of program.getSourceFiles()) {
						// Skip declaration files and files outside project directory (e.g., node_modules)
						// Files outside the directory can't match watcher events anyway
						if (!isDeclarationFile && fileName.startsWith(dirWithSlash)) {
							this.#buildDependencies.add(Paths.relative(this.#directory, fileName));
						}
					}
				}

				// Ensure that `watch()` is called after the build by calling `setImmediate()`
				if (this.#fileWatcher === undefined || this.#fileWatcher.isClosed()) { setImmediate(() => void this.#watch()) }
			}
		}
	}

	/**
	 * Type-checks the project and optionally emits declaration files.
	 * When declarations are enabled in compiler options, this method also handles
	 * initializing and finalizing the file manager for incremental builds.
	 *
	 * For incremental builds, TypeScript's emit writes a .tsbuildinfo file only when changes
	 * are detected. This is used to determine whether subsequent build phases should run.
	 *
	 * @returns True if files were emitted (or non-incremental build), false if no changes detected
	 */
	@logPerformance('Type-checking/Emit', true)
	async #typeCheck() {
		await this.#fileManager.initialize();

		let allDiagnostics: Diagnostic[];
		if (this.#configuration.compilerOptions.noEmit) {
			// For noEmit, collect diagnostics first to populate the builder's incremental state,
			// then emit() writes .tsbuildinfo with the populated cache for use on the next run.
			// Calling builderProgram methods directly (not getProgram()) uses cached results
			// for unchanged files, replicating `tsc --noEmit` including declaration diagnostics.
			performance.mark('diagnostics:start');
			allDiagnostics = [
				...this.#builderProgram.getConfigFileParsingDiagnostics(),
				...this.#builderProgram.getOptionsDiagnostics(),
				...this.#builderProgram.getSyntacticDiagnostics(),
				...this.#builderProgram.getGlobalDiagnostics(),
				...this.#builderProgram.getSemanticDiagnostics(),
				...(this.#configuration.compilerOptions.declaration ? this.#builderProgram.getDeclarationDiagnostics() : [])
			];

			this.#builderProgram.emit(undefined, this.#fileManager.fileWriter, undefined, true);
		} else {
			// For normal emit, emit() processes files incrementally and also returns emit-phase
			// diagnostics. Semantic diagnostics are collected separately as emit() only returns
			// emit-phase errors and silently ignores e.g. TS2307 (Cannot find module).
			const { diagnostics } = this.#builderProgram.emit(undefined, this.#fileManager.fileWriter, undefined, true);

			allDiagnostics = [ ...this.#builderProgram.getSemanticDiagnostics(), ...diagnostics ];
		}

		if (allDiagnostics.length > 0) {
			// Deduplicate: with isolatedDeclarations, errors like TS9007 appear in both
			// getSemanticDiagnostics() and emit/declaration diagnostics simultaneously.
			const unique = new Map<string, Diagnostic>();
			for (const diagnostic of allDiagnostics) {
				const key = `${diagnostic.file?.fileName ?? ''}:${diagnostic.start ?? -1}:${diagnostic.code}`;
				if (!unique.has(key)) { unique.set(key, diagnostic) }
			}
			TypeScriptProject.#handleTypeErrors('Type-checking failed', Array.from(unique.values()), this.#directory);
		}

		// When declaration is disabled, TypeScript never emits .d.ts files, so finalize()
		// has no change signal — always proceed to allow esbuild to run.
		return this.#fileManager.finalize() || !this.#configuration.compilerOptions.declaration;
	}

	/**
	 * Transpiles the project using esbuild.
	 * @returns A promise that resolves to an array of written files after transpilation.
	 */
	@logPerformance('Transpile', true)
	async #transpile(): Promise<WrittenFile[]> {
		const { build: esbuild, formatMessages } = await import('esbuild');
		const plugins = [];

		// Register IIFE first when enabled. Its setup() forces write:false on the primary build,
		// and its onEnd() writes primary outputs from in-memory buffers (in parallel with the
		// secondary IIFE bundle). Subsequent onEnd hooks (e.g. outputPlugin's shebang chmod)
		// run serially after, so the files exist on disk by the time they read them.
		let iife: IifePluginInstance | undefined;
		if (this.#buildConfiguration.iife) {
			iife = iifePlugin(this.#buildConfiguration.iife === true ? undefined : this.#buildConfiguration.iife);
			plugins.push(iife.plugin);
		}

		plugins.push(outputPlugin());

		// Only use the external modules plugin when we have noExternal patterns to apply
		// When packages === 'bundle', we can just use esbuild's built-in packages option
		if (this.#buildConfiguration.noExternal.length > 0) {
			// esbuild's `external` option doesn't support RegExp. So here we use a custom plugin to implement it
			plugins.push(externalModulesPlugin({ dependencies: await this.#dependencyPaths, noExternal: this.#buildConfiguration.noExternal }));
		}

		if (this.#buildConfiguration.plugins?.length) { plugins.push(...await resolvePlugins(this.#buildConfiguration.plugins, this.#directory)) }

		// Prepare environment variable definitions as import.meta.env.* definitions
		// See: https://esbuild.github.io/api/#define
		const define: Record<string, string> = {};
		if (this.#buildConfiguration.env !== undefined) {
			// We can't use global regexes with String.replace, so we need to create a new RegExp object
			const envExpansion = new RegExp(processEnvExpansionPattern, 'g');
			for (const [ key, value ] of Object.entries(this.#buildConfiguration.env)) {
				// Expand process.env references (e.g., "${process.env.npm_package_version}") in env values to allow dynamic values in esbuild define, which only supports static strings
				define[`import.meta.env.${key}`] = Json.serialize(value.replace(envExpansion, (_, envVar: string) => process.env[envVar] ?? ''));
			}
		}

		try {
			const { warnings, errors, metafile: { outputs } } = await esbuild({
				format,
				plugins,
				define,
				write: true,
				metafile: true,
				treeShaking: true,
				logLevel: 'warning',
				tsconfigRaw: {
					compilerOptions: {
						alwaysStrict: this.#configuration.compilerOptions.alwaysStrict,
						jsx: toJsxRenderingMode(this.#configuration.compilerOptions.jsx),
						jsxFactory: this.#configuration.compilerOptions.jsxFactory,
						jsxFragmentFactory: this.#configuration.compilerOptions.jsxFragmentFactory,
						jsxImportSource: this.#configuration.compilerOptions.jsxImportSource,
						paths: this.#configuration.compilerOptions.paths,
						strict: this.#configuration.compilerOptions.strict,
						target: this.#buildConfiguration.target,
						useDefineForClassFields: this.#configuration.compilerOptions.useDefineForClassFields,
						verbatimModuleSyntax: this.#configuration.compilerOptions.verbatimModuleSyntax
					}
				},
				entryPoints: await this.#buildConfiguration.entryPoints,
				bundle: this.#buildConfiguration.bundle,
				packages: this.#buildConfiguration.packages,
				platform: this.#buildConfiguration.platform,
				sourcemap: this.#buildConfiguration.sourceMap,
				target: this.#buildConfiguration.target,
				banner: this.#buildConfiguration.banner,
				footer: this.#buildConfiguration.footer,
				outdir: this.#buildConfiguration.outDir,
				splitting: this.#buildConfiguration.splitting,
				chunkNames: '[hash]',
				minify: this.#buildConfiguration.minify,
				// Force decorator transformation even with ESNext target since Node.js doesn't support decorators yet
				supported: { decorators: false }
			});

			for (const [ kind, logEntryType, messages ] of [[ BuildMessageType.WARNING, Logger.EntryType.Warn, warnings ], [ BuildMessageType.ERROR, Logger.EntryType.Error, errors ]] as const) {
				if (messages.length > 0) {
					for (const message of await formatMessages(messages, { kind, color: true })) { Logger.log(message, logEntryType) }
				}

				if (kind === BuildMessageType.ERROR && errors.length > 0) { return [] }
			}

			const writtenFiles = [];
			for (const outputPath in outputs) {
				writtenFiles.push({ path: outputPath as RelativePath, size: outputs[outputPath].bytes });
			}

			if (iife) { writtenFiles.push(...iife.files) }

			return writtenFiles;
		} catch (error) {
			Logger.error('Transpile failed', error);
			throw error;
		}
	}

	/**
	 * Watches for changes in the project files and rebuilds the project when changes are detected.
	 */
	async #watch() {
		const { Watchr } = await import('@d1g1tal/watchr');

		const targets: AbsolutePath[] = [];

		for (const path of this.#configuration.include ?? [ defaultSourceDirectory ]) {
			targets.push(Paths.absolute(this.#directory, path.replace(globCharacters, '')));
		}

		const rebuild = (event: FileSystemEvent, stats: WatchrStats, path: string, nextPath?: string): void => {
			if (stats?.size === 0 && (event === Watchr.FileEvent.add || event === Watchr.FileEvent.unlink)) { return }

			// In type-check-only mode, we need to rebuild for ANY source file change since imported files
			// aren't in buildDependencies. In transpile mode, buildDependencies tracks esbuild inputs.
			if (this.#configuration.compilerOptions.noEmit || this.#buildDependencies.has(Paths.relative(this.#directory, path))) {
				this.#pendingChanges.push({ event, path: path as AbsolutePath, nextPath: nextPath as AbsolutePath });
				void this.#triggerRebuild();
			}
		};

		const pathsToIgnore = [ ...this.#configuration.exclude ?? [], ...this.#buildConfiguration.watch.ignore ?? [] ];

		this.#fileWatcher = new Watchr(targets, { ...this.#buildConfiguration.watch, ignore: (path: string) => pathsToIgnore.some((p) => path.includes(`/${p}/`) || path.endsWith(`/${p}`)) }, rebuild);

		Logger.info(`Watching for changes in: ${targets.join(', ')}`);
	}

	/** Closes the project and cleans up resources. */
	close(): void {
		this.#fileWatcher?.close();
		this.#fileManager.close();
		this.#pendingStaleOutputsCleanup = undefined;
		this.#buildDependencies.clear();
		this.#buildDependenciesProgram = undefined;
		this.#pendingChanges.length = 0;
	}

	/**
	 * Processes declaration files.
	 * @returns A promise that resolves to an array of written files after processing declarations.
	 */
	@logPerformance('Bundle Declarations', true)
	async #processDeclarations(): Promise<WrittenFile[]> {
		// If not bundling, just write declaration files to disk
		if (!this.#buildConfiguration.bundle) { return this.#fileManager.writeFiles(this.#directory) }

		return bundleDeclarations({
			currentDirectory: this.#directory,
			declarationFiles: this.#fileManager.getDeclarationFiles(),
			entryPoints: this.#fileManager.resolveEntryPoints(await this.#buildConfiguration.entryPoints, this.#buildConfiguration.dts.entryPoints),
			resolve: this.#buildConfiguration.dts.resolve,
			external: this.#buildConfiguration.external ?? [],
			noExternal: this.#buildConfiguration.noExternal,
			// Extract only the minimal compiler options needed for DTS bundling from configuration
			// All these properties are guaranteed to exist in TypeScriptConfiguration
			compilerOptions: {
				paths: this.#configuration.compilerOptions.paths,
				rootDir: this.#configuration.compilerOptions.rootDir as AbsolutePath,
				outDir: this.#configuration.compilerOptions.outDir as AbsolutePath,
				moduleResolution: this.#configuration.compilerOptions.moduleResolution
			},
			// Only yield to event loop if transpile is running in parallel
			parallelTranspile: !this.#configuration.compilerOptions.emitDeclarationOnly
		});
	}

	/**
	 * Triggers a rebuild after debouncing.
	 */
	@debounce(100)
	async #triggerRebuild() {
		if (this.#pendingChanges.length === 0) { return }

		Logger.clear();
		Logger.info(`Rebuilding project: ${this.#pendingChanges.length} file changes detected.`);

		const rootNames = [ ...this.#builderProgram.getProgram().getRootFileNames() ];

		// Apply all pending changes
		for (const { event, path, nextPath } of this.#pendingChanges) {
			// If a file or directory is renamed, update the path in the dependencies set
			if (nextPath !== undefined && (event === 'rename' || event === 'renameDir')) {
				this.#buildDependencies.delete(Paths.relative(this.#directory, path));
				this.#buildDependencies.add(Paths.relative(this.#directory, nextPath));

				// If a root file was renamed, update it in the root names array
				const index = rootNames.indexOf(path);
				if (index !== -1) { rootNames.splice(index, 1, nextPath) }
			} else {
				// Only remove from rootNames if it's an unlink event; push new files on add
				const index = rootNames.indexOf(path);
				if (event === 'unlink' && index !== -1) {
					rootNames.splice(index, 1);
				} else if (event === 'add' && index === -1) {
					rootNames.push(path);
				}
			}
		}

		this.#pendingChanges.length = 0;

		// Ensure the previous build's .tsbuildinfo write has settled before TypeScript reads it
		// during createIncrementalProgram(). persistCache() defers that write off the critical
		// path; the @debounce(100) usually covers it, but flushing here removes the race entirely.
		await this.#fileManager.flush();

		// Recreate program with incremental support if configured
		this.#builderProgram = createIncrementalProgram({ rootNames, options: this.#configuration.compilerOptions, projectReferences: this.#configuration.projectReferences, configFileParsingDiagnostics: this.#configuration.configFileParsingDiagnostics });

		// build() handles its own errors - no need to catch here
		await this.build();
	}

	/**
	 * Resolves configuration by merging options with tsconfig.json.
	 * @param directory - Project root directory
	 * @param typeScriptOptions - Partial TypeScript options to merge
	 * @returns Resolved configuration and TypeScript parser results
	 */
	static #resolveConfiguration(directory: AbsolutePath, typeScriptOptions: TypeScriptOptions): TypeScriptConfiguration {
		const configResult: ReadConfigResult = readConfigFile(findConfigFile(directory, sys.fileExists) ?? './tsconfig.json', sys.readFile);
		if (configResult.error !== undefined) {
			throw new ConfigurationError(formatDiagnostics([configResult.error], diagnosticsHost));
		}

		const bundle = typeScriptOptions.tsbuild?.bundle ?? configResult.config.tsbuild?.bundle ?? true;
		const platform = configResult.config.compilerOptions?.lib?.some(domPredicate) ? Platform.BROWSER : Platform.NODE;
		const noExternal = typeScriptOptions.tsbuild?.noExternal ?? configResult.config.tsbuild?.noExternal ?? [];

		const hasExplicitEntryPoints = typeScriptOptions.tsbuild?.entryPoints !== undefined || configResult.config.tsbuild?.entryPoints !== undefined;

		// When no entry points are explicitly configured, try to infer them from package.json
		let inferredEntryPoints: EntryPoints<RelativePath> | undefined;
		if (!hasExplicitEntryPoints && bundle) {
			const packageJsonContent = sys.readFile(Paths.join(directory, 'package.json'));
			if (packageJsonContent) {
				try {
					const pkgJson = JSON.parse(packageJsonContent) as PackageJson;
					const outDir = typeScriptOptions.compilerOptions?.outDir ?? configResult.config.compilerOptions?.outDir ?? defaultOutDirectory;
					const hasExportFields = pkgJson.exports !== undefined || pkgJson.bin !== undefined || pkgJson.main !== undefined || pkgJson.module !== undefined;
					inferredEntryPoints = inferEntryPoints(pkgJson, outDir);
					if (hasExportFields && inferredEntryPoints === undefined) {
						Logger.warn(`Could not infer entry points from package.json exports (output paths do not match outDir "${outDir}"). Add explicit entryPoints to your tsconfig.json tsbuild configuration.`);
					}
				} catch { /* ignore malformed package.json */ }
			}
		}

		const defaultTsbuildConfig: BuildConfiguration = {
			splitting: bundle,
			minify: false,
			force: false,
			bundle,
			sourceMap: typeScriptOptions.compilerOptions?.sourceMap ?? configResult.config.compilerOptions?.sourceMap ?? false,
			noExternal,
			packages: noExternal.length > 0 ? undefined : (platform === Platform.BROWSER ? 'bundle' : 'external'),
			platform,
			dts: { resolve: platform !== Platform.NODE, entryPoints: bundle ? undefined : [] },
			watch: { enabled: false, recursive: true, ignoreInitial: true, persistent: true },
			entryPoints: inferredEntryPoints ?? (bundle ? { [defaultEntryPoint]: defaultEntryFile } : { src: defaultSourceDirectory })
		};

		const baseConfig = {
			...configResult.config,
			clean: typeScriptOptions.tsbuild?.clean ?? configResult.config.tsbuild?.clean ?? true,
			tsbuild: {
				...defaultTsbuildConfig,
				...configResult.config.tsbuild,
				...typeScriptOptions.tsbuild,
				dts: { ...defaultTsbuildConfig.dts, ...configResult.config.tsbuild?.dts, ...typeScriptOptions.tsbuild?.dts },
				watch: { ...defaultTsbuildConfig.watch, ...configResult.config.tsbuild?.watch, ...typeScriptOptions.tsbuild?.watch }
			},
			compilerOptions: {
				...{ outDir: defaultOutDirectory, noEmit: false, sourceMap: false, incremental: true, tsBuildInfoFile: Paths.join(cacheDirectory, buildInfoFile), lib: [] },
				...configResult.config.compilerOptions,
				...typeScriptOptions.compilerOptions,
				// Auto-inject 'node' only on Node platform — browser/neutral builds shouldn't pay the
				// cost of loading @types/node (~3 MB of declarations). Users can still opt in by
				// listing 'node' explicitly in their tsconfig types array.
				types: (() => {
					const typesSet = new Set<string>();
					if (platform === Platform.NODE) { typesSet.add('node') }
					for (const t of configResult.config.compilerOptions?.types ?? []) { typesSet.add(t) }
					for (const t of typeScriptOptions.compilerOptions?.types ?? []) { typesSet.add(t) }

					return Array.from(typesSet);
				})()
			}
		};

		const { options, fileNames, errors } = parseJsonConfigFileContent(baseConfig, sys, directory);

		// Build final configuration with all required fields
		// Note: compilerOptionOverrides must be spread last to ensure they take precedence
		return {
			...baseConfig,
			compilerOptions: {
				...baseConfig.compilerOptions,
				...options,
				...compilerOptionOverrides
			},
			directory,
			rootNames: fileNames,
			configFileParsingDiagnostics: errors,
			buildCache: baseConfig.compilerOptions.incremental ? new IncrementalBuildCache(directory, baseConfig.compilerOptions.tsBuildInfoFile) : undefined
		};
	}

	/**
	 * Gets the entry points for the project.
	 * @param entryPoints - The entry points to get.
	 * @returns A promise that resolves to the entry points.
	 */
	async #getEntryPoints<const E extends Record<string, string>>(entryPoints: E): AsyncEntryPoints {
		const expandedEntryPoints: EntryPoints<AbsolutePath> = {};

		for (const [ name, entryPoint ] of Object.entries(entryPoints)) {
			const resolvedPath = Paths.absolute(this.#directory, entryPoint);

			if (await Paths.isDirectory(resolvedPath)) {
				for (const file of await Files.readDirectory(resolvedPath)) {
					const filePath = Paths.join(resolvedPath, file);

					if (await Paths.isFile(filePath)) { expandedEntryPoints[Paths.parse(file).name] = filePath }
				}
			} else if (await Paths.isFile(resolvedPath)) {
				expandedEntryPoints[name] = resolvedPath;
			} else {
				throw new ConfigurationError(`Entry point does not exist: ${entryPoint}. Add explicit entryPoints to your tsconfig.json tsbuild configuration.`);
			}
		}

		return expandedEntryPoints;
	}

	/**
	 * Handles build errors by logging unexpected errors and setting appropriate exit codes.
	 * Expected build failures (TypeCheckError, BundleError) are already logged when they occur,
	 * so this method only logs unexpected errors to avoid duplicate output.
	 * @param error - The error to handle
	 */
	#handleBuildError(error: unknown) {
		// ConfigurationError is not logged before being thrown, so log it here
		if (error instanceof ConfigurationError) {
			Logger.error(error.message);
			if (!this.#buildConfiguration.watch.enabled) { process.exitCode = error.code }
			return;
		}

		// TypeCheckError and BundleError are already logged when they occur - just set the exit code
		if (error instanceof BuildError) {
			if (!this.#buildConfiguration.watch.enabled) { process.exitCode = error.code }
			return;
		}

		// Unexpected errors need to be logged with full context
		Logger.error('Build failed', error);

		if (!this.#buildConfiguration.watch.enabled) { process.exitCode = 1 }
	}

	/**
	 * Handles type errors in the project.
	 * @param message - The message to display.
	 * @param diagnostics - The diagnostics to handle.
	 * @param projectDirectory - The project directory.
	 */
	static #handleTypeErrors(message: string, diagnostics: ReadonlyArray<Diagnostic>, projectDirectory: AbsolutePath) {
		// Print formatted diagnostics (matches tsc output)
		Logger.error(formatDiagnosticsWithColorAndContext(diagnostics, diagnosticsHost));

		// Build error summary by file (single pass)
		const filesWithErrors = new Map<string, { count: number; line: number }>();
		for (const { file, start } of diagnostics) {
			if (file !== undefined) {
				const { line } = file.getLineAndCharacterOfPosition(start ?? 0);
				const existing = filesWithErrors.get(file.fileName);
				if (existing !== undefined) {
					existing.count++;
					existing.line = Math.min(existing.line, line);
				} else {
					filesWithErrors.set(file.fileName, { count: 1, line });
				}
			}
		}

		// Print summary at the end (matches tsc format)
		const errorCount = diagnostics.length;
		const fileCount = filesWithErrors.size;
		const [ [ firstFileName, { line: firstLine } ] = [ '', { line: 0 } ] ] = filesWithErrors;
		const relativeFirstFileName = Paths.relative(projectDirectory, firstFileName);

		if (errorCount === 1) {
			Logger.error(`Found 1 error in ${relativeFirstFileName}:${firstLine + 1}${sys.newLine}`);
		} else if (fileCount === 1) {
			Logger.error(`Found ${errorCount} errors in the same file, starting at: ${relativeFirstFileName}:${firstLine + 1}${sys.newLine}`);
		} else {
			Logger.error(`Found ${errorCount} errors in ${fileCount} files.${sys.newLine}`);
			Logger.error('Errors  Files');
			for (const [fileName, { count, line }] of filesWithErrors) { Logger.error(`     ${count}  ${fileName}:${line + 1}`) }
		}

		// Throw to signal build failure - handleBuildError will set the exit code
		throw new TypeCheckError(message, formatDiagnostics(diagnostics, diagnosticsHost));
	}
}