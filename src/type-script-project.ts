import { Files } from './files';
import { Paths } from './paths.js';
import { Json } from './json.js';
import { Watchr, type WatchrStats, type FileSystemEvent } from '@d1g1tal/watchr';
import { Logger } from './logger';
import { bundleDeclarations } from './dts/declaration-bundler';
import { outputPlugin } from './plugins/output';
import { externalModulesPlugin } from './plugins/external-modules';
import { closeOnExit } from './decorators/close-on-exit';
import { logPerformance } from './decorators/performance-logger';
import { debounce } from './decorators/debounce';
import { BuildError, ConfigurationError, TypeCheckError } from './errors';
import { FileManager } from './file-manager';
import { IncrementalBuildCache } from './incremental-build-cache';
import { build as esbuild, formatMessages } from 'esbuild';
import { sys, createIncrementalProgram, formatDiagnostics, formatDiagnosticsWithColorAndContext, parseJsonConfigFileContent, readConfigFile, findConfigFile } from 'typescript';
import { compilerOptionOverrides, BuildMessageType, defaultSourceDirectory, defaultOutDirectory, defaultEntryPoint, defaultEntryFile, cacheDirectory, buildInfoFile, Platform, format, toEsTarget, processEnvExpansionPattern, toJsxRenderingMode } from 'src/constants';
import type { BuilderProgram, Diagnostic, FormatDiagnosticsHost } from 'typescript';
import type { Closable, ProjectDependencies, ProjectBuildConfiguration, TypeScriptConfiguration, BuildConfiguration, TypeScriptOptions, WrittenFile, AbsolutePath, RelativePath, EntryPoints, AsyncEntryPoints, PendingFileChange, ReadConfigResult, JsonString } from './@types';

const globCharacters = /[*?\\[\]!].*$/;
const domPredicate = (lib: string) => lib.toUpperCase() === 'DOM';
const diagnosticsHost: FormatDiagnosticsHost = { getNewLine: () => sys.newLine, getCurrentDirectory: sys.getCurrentDirectory, getCanonicalFileName: (fileName) => fileName };

/** Class representing a TypeScript project */
@closeOnExit
export class TypeScriptProject implements Closable {
	private fileWatcher?: Watchr;
	private builderProgram: BuilderProgram;
	private readonly directory: AbsolutePath;
	private readonly configuration: TypeScriptConfiguration;
	private readonly fileManager: FileManager;
	private readonly buildConfiguration: ProjectBuildConfiguration;
	private readonly pendingChanges: PendingFileChange[] = [];
	private readonly buildDependencies: Set<RelativePath> = new Set();

	/**
	 * Creates a TypeScript project and prepares it for building/bundling.
	 * @param directory - Project root directory (defaults to current working directory)
	 * @param options - Project options to merge with tsconfig.json
	 */
	constructor(directory: string | AbsolutePath = sys.getCurrentDirectory() as AbsolutePath, options: TypeScriptOptions = {}) {
		this.directory = Paths.absolute(directory);
		this.configuration = TypeScriptProject.resolveConfiguration(this.directory, options);

		const { buildCache, rootNames, projectReferences, configFileParsingDiagnostics, tsbuild: { entryPoints, ...tsbuildOptions }, compilerOptions: { target, outDir } } = this.configuration;

		// Invalidate cache BEFORE creating the TypeScript program (which reads .tsbuildinfo)
		if (buildCache !== undefined && options.clearCache) { buildCache.invalidate() }

		// Initialize file manager for tracking emissions
		this.fileManager = new FileManager(buildCache);
		this.builderProgram = createIncrementalProgram({ rootNames, options: this.configuration.compilerOptions, projectReferences, configFileParsingDiagnostics });
		this.buildConfiguration = { entryPoints: this.getEntryPoints(entryPoints), target: toEsTarget(target), outDir, ...tsbuildOptions };
	}

	/**
	 * Cleans the output directory
	 * @returns A promise that resolves when the cleaning is complete.
	 */
	async clean(): Promise<void> {
		// Remove all files
		return Files.empty(this.buildConfiguration.outDir);
	}

