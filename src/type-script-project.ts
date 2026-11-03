import { Files } from './files';
import { Paths } from './paths';
import { API } from 'typescript/sync';
import { Logger } from './logger';
import { alwaysUndefined, BuildOutputStyle, PerformancePhase, defaultOutDirectory, toEsTarget } from './constants';
import { TextFormat } from './text-formatter';
import { bundleDeclarations } from './dts/declaration-bundler';
import { closeOnExit } from './decorators/close-on-exit';
import { flushPerformanceLog, logPerformance, setBuildOutputStyle } from './decorators/performance-logger';
import { BuildError, ConfigurationError } from './errors';
import { dedupeDiagnostics, handleTypeErrors } from './project/diagnostics';
import { defaultCommandLineOptions, resolveConfiguration } from './project/configuration';
import { buildFingerprint } from './project/build-fingerprint';
import { OutputPathValidator } from './project/output-paths';
import { EsbuildRunner } from './project/esbuild-runner';
import { CompilationContext } from './project/compilation-context';
import { ProjectWatcher, type FileSystemEventHandler } from './watch/project-watcher';
import { RebuildQueue, formatPendingChangeSummary, isRenameEvent } from './watch/rebuild-queue';
import { FileManager } from './file-manager';
import { processManager } from './process-manager';
import { normalizeEntryPoints, resolveEntryPoints, updateEntryPoints } from './entry-points';
import type { SourceDeclaration } from './dts/@types';
import type { CommandLineOptions, Closable, ProjectBuildConfiguration, TypeScriptConfiguration, TypeScriptOptions, WrittenFile, AbsolutePath, RelativePath, EntryPoints, PendingFileChange, VoidFunction } from './@types';

type BuildPlan = {
	currentFingerprint: string;
	fingerprintMatched: boolean;
	force: boolean;
	cleanEnabled: boolean;
};

type BuildFinalizeContext = {
	currentFingerprint: string;
	fingerprintMatched: boolean;
};

const tsLogo = TextFormat.bgBlue(TextFormat.bold(TextFormat.whiteBright(' TS ')));
const defaultCloseTimeoutMs = 5000;

/**
 * Checks if a status object represents a rejected state.
 * @param status - Status object with a `status` property
 * @returns `true` if the status is 'rejected', otherwise `false`
 */
const statusIsRejected = ({ status }: { status: string }) => status === 'rejected';

/** Class representing a TypeScript project */
@closeOnExit
export class TypeScriptProject implements Closable, AsyncDisposable {
	#activeBuilds = 0;
	#closed = false;
	#pluginInvalidated = false;
	#entryPoints?: EntryPoints<AbsolutePath>;
	#closePromise?: Promise<void>;
	#buildCompletion?: Promise<void>;
	#buildDependencies?: ReadonlySet<RelativePath>;
	#resolveBuildCompletion?: VoidFunction;
	readonly #api: API;
	readonly #directory: AbsolutePath;
	readonly #fileManager: FileManager;
	readonly #projectWatcher: ProjectWatcher;
	readonly #compilationContext: CompilationContext;
	readonly #rebuildQueue: RebuildQueue;
	readonly #esbuildRunner: EsbuildRunner;
	readonly #outputPathValidator: OutputPathValidator;
	readonly #configuration: TypeScriptConfiguration;
	readonly #buildConfiguration: ProjectBuildConfiguration;
	readonly #configuredEntryPoints: EntryPoints<RelativePath>;
	/** Owns compiler state and synchronous project resources; disposed after build and asynchronous cleanup have drained */
	readonly #resources = new DisposableStack();
	/** Project-lifetime detached ASTs keyed by the exact preprocessed declaration text and path. */
	readonly #declarationSourceFiles = new Map<AbsolutePath, SourceDeclaration>();
	/** Local TypeScript plugin dependencies discovered via the tsnode plugin scope (the plugin module and anything it imports) */
	readonly #pluginDependencies = new Set<RelativePath>();

