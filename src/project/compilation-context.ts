import { Paths } from '../paths';
import { performance } from 'node:perf_hooks';
import { createEmitAndSemanticDiagnosticsBuilderProgram, createIncrementalCompilerHost, createIncrementalProgram } from 'typescript';
import type { AbsolutePath, RelativePath } from '../@types';
import type { CompilerHost, CompilerOptions, Diagnostic, EmitAndSemanticDiagnosticsBuilderProgram, Program, ProjectReference, SourceFile, WriteFileCallback } from 'typescript';

/** Inputs needed to construct and rebuild a TypeScript compiler session. */
export type CompilationContextOptions = {
	directory: AbsolutePath;
	compilerOptions: CompilerOptions;
	rootNames: string[];
	configFileParsingDiagnostics?: readonly Diagnostic[];
	projectReferences?: readonly ProjectReference[];
	watch: boolean;
};

/** Owns incremental compiler state without owning emitted files or build orchestration. */
export class CompilationContext {
	#builderProgram: EmitAndSemanticDiagnosticsBuilderProgram;
	#dependenciesProgram: Program | undefined;
	#dependencies: ReadonlySet<RelativePath> = new Set();
	readonly #directory: AbsolutePath;
	readonly #compilerOptions: CompilerOptions;
	readonly #compilerHost: CompilerHost;
	readonly #configFileParsingDiagnostics: readonly Diagnostic[] | undefined;
	readonly #projectReferences: readonly ProjectReference[] | undefined;
	readonly #sourceFileCache: Map<AbsolutePath, SourceFile> = new Map();

	/**
	 * Constructs the initial program after the caller has invalidated any stale build cache.
	 * @param options - Compiler inputs and watch-mode selection
	 */
	constructor({ directory, compilerOptions, rootNames, configFileParsingDiagnostics, projectReferences, watch }: CompilationContextOptions) {
		this.#directory = directory;
		this.#compilerOptions = watch ? { ...compilerOptions, incremental: false, tsBuildInfoFile: undefined } : compilerOptions;
		this.#configFileParsingDiagnostics = configFileParsingDiagnostics;
		this.#projectReferences = projectReferences;
		this.#compilerHost = createIncrementalCompilerHost(this.#compilerOptions);
		const originalGetSourceFile = this.#compilerHost.getSourceFile.bind(this.#compilerHost);
		this.#compilerHost.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
			if (!shouldCreateNewSourceFile) {
				const cached = this.#sourceFileCache.get(fileName as AbsolutePath);
				if (cached !== undefined) { return cached }
			}

			const sourceFile = originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
			if (sourceFile !== undefined) { this.#sourceFileCache.set(fileName as AbsolutePath, sourceFile) }

			return sourceFile;
		};
		this.#builderProgram = createIncrementalProgram({ rootNames, options: this.#compilerOptions, projectReferences, configFileParsingDiagnostics, host: this.#compilerHost });
	}

	/** Returns a detached root-name snapshot for the caller's watcher updates. */
	get rootNames(): string[] {
		return [ ...this.#builderProgram.getProgram().getRootFileNames() ];
	}

	/**
	 * Returns source text from the current program, even after source-cache invalidation.
	 * @param path - Absolute source path
	 */
	sourceText(path: AbsolutePath): string | undefined {
		return this.#builderProgram.getProgram().getSourceFile(path)?.text;
	}

	/**
	 * Invalidates only the named source so unchanged files retain their object identity.
	 * @param path - Absolute source path to invalidate
	 */
	invalidateSource(path: AbsolutePath): void {
		this.#sourceFileCache.delete(path);
	}

	/**
	 * Rebuilds using the same host and the exact previous builder as oldProgram.
	 * @param rootNames - Updated root names supplied by the watcher
	 */
	rebuild(rootNames: string[]): void {
		this.#builderProgram = createEmitAndSemanticDiagnosticsBuilderProgram(rootNames, this.#compilerOptions, this.#compilerHost, this.#builderProgram, this.#configFileParsingDiagnostics, this.#projectReferences);
	}

	/** Returns project source dependencies, walking source files only when Program identity changes. */
	get dependencies(): ReadonlySet<RelativePath> {
		const program = this.#builderProgram.getProgram();
		if (this.#dependenciesProgram !== program) {
			this.#dependenciesProgram = program;
			const dependencies = new Set<RelativePath>();
			const dirWithSlash = this.#directory + '/';
			for (const { isDeclarationFile, fileName } of program.getSourceFiles()) {
				if (!isDeclarationFile && fileName.startsWith(dirWithSlash)) { dependencies.add(Paths.relative(this.#directory, fileName)) }
			}
			this.#dependencies = dependencies;
		}

		return this.#dependencies;
	}

	/**
	 * Collects diagnostics in builder order, populating noEmit state before writing build information.
	 * @param fileWriter - Caller-owned emission callback
	 */
	collectDiagnostics(fileWriter: WriteFileCallback): Diagnostic[] {
		if (this.#compilerOptions.noEmit) {
			performance.mark('diagnostics:start');
			const diagnostics = [
				...this.#builderProgram.getConfigFileParsingDiagnostics(),
				...this.#builderProgram.getOptionsDiagnostics(),
				...this.#builderProgram.getSyntacticDiagnostics(),
				...this.#builderProgram.getGlobalDiagnostics(),
				...this.#builderProgram.getSemanticDiagnostics(),
				...(this.#compilerOptions.declaration ? this.#builderProgram.getDeclarationDiagnostics() : [])
			];

			this.#builderProgram.emit(undefined, fileWriter, undefined, true);

			return diagnostics;
		}

		const { diagnostics } = this.#builderProgram.emit(undefined, fileWriter, undefined, true);

		return [ ...this.#builderProgram.getSemanticDiagnostics(), ...diagnostics ];
	}

	/** Clears cached sources and dependency snapshots after build work has drained. */
	clear(): void {
		this.#sourceFileCache.clear();
		this.#dependenciesProgram = undefined;
		this.#dependencies = new Set();
	}
}