	/**
	 * Builds the project
	 */
	@logPerformance('Build')
	async build(): Promise<void> {
		Logger.header(`🚀 tsbuild v${import.meta.env?.tsbuild_version ?? process.env.npm_package_version}${this.configuration.compilerOptions.incremental ? ' [incremental]' : ''}`);

		try {
			const processes: Array<Promise<WrittenFile[]>> = [];
			const filesWereEmitted = await this.typeCheck();

			if (filesWereEmitted && (!this.configuration.compilerOptions.noEmit || this.configuration.tsbuild.force)) {
				// Clean output directory if configured and there are changes to emit
				if (this.configuration.clean) { await this.clean() }

				// Process declarations if enabled
				if (this.configuration.compilerOptions.declaration) { processes.push(this.processDeclarations()) }

				// Transpile unless emitDeclarationOnly is set
				if (!this.configuration.compilerOptions.emitDeclarationOnly) { processes.push(this.transpile()) }
			}

			for (const result of await Promise.allSettled(processes)) {
				if (result.status === 'rejected') {
					this.handleBuildError(result.reason);
				}
			}
		} catch (error) {
			this.handleBuildError(error);
		} finally {
			// In watch mode, populate buildDependencies from TypeScript program's source files.
			// This is necessary because esbuild's inputs are only available after transpile(),
			// which may not run on incremental builds with no changes.
			if (this.buildConfiguration.watch.enabled) {
				this.buildDependencies.clear();
				for (const { isDeclarationFile, fileName } of this.builderProgram.getProgram().getSourceFiles()) {
					if (!isDeclarationFile) { this.buildDependencies.add(Paths.relative(this.directory, fileName)) }
				}

				// Ensure that `watch()` is called after the build by calling `setImmediate()`
				if (this.fileWatcher === undefined || this.fileWatcher.isClosed()) { setImmediate(() => this.watch()) }
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
	@logPerformance('Type-checking')
	private async typeCheck(): Promise<boolean> {
		await this.fileManager.initialize();

		// For incremental builds, we need to call emit() to save the .tsbuildinfo file, even in type-check-only mode.
		const { diagnostics } = this.builderProgram.emit(undefined, this.fileManager.fileWriter, undefined, true);

		if (diagnostics.length > 0) {
			TypeScriptProject.handleTypeErrors('Type-checking failed', diagnostics, this.directory);
		}

		return this.fileManager.finalize();
	}

	/**
	 * Transpiles the project using esbuild.
	 * @returns A promise that resolves to an array of written files after transpilation.
	 */
	@logPerformance('Transpile', true)
	private async transpile(): Promise<WrittenFile[]> {
		const plugins = [ outputPlugin() ];

		// Only use the external modules plugin when we have noExternal patterns to apply
		// When packages === 'bundle', we can just use esbuild's built-in packages option
		if (this.buildConfiguration.noExternal.length > 0) {
			// esbuild's `external` option doesn't support RegExp. So here we use a custom plugin to implement it
			plugins.push(externalModulesPlugin({ dependencies: await this.getProjectDependencyPaths(), noExternal: this.buildConfiguration.noExternal }));
		}

		// Lazy-load the SWC decorator metadata plugin only when needed for legacy decorator support. Not needed for stage 3 decorators
		if (this.configuration.compilerOptions.emitDecoratorMetadata) {
			try {
				const { swcDecoratorMetadataPlugin } = await import('./plugins/decorator-metadata.js');
				plugins.push(swcDecoratorMetadataPlugin);
			} catch {
				throw new ConfigurationError('emitDecoratorMetadata is enabled but @swc/core is not installed. Install it with: pnpm add -D @swc/core');
			}
		}

		if (this.buildConfiguration.plugins?.length) { plugins.push(...this.buildConfiguration.plugins) }

		// Prepare environment variable definitions as import.meta.env.* definitions
		// See: https://esbuild.github.io/api/#define
		const define: Record<string, string> = {};
		if (this.buildConfiguration.env !== undefined) {
			for (const [ key, value ] of Object.entries(this.buildConfiguration.env)) {
				// Expand process.env references (e.g., "${process.env.npm_package_version}")
				// Reset lastIndex since regex is global and reused across iterations
				processEnvExpansionPattern.lastIndex = 0;
				define[`import.meta.env.${key}`] = Json.serialize(value.replace(processEnvExpansionPattern, (_, envVar: string) => process.env[envVar] ?? ''));
			}
		}

		try {
			const { warnings, errors, metafile: { outputs } } = await esbuild({
				format,
				plugins,
				define,
				write: false,
				metafile: true,
				treeShaking: true,
				logLevel: 'warning',
				tsconfigRaw: {
					compilerOptions: {
						alwaysStrict: this.configuration.compilerOptions.alwaysStrict,
						experimentalDecorators: this.configuration.compilerOptions.experimentalDecorators,
						jsx: toJsxRenderingMode(this.configuration.compilerOptions.jsx),
						jsxFactory: this.configuration.compilerOptions.jsxFactory,
						jsxFragmentFactory: this.configuration.compilerOptions.jsxFragmentFactory,
						jsxImportSource: this.configuration.compilerOptions.jsxImportSource,
						paths: this.configuration.compilerOptions.paths,
						strict: this.configuration.compilerOptions.strict,
						target: this.buildConfiguration.target,
						useDefineForClassFields: this.configuration.compilerOptions.useDefineForClassFields,
						verbatimModuleSyntax: this.configuration.compilerOptions.verbatimModuleSyntax
					}
				},
				entryPoints: await this.buildConfiguration.entryPoints,
				bundle: this.buildConfiguration.bundle,
				packages: this.buildConfiguration.packages,
				platform: this.buildConfiguration.platform,
				sourcemap: this.buildConfiguration.sourceMap,
				target: this.buildConfiguration.target,
				banner: this.buildConfiguration.banner,
				footer: this.buildConfiguration.footer,
				outdir: this.buildConfiguration.outDir,
				splitting: this.buildConfiguration.splitting,
				chunkNames: '[hash]',
				minify: this.buildConfiguration.minify,
				// Force decorator transformation even with ESNext target since Node.js doesn't support decorators yet
				supported: { decorators: false }
			});

			for (const [ kind, logEntryType, messages ] of [[ BuildMessageType.WARNING, Logger.EntryType.Warn, warnings ], [ BuildMessageType.ERROR, Logger.EntryType.Error, errors ]] as const) {
				for (const message of await formatMessages(messages, { kind, color: true })) { Logger.log(message, logEntryType) }

				if (kind === BuildMessageType.ERROR && errors.length > 0) { return [] }
			}

			const writtenFiles: WrittenFile[] = [];
			for (const [ outputPath, { bytes } ] of Object.entries(outputs)) {
				writtenFiles.push({ path: outputPath as RelativePath, size: bytes });
			}

			return writtenFiles;
		} catch (error) {
			Logger.error('Transpile failed', error);
			throw error;
		}
	}

	/**
	 * Watches for changes in the project files and rebuilds the project when changes are detected.
	 */
	private watch(): void {
		const targets: AbsolutePath[] = [];

		for (const path of this.configuration.include ?? [ defaultSourceDirectory ]) {
			targets.push(Paths.absolute(this.directory, path.replace(globCharacters, '')));
		}

		const rebuild = (event: FileSystemEvent, stats: WatchrStats, path: string, nextPath?: string): void => {
			if (stats?.size === 0 && (event === Watchr.FileEvent.add || event === Watchr.FileEvent.unlink)) { return }

			// In type-check-only mode, we need to rebuild for ANY source file change since imported files
			// aren't in buildDependencies. In transpile mode, buildDependencies tracks esbuild inputs.
			if (this.configuration.compilerOptions.noEmit || this.buildDependencies.has(Paths.relative(this.directory, path))) {
				this.pendingChanges.push({ event, path: path as AbsolutePath, nextPath: nextPath as AbsolutePath });
				void this.triggerRebuild();
			}
		};

		const pathsToIgnore = [ ...this.configuration.exclude ?? [], ...this.buildConfiguration.watch.ignore ?? [] ];

		this.fileWatcher = new Watchr(targets, { ...this.buildConfiguration.watch, ignore: (path: string) => pathsToIgnore.some((p) => path.lastIndexOf(p) > -1) }, rebuild);

		Logger.info(`Watching for changes in: ${targets.join(', ')}`);
	}

	/** Closes the project and cleans up resources. */
	close(): void {
		this.fileWatcher?.close();
		this.fileManager.close();
		this.buildDependencies.clear();
		this.pendingChanges.length = 0;
	}

	/**
	 * Processes declaration files.
	 * @returns A promise that resolves to an array of written files after processing declarations.
	 */
	@logPerformance('Process Declarations', true)
	private async processDeclarations(): Promise<WrittenFile[]> {
		// If not bundling, just write declaration files to disk
		if (!this.buildConfiguration.bundle) { return this.fileManager.writeFiles(this.directory) }

		// If bundling, use the files from the file manager
		return bundleDeclarations({
			currentDirectory: this.directory,
			declarationFiles: this.fileManager.getDeclarationFiles(),
			entryPoints: this.fileManager.resolveEntryPoints(await this.buildConfiguration.entryPoints, this.buildConfiguration.dts.entryPoints),
			resolve: this.buildConfiguration.dts.resolve,
			external: this.buildConfiguration.external ?? [],
			noExternal: this.buildConfiguration.noExternal,
			// Extract only the minimal compiler options needed for DTS bundling from configuration
			// All these properties are guaranteed to exist in TypeScriptConfiguration
			compilerOptions: {
				paths: this.configuration.compilerOptions.paths as Record<string, RelativePath[]>,
				rootDir: this.configuration.compilerOptions.rootDir as AbsolutePath,
				outDir: this.configuration.compilerOptions.outDir as AbsolutePath,
				moduleResolution: this.configuration.compilerOptions.moduleResolution
			}
		});
	}

	/**
	 * Triggers a rebuild after debouncing.
	 */
	@debounce(100)
	private async triggerRebuild(): Promise<void> {
		if (this.pendingChanges.length === 0) { return }

		Logger.clear();
		Logger.info(`Rebuilding project: ${this.pendingChanges.length} file changes detected.`);

		const rootNames = [ ...this.builderProgram.getProgram().getRootFileNames() ];

		// Apply all pending changes
		for (const { event, path, nextPath } of this.pendingChanges) {
			// If a file or directory is renamed, update the path in the dependencies set
			if (nextPath !== undefined && (event === Watchr.FileEvent.rename || event === Watchr.DirectoryEvent.rename)) {
				this.buildDependencies.delete(Paths.relative(this.directory, path));
				this.buildDependencies.add(Paths.relative(this.directory, nextPath));

				// If a root file was renamed, update it in the root names array
				const index = rootNames.indexOf(path);
				if (index !== -1) { rootNames.splice(index, 1, nextPath) }
			} else {
				// Only remove from rootNames if it's an unlink event
				const index = rootNames.indexOf(path);
				if (event === Watchr.FileEvent.unlink && index !== -1) {
					rootNames.splice(index, 1);
				}
			}
		}

		this.pendingChanges.length = 0;

		// Recreate program with incremental support if configured
		this.builderProgram = createIncrementalProgram({ rootNames, options: this.configuration.compilerOptions, projectReferences: this.configuration.projectReferences });

		// build() handles its own errors - no need to catch here
		await this.build();
	}

	/**
	 * Resolves configuration by merging options with tsconfig.json.
	 * @param directory - Project root directory
	 * @param typeScriptOptions - Partial TypeScript options to merge
	 * @returns Resolved configuration and TypeScript parser results
	 */
	private static resolveConfiguration(directory: AbsolutePath, typeScriptOptions: TypeScriptOptions): TypeScriptConfiguration {
		const configResult: ReadConfigResult = readConfigFile(findConfigFile(directory, sys.fileExists) ?? './tsconfig.json', sys.readFile);
		if (configResult.error !== undefined) {
			throw new ConfigurationError(formatDiagnostics([configResult.error], diagnosticsHost));
		}

		const bundle = typeScriptOptions.tsbuild?.bundle ?? configResult.config.tsbuild?.bundle ?? true;
		const platform = configResult.config.compilerOptions?.lib?.some(domPredicate) ? Platform.BROWSER : Platform.NODE;
		const noExternal = typeScriptOptions.tsbuild?.noExternal ?? configResult.config.tsbuild?.noExternal ?? [];

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
			entryPoints: bundle ? { [defaultEntryPoint]: defaultEntryFile } : { src: defaultSourceDirectory }
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
				...compilerOptionOverrides
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
	private async getEntryPoints<const E extends Record<string, string>>(entryPoints: E): AsyncEntryPoints {
		const expandedEntryPoints: EntryPoints<AbsolutePath> = {};

		for (const [ name, entryPoint ] of Object.entries(entryPoints)) {
			const resolvedPath = Paths.absolute(this.directory, entryPoint);

			if (await Paths.isDirectory(resolvedPath)) {
				for (const file of await Files.readDirectory(resolvedPath)) {
					const filePath = Paths.join(resolvedPath, file);

					if (await Paths.isFile(filePath)) { expandedEntryPoints[Paths.parse(file).name] = filePath }
				}
			} else {
				expandedEntryPoints[name] = resolvedPath;
			}
		}

		return expandedEntryPoints;
	}

	/**
	 * Gets the project dependency paths.
	 * @returns A promise that resolves to an array of project dependency paths.
	 */
	private async getProjectDependencyPaths(): Promise<string[]> {
		const { dependencies = {}, peerDependencies = {} } = Json.parse(await Files.read<JsonString<ProjectDependencies>>(Paths.absolute(this.directory, 'package.json')));

		return [ ...new Set([ ...Object.keys(dependencies), ...Object.keys(peerDependencies) ]) ];
	}

	/**
	 * Handles build errors by logging unexpected errors and setting appropriate exit codes.
	 * Expected build failures (TypeCheckError, BundleError) are already logged when they occur,
	 * so this method only logs unexpected errors to avoid duplicate output.
	 * @param error - The error to handle
	 */
	private handleBuildError(error: unknown): void {
		// BuildError subclasses (TypeCheckError, BundleError, etc.) are expected build failures
		// that have already been logged - just set the exit code
		if (error instanceof BuildError) {
			if (!this.buildConfiguration.watch.enabled) { process.exitCode = error.code }
			return;
		}

		// Unexpected errors need to be logged with full context
		Logger.error('Build failed', error);

		if (!this.buildConfiguration.watch.enabled) { process.exitCode = 1 }
	}

	/**
	 * Handles type errors in the project.
	 * @param message - The message to display.
	 * @param diagnostics - The diagnostics to handle.
	 * @param projectDirectory - The project directory.
	 */
	private static handleTypeErrors(message: string, diagnostics: ReadonlyArray<Diagnostic>, projectDirectory: AbsolutePath): void {
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