import { Files } from './files';
import { Paths } from './paths';
import { sys } from 'typescript';
import { Logger } from './logger';
import { alwaysUndefined, toEsTarget } from './constants';
import { TextFormat } from './text-formatter';
import { bundleDeclarations } from './dts/declaration-bundler';
import { closeOnExit } from './decorators/close-on-exit';
import { logPerformance } from './decorators/performance-logger';
import { BuildError, ConfigurationError } from './errors';
import { dedupeDiagnostics, handleTypeErrors } from './project/diagnostics';
import { defaultCommandLineOptions, resolveConfiguration } from './project/configuration';
import { buildFingerprint } from './project/build-fingerprint';
import { OutputPathValidator } from './project/output-paths';
import { EsbuildRunner } from './project/esbuild-runner';
import { CompilationContext } from './project/compilation-context';
import { ProjectWatcher } from './watch/project-watcher';
import { RebuildQueue, formatPendingChangeSummary, isRenameEvent } from './watch/rebuild-queue';
import { FileManager } from './file-manager';
import { processManager } from './process-manager';
import { normalizeEntryPoints, resolveEntryPoints, updateEntryPoints } from './entry-points';
import type { CommandLineOptions, Closable, ProjectBuildConfiguration, TypeScriptConfiguration, TypeScriptOptions, WrittenFile, AbsolutePath, RelativePath, EntryPoints, PendingFileChange } from './@types';

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

const statusIsRejected = ({ status }: { status: string }) => status === 'rejected';

/** Class representing a TypeScript project */
@closeOnExit
export class TypeScriptProject implements Closable, AsyncDisposable {
	#entryPoints?: EntryPoints<AbsolutePath>;
	#pluginInvalidated = false;
	#closePromise?: Promise<void>;
	#buildCompletion?: Promise<void>;
	#activeBuilds = 0;
	#closed = false;
	#buildDependencies: ReadonlySet<RelativePath> = new Set();
	#resolveBuildCompletion?: () => void;
	readonly #projectWatcher: ProjectWatcher;
	readonly #compilationContext: CompilationContext;
	readonly #rebuildQueue: RebuildQueue;
	readonly #esbuildRunner: EsbuildRunner;
	readonly #directory: AbsolutePath;
	readonly #configuration: TypeScriptConfiguration;
	readonly #configuredEntryPoints: EntryPoints<RelativePath>;
	readonly #fileManager: FileManager;
	readonly #buildConfiguration: ProjectBuildConfiguration;
	/** Local TypeScript plugin dependencies discovered via the tsnode plugin scope (the plugin module and anything it imports) */
	readonly #pluginDependencies: Set<RelativePath> = new Set();
	readonly #outputPathValidator: OutputPathValidator;