	/**
	 * Creates a TypeScript project and prepares it for building/bundling.
	 * @param directory - Project root directory (defaults to current working directory)
	 * @param options - Project options to merge with tsconfig.json
	 * @param cliOptions - CLI-only runtime options
	 */
	constructor(directory: string | AbsolutePath = process.cwd(), options: TypeScriptOptions = {}, cliOptions: CommandLineOptions = defaultCommandLineOptions) {
		this.#directory = Paths.absolute(directory);

		try {
			// The API starts its compiler process lazily, on the first request
			this.#api = this.#resources.use(new API({ cwd: this.#directory }));
			this.#configuration = resolveConfiguration(this.#api, this.#directory, options, cliOptions);

			const { buildCache, rootNames, projectReferences, configFileParsingDiagnostics, tsbuild: { entryPoints, ...tsbuildOptions }, compilerOptions: { target, outDir } } = this.#configuration;

			// A forced build cleans outputs, so the cached declarations and input manifest must not be reused.
			if (buildCache !== undefined && (cliOptions.clearCache || cliOptions.force)) { buildCache.invalidate() }

			this.#fileManager = new FileManager(this.#api, buildCache);
			this.#compilationContext = this.#resources.use(new CompilationContext({ api: this.#api, directory: this.#directory, compilerOptions: this.#configuration.compilerOptions, rootNames, projectReferences, configFileParsingDiagnostics }));
			this.#configuredEntryPoints = normalizeEntryPoints(entryPoints);
			this.#buildConfiguration = { target: toEsTarget(target), outDir: Paths.absolute(this.#directory, outDir ?? defaultOutDirectory), ...tsbuildOptions };
			this.#outputPathValidator = new OutputPathValidator(this.#directory, this.#configuration.configFilePath, rootNames, this.#buildConfiguration.outDir);
			this.#esbuildRunner = new EsbuildRunner({ api: this.#api, directory: this.#directory, compilerOptions: this.#configuration.compilerOptions, configFilePath: this.#configuration.configFilePath, buildOptions: this.#buildConfiguration });
			this.#rebuildQueue = this.#resources.use(new RebuildQueue({
				renameTimeoutMs: this.#buildConfiguration.watch.renameTimeout ?? 50,
				sourceText: (path) => this.#compilationContext.sourceText(path),
				rebuild: (changes) => this.#triggerRebuild(changes)
			}));
			this.#projectWatcher = this.#resources.use(new ProjectWatcher({ directory: this.#directory, include: this.#configuration.include, exclude: this.#configuration.exclude, watch: this.#buildConfiguration.watch, onChange: this.#onChangeHandler }));
		} catch (error) {
			this.#resources.dispose();
			throw error;
		}
	}

	/**
	 * Cleans the output directory
	 * @returns A promise that resolves when the cleaning is complete.
	 */
	async clean(): Promise<void> {
		await this.#validateOutputPaths();

		return Files.empty(this.#buildConfiguration.outDir);
	}

	/**
	 * Builds the project, or only type-checks when compilerOptions.noEmit is configured.
	 * @returns This project for async disposal, or null to keep a watch project alive.
	 */
	@logPerformance(PerformancePhase.BUILD)
	async build(): Promise<TypeScriptProject | null> {
		if (this.#activeBuilds++ === 0) {
			this.#buildCompletion = new Promise<void>((resolve) => this.#resolveBuildCompletion = resolve);
		}

		Logger.header(`${tsLogo} tsbuild v${import.meta.env?.tsbuild_version ?? process.env['npm_package_version']}${this.#configuration.compilerOptions.incremental && this.#configuration.buildCache?.isValid() ? ' [incremental]' : ''}`);
		setBuildOutputStyle(this.#configuration.tsbuild.outputStyle ?? BuildOutputStyle.SUMMARY, this.#buildConfiguration.watch.enabled);

		try {
			let settledOutputPhases: Array<PromiseSettledResult<WrittenFile[]>> = [];
			const { currentFingerprint, fingerprintMatched, force, cleanEnabled } = await this.#resolveBuildPlan();
			flushPerformanceLog();

			const filesWereEmitted = await this.#compile();

			if ((filesWereEmitted || force || this.#pluginInvalidated) && !this.#configuration.compilerOptions.noEmit) {
				if (cleanEnabled) { await this.clean() }
				settledOutputPhases = await this.#bundle();
			}

			const writtenOutputs = this.#collectWrittenOutputs(settledOutputPhases);
			if (writtenOutputs !== undefined) {
				this.#finalizeBuildArtifacts({ currentFingerprint, fingerprintMatched }, settledOutputPhases.length > 0 || this.#configuration.compilerOptions.noEmit ? writtenOutputs : undefined);
			}
		} catch (error) {
			this.#handleBuildError(error);
		} finally {
			try {
				this.#pluginInvalidated = false;

				// In watch mode, populate buildDependencies from TypeScript program's source files.
				// This is necessary because esbuild's inputs are only available after transpile(), which may not run on incremental builds with no changes.
				if (this.#buildConfiguration.watch.enabled && !this.#closed) {
					this.#buildDependencies = this.#compilationContext.dependencies;

					// Reconcile watcher targets after every build because a plugin rebuild may add or remove local imports outside the project's source include tree.
					await this.#projectWatcher.reconcile(this.#pluginDependencies);
				}
			} finally {
				if (--this.#activeBuilds === 0) {
					this.#resolveBuildCompletion?.();
					this.#resolveBuildCompletion = undefined;
					this.#buildCompletion = undefined;
				}
			}
		}

		return this.#buildConfiguration.watch.enabled ? null : this;
	}

	/**
	 * Stops scheduling immediately, then drains active builds and I/O before releasing resources.
	 * @param timeoutMs Maximum time to wait for asynchronous cleanup in milliseconds.
	 * @returns The shared promise for cleanup completion.
	 * @throws {Error} When cleanup fails or exceeds the timeout.
	 */
	close(timeoutMs: number = defaultCloseTimeoutMs): Promise<void> {
		if (this.#closePromise !== undefined) { return this.#closePromise }

		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			return Promise.reject(new ConfigurationError(`Shutdown timeout must be a finite non-negative number of milliseconds; received ${timeoutMs}.`));
		}

		this.#closed = true;
		processManager.removeCloseable(this);
		this.#rebuildQueue.close();

		const runCleanupProcesses = () => Promise.allSettled([ this.#fileManager[Symbol.asyncDispose](), this.#esbuildRunner[Symbol.asyncDispose]() ]);
		const drain = (this.#buildCompletion === undefined ? runCleanupProcesses() : this.#buildCompletion.then(runCleanupProcesses)).then((settled) => {
			// Synchronous compiler/resource disposal is part of shutdown too: account for its failures on the shared close promise, not an unobserved side promise.
			try { this.#clearRuntimeState() } catch (reason) { settled.push({ status: 'rejected', reason }) }

			return settled;
		});

		this.#closePromise = this.#executeDrainCleanup(drain, timeoutMs);
		void this.#closePromise.catch(alwaysUndefined);
		this.#projectWatcher.close();

		return this.#closePromise;
	}

	/** Closes the project when an `await using` scope ends. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	/** Runs declaration bundling and transpilation concurrently. */
	@logPerformance(PerformancePhase.BUNDLE, PerformancePhase.DECLARATIONS, PerformancePhase.TRANSPILE)
	#bundle() {
		const processes: Array<Promise<WrittenFile[]>> = [];

		if (this.#configuration.compilerOptions.declaration) { processes.push(this.#processDeclarations()) }

		if (!this.#configuration.compilerOptions.emitDeclarationOnly) { processes.push(this.#transpile()) }

		return Promise.allSettled(processes);
	}

	/** Clears state after all asynchronous build and cleanup work has stopped. */
	#clearRuntimeState() {
		this.#buildDependencies = undefined;
		this.#pluginDependencies.clear();
		this.#declarationSourceFiles.clear();
		this.#resources.dispose();
	}

	/**
	 * Reports rejected declaration/transpile phase results.
	 * @param settled - Settled declaration/transpile phase results
	 */
	#collectWrittenOutputs(settled: ReadonlyArray<PromiseSettledResult<WrittenFile[]>>) {
		let succeeded = true;
		const writtenOutputs: WrittenFile[] = [];

		for (const result of settled) {
			if (result.status === 'rejected') {
				this.#handleBuildError(result.reason);
				succeeded = false;
				continue;
			}

			writtenOutputs.push(...result.value);
		}

		return succeeded ? writtenOutputs : this.#configuration.buildCache?.invalidate();
	}

	/**
	 * Persists build artifacts after declaration/transpile phases complete.
	 * @param context - Build artifact finalization inputs
	 * @param writtenOutputs - Outputs written by the completed phases, when phases ran
	 */
	#finalizeBuildArtifacts({ currentFingerprint, fingerprintMatched }: BuildFinalizeContext, writtenOutputs?: ReadonlyArray<WrittenFile>) {
		if (writtenOutputs !== undefined && this.#configuration.buildCache !== undefined) {
			this.#configuration.buildCache.setExpectedOutputArtifacts(writtenOutputs.map(({ path }) => Paths.absolute(this.#directory, path)));
		}

		// Defer the dts cache Brotli compression until AFTER the parallel phases complete. Running it during transpile inflates esbuild's wall time
		// by 50-70ms via libuv thread pool contention. Pass configChanged so the new fingerprint is persisted even when TypeScript had nothing new to
		// emit — without this, every subsequent build after a config change would see a fingerprint mismatch and force an unnecessary full rebuild.
		this.#fileManager.persistCache(currentFingerprint, !fingerprintMatched);
	}

	/**
	 * Handles filesystem change events for the project.
	 * @param event - Type of filesystem event
	 * @param stats - Filesystem statistics for the affected path
	 * @param path - Absolute path of the affected file or directory
	 * @param nextPath - Absolute path of the next location for rename events, if applicable
	 */
	#onChangeHandler: FileSystemEventHandler = (event, stats, path, nextPath) => {
		const relativePath = Paths.relative(this.#directory, path);

		if (this.#configuration.compilerOptions.noEmit || this.#buildDependencies?.has(relativePath) || this.#pluginDependencies.has(relativePath)) {
			this.#rebuildQueue.enqueue(event, stats, path, nextPath);
		}
	};

	/**
	 * Resolves build planning decisions (cache/fingerprint/clean strategy) for the current run.
	 * @returns Build execution plan used by {@link build}
	 */
	@logPerformance(PerformancePhase.INITIALIZATION)
	async #resolveBuildPlan(): Promise<BuildPlan> {
		const { noEmit } = this.#configuration.compilerOptions;
		if (!noEmit) { await this.#validateOutputPaths() }

		const buildCache = this.#configuration.buildCache;
		// Check if build configuration has changed (minify, iife, declaration, platform, etc.). If so, invalidate the dts cache and force a full rebuild
		const currentFingerprint = buildFingerprint(this.#buildConfiguration, this.#configuration.compilerOptions);
		const fingerprintMatched = buildCache !== undefined && await buildCache.fingerprintMatches(currentFingerprint);
		const outputsPresent = noEmit || buildCache === undefined || await buildCache.expectedOutputsExist();

		return {
			currentFingerprint,
			fingerprintMatched,
			force: this.#configuration.tsbuild.force || !fingerprintMatched || !outputsPresent,
			cleanEnabled: this.#configuration.clean && !this.#configuration.compilerOptions.noEmit
		};
	}

	/**
	 * Validates cleanup and declaration output paths before filesystem mutation.
	 * @throws {ConfigurationError} when a path can remove inputs or escape the output directory
	 */
	async #validateOutputPaths() {
		const outputDirectory = await this.#outputPathValidator.validateOutputDirectory();

		if (!this.#configuration.compilerOptions.declaration) { return }

		const declarationEntries = this.#fileManager.resolveEntryPoints(await this.#currentEntryPoints(), this.#buildConfiguration.dts.entryPoints);
		await this.#outputPathValidator.validateDeclarationPaths(outputDirectory, Object.keys(declarationEntries));
	}

	/**
	 * Type-checks the project and optionally emits declaration files.
	 *
	 * For incremental builds, the compiler is skipped entirely when the persisted input manifest proves every
	 * input is unchanged since the last error-free build; the cached declarations are restored instead.
	 *
	 * @returns True if the compiler ran (or non-incremental build), false if the cached build was reused
	 */
	@logPerformance(PerformancePhase.COMPILE)
	async #compile(): Promise<boolean> {
		await this.#fileManager.initialize();

		const upToDate = await this.#configuration.buildCache?.upToDateManifest(this.#compilationContext.manifestKey);

		if (upToDate !== undefined) {
			this.#compilationContext.restore(upToDate);
			await this.#fileManager.restore();

			return false;
		}

		const { diagnostics, declarations, manifest } = this.#compilationContext.compile();

		if (diagnostics.length > 0) {
			handleTypeErrors('Type-checking failed', dedupeDiagnostics(diagnostics), this.#directory);
		}

		this.#fileManager.ingest(declarations, manifest);

		return this.#fileManager.finalize();
	}

	/**
	 * Transpiles the project using esbuild.
	 * @returns A promise that resolves to an array of written files after transpilation.
	 */
	@logPerformance(PerformancePhase.TRANSPILE)
	async #transpile() {
		try { return await this.#esbuildRunner.run(await this.#currentEntryPoints()) } finally {
			this.#pluginDependencies.clear();
			for (const dependency of this.#esbuildRunner.pluginDependencies) { this.#pluginDependencies.add(Paths.relative(this.#directory, dependency)) }
		}
	}

	/**
	 * Returns the cached entry point map, resolving it once on first use.
	 * @returns Mutable entry point map for the current build cycle
	 */
	async #currentEntryPoints() {
		return this.#entryPoints ??= { ...(await resolveEntryPoints(this.#directory, this.#configuredEntryPoints)) };
	}

	/**
	 * Waits for cache persistence and esbuild disposal within the shutdown deadline.
	 * @param drain Pending cache writes and watch-context disposal results.
	 * @param timeoutMs Maximum time to wait for asynchronous cleanup in milliseconds.
	 * @returns A promise that resolves when both cleanup operations settle.
	 */
	async #executeDrainCleanup(drain: Promise<PromiseSettledResult<void>[]>, timeoutMs: number) {
		try {
			const { promise, reject } = Promise.withResolvers<undefined>();

			using _timeout = setTimeout(() => reject(new Error(`Graceful shutdown timed out after ${timeoutMs}ms. Pending cache or esbuild cleanup may still be running.`)), timeoutMs);

			const settled = await Promise.race([ drain, promise ]);

			if (settled !== undefined) {
				const failure = settled.find(statusIsRejected);
				if (failure?.status === 'rejected') { throw failure.reason }
			}
		} catch (error) {
			const failure = Error.isError(error) ? error : new Error(String(error));
			Logger.error(`Graceful shutdown failed: ${failure.message}`);
			throw failure;
		}
	}

	/**
	 * Processes declaration files.
	 * @returns A promise that resolves to an array of written files after processing declarations.
	 */
	@logPerformance(PerformancePhase.DECLARATIONS)
	async #processDeclarations() {
		// If not bundling, just write declaration files to disk
		if (!this.#buildConfiguration.bundle) { return this.#fileManager.writeFiles(this.#directory) }

		return bundleDeclarations({
			api: this.#api,
			currentDirectory: this.#directory,
			declarationFiles: this.#fileManager.getDeclarationFiles(),
			sourceFileCache: this.#declarationSourceFiles,
			entryPoints: this.#fileManager.resolveEntryPoints(await this.#currentEntryPoints(), this.#buildConfiguration.dts.entryPoints),
			resolve: this.#buildConfiguration.dts.resolve,
			external: this.#buildConfiguration.external ?? [],
			noExternal: this.#buildConfiguration.noExternal,
			// Extract only the minimal compiler options needed for DTS bundling from configuration
			// All these properties are guaranteed to exist in TypeScriptConfiguration
			compilerOptions: {
				paths: this.#configuration.compilerOptions.paths,
				rootDir: this.#configuration.compilerOptions.rootDir === undefined ? undefined : Paths.absolute(this.#configuration.compilerOptions.rootDir),
				outDir: this.#buildConfiguration.outDir,
				moduleResolution: this.#configuration.compilerOptions.moduleResolution,
				configFilePath: this.#configuration.configFilePath
			},
			// Only yield to event loop if transpile is running in parallel
			parallelTranspile: !this.#configuration.compilerOptions.emitDeclarationOnly
		});
	}

	/**
	 * Applies filtered watcher events and rebuilds the project.
	 * @param pendingFileChanges - Meaningful watcher changes selected by the rebuild queue
	 */
	async #triggerRebuild(pendingFileChanges: ReadonlyArray<PendingFileChange>) {
		Logger.clear();
		Logger.info(`Rebuilding project: ${formatPendingChangeSummary(pendingFileChanges)}`);

		this.#compilationContext.rebuild(await this.#applyPendingFileChanges(pendingFileChanges, this.#compilationContext.rootNames));

		return void this.build();
	}

	/**
	 * Applies watcher changes to dependency tracking and rootNames, acknowledging content-state changes.
	 * @param pendingFileChanges - Filtered pending watcher changes
	 * @param rootNames - Mutable rootNames array used to recreate the incremental program
	 */
	async #applyPendingFileChanges(pendingFileChanges: ReadonlyArray<PendingFileChange>, rootNames: string[]) {
		let renamedDependencies: Set<RelativePath> | undefined;

		for (const { event, path, nextPath } of pendingFileChanges) {
			// Invalidate only the files confirmed changed; every other file (including lib/@types) is reused from the previous snapshot.
			this.#compilationContext.notify(event, path, nextPath);

			if (this.#pluginDependencies.has(Paths.relative(this.#directory, path)) || (nextPath !== undefined && this.#pluginDependencies.has(Paths.relative(this.#directory, nextPath)))) {
				this.#pluginInvalidated = true;
			}

			// If a file or directory is renamed, update the path in the dependencies set
			if (nextPath !== undefined && isRenameEvent(event)) {
				renamedDependencies ??= new Set(this.#buildDependencies);
				renamedDependencies.delete(Paths.relative(this.#directory, path));
				renamedDependencies.add(Paths.relative(this.#directory, nextPath));
				this.#buildDependencies = renamedDependencies;

				if (Object.values(this.#entryPoints ?? {}).includes(path)) { await this.#esbuildRunner.invalidateContext() }

				updateEntryPoints(this.#entryPoints, path, nextPath);

				this.#rebuildQueue.markApplied({ event, path, nextPath });

				// If a root file was renamed, update it in the root names array
				const index = rootNames.indexOf(path);
				if (index !== -1) { rootNames.splice(index, 1, nextPath) }

				continue;
			}

			// Only remove from rootNames if it's an unlink event; push new files on add
			const index = rootNames.indexOf(path);
			if (event === 'unlink' && index !== -1) {
				rootNames.splice(index, 1);
				this.#rebuildQueue.markApplied({ event, path });
			} else if (event === 'add' && index === -1) {
				rootNames.push(path);
			}
		}

		return rootNames;
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
}