	/**
	 * Creates a TypeScript project and prepares it for building/bundling.
	 * @param directory - Project root directory (defaults to current working directory)
	 * @param options - Project options to merge with tsconfig.json
	 * @param cliOptions - CLI-only runtime options
	 */
	constructor(directory: string | AbsolutePath = sys.getCurrentDirectory(), options: TypeScriptOptions = {}, cliOptions: CommandLineOptions = defaultCommandLineOptions) {
		this.#directory = Paths.absolute(directory);
		this.#configuration = resolveConfiguration(this.#directory, options, cliOptions);

		const { buildCache, rootNames, projectReferences, configFileParsingDiagnostics, tsbuild: { entryPoints, ...tsbuildOptions }, compilerOptions: { target, outDir } } = this.#configuration;

		// Invalidate cache BEFORE creating the TypeScript program (which reads .tsbuildinfo).
		// A forced build cleans outputs, so TypeScript must not reuse state that skips declaration emit.
		if (buildCache !== undefined && (cliOptions.clearCache || cliOptions.force)) { buildCache.invalidate() }

		// Initialize file manager for tracking emissions
		this.#fileManager = new FileManager(buildCache);
		this.#compilationContext = new CompilationContext({ directory: this.#directory, compilerOptions: this.#configuration.compilerOptions, rootNames, projectReferences, configFileParsingDiagnostics, watch: this.#configuration.tsbuild.watch.enabled });
		this.#configuredEntryPoints = normalizeEntryPoints(entryPoints);
		this.#buildConfiguration = { target: toEsTarget(target), outDir: outDir as AbsolutePath, ...tsbuildOptions };
		this.#outputPathValidator = new OutputPathValidator(this.#directory, this.#configuration.configFilePath, rootNames, this.#buildConfiguration.outDir);
		this.#esbuildRunner = new EsbuildRunner({ directory: this.#directory, compilerOptions: this.#configuration.compilerOptions, configFilePath: this.#configuration.configFilePath, buildOptions: this.#buildConfiguration });
		this.#rebuildQueue = new RebuildQueue({
			renameTimeoutMs: this.#buildConfiguration.watch['renameTimeout'] ?? 150,
			sourceText: (path) => this.#compilationContext.sourceText(path),
			rebuild: (changes) => this.#triggerRebuild(changes)
		});
		this.#projectWatcher = new ProjectWatcher({
			directory: this.#directory,
			include: this.#configuration.include,
			exclude: this.#configuration.exclude,
			watch: this.#buildConfiguration.watch,
			onChange: (event, stats, path, nextPath) => {
				const relativePath = this.#relativeToProject(path);
				if (!(this.#configuration.compilerOptions.noEmit || this.#buildDependencies.has(relativePath) || this.#pluginDependencies.has(relativePath))) { return }

				this.#rebuildQueue.enqueue(event, stats, path, nextPath);
			}
		});
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
	 * Returns whether this project remains alive for watcher rebuilds after a build.
	 */
	get isWatchMode(): boolean {
		return this.#buildConfiguration.watch.enabled;
	}

	/**
	 * Builds the project
	 * @returns A promise that resolves when the build is complete.
	 */
	@logPerformance('Build')
	async build(): Promise<void> {
		if (this.#activeBuilds++ === 0) {
			this.#buildCompletion = new Promise<void>((resolve) => { this.#resolveBuildCompletion = resolve });
		}

		Logger.header(`${tsLogo} tsbuild v${import.meta.env?.tsbuild_version ?? process.env['npm_package_version']}${this.#configuration.compilerOptions.incremental && this.#configuration.buildCache?.isValid() ? ' [incremental]' : ''}`);

		try {
			const processes: Array<Promise<WrittenFile[]>> = [];
			const { currentFingerprint, fingerprintMatched, force, cleanEnabled } = await this.#resolveBuildPlan();

			const filesWereEmitted = await this.#typeCheck();

			if ((filesWereEmitted || force || this.#pluginInvalidated) && !this.#configuration.compilerOptions.noEmit) {
				if (cleanEnabled) { await this.clean() }

				// Process declarations if enabled
				if (this.#configuration.compilerOptions.declaration) { processes.push(this.#processDeclarations()) }

				if (!this.#configuration.compilerOptions.emitDeclarationOnly) { processes.push(this.#transpile()) }
			}

			const writtenOutputs = this.#collectWrittenOutputs(await Promise.allSettled(processes));
			if (writtenOutputs !== undefined) {
				this.#finalizeBuildArtifacts({ currentFingerprint, fingerprintMatched }, processes.length > 0 || this.#configuration.compilerOptions.noEmit ? writtenOutputs : undefined);
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
	}

	/**
	 * Stops watching and releases resources immediately, then drains pending I/O.
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

		this.#rebuildQueue.stop();

		const runCleanupProcesses = () => Promise.allSettled([ this.#fileManager.flush(), this.#esbuildRunner.dispose() ]);

		const drain = this.#buildCompletion === undefined ? runCleanupProcesses() : this.#buildCompletion.then(runCleanupProcesses);

		this.#closePromise = this.#drainCleanup(drain, timeoutMs).finally(() => this.#fileManager.close());
		void drain.then(() => this.#clearRuntimeState(), () => this.#clearRuntimeState());
		void this.#closePromise.catch(alwaysUndefined);
		this.#projectWatcher.close();

		return this.#closePromise;
	}

	/** Closes the project when an `await using` scope ends. */
	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	/** Clears state after all asynchronous build and cleanup work has stopped. */
	#clearRuntimeState(): void {
		this.#buildDependencies = new Set();
		this.#pluginDependencies.clear();
		this.#rebuildQueue.clear();
		this.#compilationContext.clear();
	}

	/**
	 * Reports rejected declaration/transpile phase results.
	 * @param settled - Settled declaration/transpile phase results
	 */
	#collectWrittenOutputs(settled: ReadonlyArray<PromiseSettledResult<WrittenFile[]>>): WrittenFile[] | undefined {
		const writtenOutputs: WrittenFile[] = [];
		let succeeded = true;

		for (const result of settled) {
			if (result.status === 'rejected') {
				this.#handleBuildError(result.reason);
				succeeded = false;
				continue;
			}

			writtenOutputs.push(...result.value);
		}


		if (!succeeded) {
			this.#configuration.buildCache?.invalidate();
			return undefined;
		}

		return writtenOutputs;
	}

	/**
	 * Persists build artifacts after declaration/transpile phases complete.
	 * @param context - Build artifact finalization inputs
	 * @param writtenOutputs - Outputs written by the completed phases, when phases ran
	 */
	#finalizeBuildArtifacts({ currentFingerprint, fingerprintMatched }: BuildFinalizeContext, writtenOutputs?: ReadonlyArray<WrittenFile>): void {
		if (writtenOutputs !== undefined && this.#configuration.buildCache !== undefined) {
			this.#configuration.buildCache.setExpectedOutputArtifacts(writtenOutputs.map(({ path }) => Paths.absolute(this.#directory, path)));
		}

		// Defer the dts cache Brotli compression until AFTER the parallel phases complete. Running it during transpile inflates esbuild's wall time
		// by 50-70ms via libuv thread pool contention. Pass configChanged so the new fingerprint is persisted even when TypeScript had nothing new to
		// emit — without this, every subsequent build after a config change would see a fingerprint mismatch and force an unnecessary full rebuild.
		this.#fileManager.persistCache(currentFingerprint, !fingerprintMatched);
	}

	/**
	 * Resolves build planning decisions (cache/fingerprint/clean strategy) for the current run.
	 * @returns Build execution plan used by {@link build}
	 */
	async #resolveBuildPlan(): Promise<BuildPlan> {
		await this.#validateOutputPaths();
		const buildCache = this.#configuration.buildCache;

		// Check if build configuration has changed (minify, iife, declaration, platform, etc.). If so, invalidate the dts cache and force a full rebuild
		const currentFingerprint = buildFingerprint(this.#buildConfiguration, this.#configuration.compilerOptions);
		const fingerprintMatched = buildCache !== undefined && await buildCache.fingerprintMatches(currentFingerprint);
		const outputsPresent = buildCache === undefined || await buildCache.expectedOutputsExist();
		const force = this.#configuration.tsbuild.force || !fingerprintMatched || !outputsPresent;
		const cleanEnabled = this.#configuration.clean && !this.#configuration.compilerOptions.noEmit;

		return { currentFingerprint, fingerprintMatched, force, cleanEnabled };
	}

	/**
	 * Validates cleanup and declaration output paths before filesystem mutation.
	 * @throws {ConfigurationError} when a path can remove inputs or escape the output directory
	 */
	async #validateOutputPaths(): Promise<void> {
		const outputDirectory = await this.#outputPathValidator.validateOutputDirectory();

		if (!this.#configuration.compilerOptions.declaration) { return }

		const declarationEntries = this.#fileManager.resolveEntryPoints(await this.#currentEntryPoints(), this.#buildConfiguration.dts.entryPoints);
		await this.#outputPathValidator.validateDeclarationPaths(outputDirectory, Object.keys(declarationEntries));
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
	@logPerformance('Type-checking/Emit')
	async #typeCheck(): Promise<boolean> {
		await this.#fileManager.initialize();

		const allDiagnostics = this.#compilationContext.collectDiagnostics(this.#fileManager.fileWriter);

		if (allDiagnostics.length > 0) {
			handleTypeErrors('Type-checking failed', dedupeDiagnostics(allDiagnostics), this.#directory);
		}

		// When declaration is disabled, TypeScript never emits .d.ts files, so finalize()
		// has no change signal — always proceed to allow esbuild to run.
		return this.#fileManager.finalize() || !this.#configuration.compilerOptions.declaration;
	}

	/**
	 * Transpiles the project using esbuild.
	 * @returns A promise that resolves to an array of written files after transpilation.
	 */
	@logPerformance('Transpile')
	async #transpile() {
		try {
			return await this.#esbuildRunner.run(await this.#currentEntryPoints());
		} finally {
			this.#pluginDependencies.clear();
			for (const dependency of this.#esbuildRunner.pluginDependencies) { this.#pluginDependencies.add(this.#relativeToProject(dependency)) }
		}
	}

	/**
	 * Returns the cached entry point map, resolving it once on first use.
	 * @returns Mutable entry point map for the current build cycle
	 */
	async #currentEntryPoints(): Promise<EntryPoints<AbsolutePath>> {
		return this.#entryPoints ??= { ...(await resolveEntryPoints(this.#directory, this.#configuredEntryPoints)) };
	}

	/**
	 * Converts an absolute path to a project-relative path.
	 * @param path - Absolute path to convert
	 * @returns Project-relative path
	 */
	#relativeToProject(path: AbsolutePath): RelativePath {
		return Paths.relative(this.#directory, path);
	}

	/**
	 * Waits for cache persistence and esbuild disposal within the shutdown deadline.
	 * @param drain Pending cache writes and watch-context disposal results.
	 * @param timeoutMs Maximum time to wait for asynchronous cleanup in milliseconds.
	 * @returns A promise that resolves when both cleanup operations settle.
	 */
	async #drainCleanup(drain: Promise<PromiseSettledResult<void>[]>, timeoutMs: number): Promise<void> {
		try {
			const { promise, reject } = Promise.withResolvers<undefined>();

			using _timeout = setTimeout(() => reject(new Error(`Graceful shutdown timed out after ${timeoutMs}ms. Pending cache or esbuild cleanup may still be running.`)), timeoutMs);

			const settled = await Promise.race([ drain, promise ]);

			if (settled !== undefined) {
				const failure = settled.find(statusIsRejected);
				if (failure?.status === 'rejected') { throw failure.reason }
			}
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			Logger.error(`Graceful shutdown failed: ${failure.message}`);
			throw failure;
		}
	}

	/**
	 * Processes declaration files.
	 * @returns A promise that resolves to an array of written files after processing declarations.
	 */
	@logPerformance('Bundle Declarations')
	async #processDeclarations() {
		// If not bundling, just write declaration files to disk
		if (!this.#buildConfiguration.bundle) { return this.#fileManager.writeFiles(this.#directory) }

		return bundleDeclarations({
			currentDirectory: this.#directory,
			declarationFiles: this.#fileManager.getDeclarationFiles(),
			entryPoints: this.#fileManager.resolveEntryPoints(await this.#currentEntryPoints(), this.#buildConfiguration.dts.entryPoints),
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
	 * Applies filtered watcher events and rebuilds the project.
	 * @param pendingFileChanges - Meaningful watcher changes selected by the rebuild queue
	 */
	async #triggerRebuild(pendingFileChanges: ReadonlyArray<PendingFileChange>): Promise<void> {
		Logger.clear();
		Logger.info(`Rebuilding project: ${formatPendingChangeSummary(pendingFileChanges)}`);

		const rootNames = this.#compilationContext.rootNames;
		await this.#applyPendingFileChanges(pendingFileChanges, rootNames);
		this.#compilationContext.rebuild(rootNames);
		await this.build();
	}

	/**
	 * Applies watcher changes to dependency tracking and rootNames, acknowledging content-state changes.
	 * @param pendingFileChanges - Filtered pending watcher changes
	 * @param rootNames - Mutable rootNames array used to recreate the incremental program
	 */
	async #applyPendingFileChanges(pendingFileChanges: ReadonlyArray<PendingFileChange>, rootNames: string[]) {
		let renamedDependencies: Set<RelativePath> | undefined;

		for (const { event, path, nextPath } of pendingFileChanges) {
			// Force a fresh parse only for files we've confirmed changed; every other cached SourceFile (including lib/@types) stays eligible for structural reuse.
			this.#compilationContext.invalidateSource(path);

			if (nextPath !== undefined) { this.#compilationContext.invalidateSource(nextPath) }

			if (this.#pluginDependencies.has(this.#relativeToProject(path)) || (nextPath !== undefined && this.#pluginDependencies.has(this.#relativeToProject(nextPath)))) {
				this.#pluginInvalidated = true;
			}

			// If a file or directory is renamed, update the path in the dependencies set
			if (nextPath !== undefined && isRenameEvent(event)) {
				renamedDependencies ??= new Set(this.#buildDependencies);
				renamedDependencies.delete(this.#relativeToProject(path));
				renamedDependencies.add(this.#relativeToProject(nextPath));
				this.#buildDependencies = renamedDependencies;

				if (Object.values(this.#entryPoints ?? {}).includes(path)) {
					await this.#esbuildRunner.invalidateContext();
				}

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