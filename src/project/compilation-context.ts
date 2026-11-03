import { statSync } from 'node:fs';
import { Json } from '../json';
import { Paths } from '../paths';
import { version } from 'typescript';
import { EmitOnly } from 'typescript/sync';
import { FileExtension } from '../constants';
import type { AbsolutePath, BuildInputManifest, BuildInputStat, RelativePath } from '../@types';
import type { API, CompilerOptions, Diagnostic, FileNotifications, Program, ProjectReference, Snapshot, SyntheticProjectId } from 'typescript/sync';

/** Inputs needed to construct and rebuild a TypeScript compiler session. */
export type CompilationContextOptions = {
	/** TypeScript API that owns the compiler process (owned by the caller) */
	api: API;
	directory: AbsolutePath;
	compilerOptions: CompilerOptions;
	rootNames: string[];
	configFileParsingDiagnostics?: readonly Diagnostic[];
	projectReferences?: readonly ProjectReference[];
};

/** Plain-data result of one compilation; nothing in it references compiler-process handles. */
export type CompilationResult = {
	diagnostics: readonly Diagnostic[];
	/** Emitted declaration text keyed by absolute output path (empty when declarations are not emitted) */
	declarations: ReadonlyMap<AbsolutePath, string>;
	/** Input manifest for skipping the compiler on the next build; only present when the compilation is error-free */
	manifest?: BuildInputManifest;
};

/** Watcher events that map to compiler file notifications. */
type NotificationEvent = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir' | 'rename' | 'renameDir';

/** One immutable compiler state: a snapshot and the program it contains. Disposing the snapshot releases both. */
type Generation = { snapshot: Snapshot; program: Program<SyntheticProjectId> };

/** Mtime marking a manifest entry as unverifiable, so the next build never trusts it. */
const unverifiable = -1;

/**
 * Batched request for the declaration phase: emits declarations, or under `noEmit` only checks them.
 * @param program - Program to query
 * @param declaration - Whether declarations are enabled
 * @param noEmit - Whether emit is disabled
 */
function* declarationStep(program: Program<SyntheticProjectId>, declaration: boolean, noEmit: boolean) {
	if (!declaration) { return {} }

	return noEmit ? { declarationDiagnostics: yield* program.getDeclarationDiagnostics.gen() } : { emitOutput: yield* program.emitToString.gen(EmitOnly.OnlyDts) };
}

/** Owns compiler-process state (snapshots and programs) without owning emitted files or build orchestration. */
export class CompilationContext implements Disposable {
	#generation: Generation | undefined;
	#rootNames: string[];
	#rootNamesChanged = false;
	#notifications: Required<Pick<FileNotifications, 'changed' | 'created' | 'deleted'>> = { changed: [], created: [], deleted: [] };
	#dependencies: ReadonlySet<RelativePath> | undefined;
	#sourceFileNames: readonly string[] = [];
	readonly #api: API;
	readonly #directory: AbsolutePath;
	readonly #compilerOptions: CompilerOptions;
	readonly #configFileParsingDiagnostics: readonly Diagnostic[];
	readonly #projectReferences: readonly ProjectReference[] | undefined;

	/**
	 * Captures compiler inputs. The compiler snapshot is created lazily on the first {@link compile}, so a build whose inputs are unchanged never starts it.
	 * @param options - Compiler inputs and the API that owns the compiler process
	 */
	constructor({ api, directory, compilerOptions, rootNames, configFileParsingDiagnostics = [], projectReferences }: CompilationContextOptions) {
		this.#api = api;
		this.#directory = directory;
		this.#compilerOptions = compilerOptions;
		this.#rootNames = rootNames;
		this.#configFileParsingDiagnostics = configFileParsingDiagnostics;
		this.#projectReferences = projectReferences;
	}

	/** Returns a detached root-name snapshot for the caller's watcher updates. */
	get rootNames(): string[] {
		return [ ...this.#rootNames ];
	}

	/** Deterministic key of the compiler inputs that are not file contents: root names, compiler options and the TypeScript version. */
	get manifestKey(): string {
		return Json.serialize({ rootNames: this.#rootNames, compilerOptions: this.#compilerOptions, version });
	}

	/**
	 * Returns source text from the current program, reflecting the contents before pending notifications are applied.
	 * @param path - Absolute source path
	 */
	sourceText(path: AbsolutePath): string | undefined {
		return this.#generation?.program.getSourceFile(path)?.text;
	}

	/**
	 * Records a watcher event so the next {@link rebuild} invalidates exactly the affected files.
	 * @param event - Watcher event type
	 * @param path - Absolute path of the affected file
	 * @param nextPath - New path for rename events
	 */
	notify(event: NotificationEvent, path: AbsolutePath, nextPath?: AbsolutePath): void {
		const { changed, created, deleted } = this.#notifications;

		switch (event) {
			case 'add': case 'addDir': created.push(path); break;
			case 'unlink': case 'unlinkDir': deleted.push(path); break;
			case 'rename': case 'renameDir':
				deleted.push(path);
				if (nextPath !== undefined) { created.push(nextPath) }
				break;
			default: changed.push(path);
		}
	}

	/**
	 * Derives the next generation from the current one, applying pending notifications and root-name changes.
	 * The previous snapshot stays alive until the new one exists, so unchanged files and checker state are reused.
	 * @param rootNames - Updated root names supplied by the watcher
	 */
	rebuild(rootNames: string[]): void {
		this.#rootNamesChanged ||= rootNames.length !== this.#rootNames.length || rootNames.some((name, i) => name !== this.#rootNames[i]);
		this.#rootNames = rootNames;

		if (this.#generation === undefined) {
			this.#clearNotifications();
			return;
		}

		using previous = this.#generation.snapshot;
		const { id } = this.#generation.program;
		// Detach before updating: `previous` is released on scope exit even when the update throws, and the next build must then start fresh
		this.#generation = undefined;
		const snapshot = previous.update({
			fileNotifications: this.#notifications,
			...(this.#rootNamesChanged ? { reconfigurePrograms: [ { id, rootFiles: rootNames, compilerOptions: this.#compilerOptions, options: this.#programOptions() } ] } : {}),
			ensurePrograms: [ id ]
		});
		this.#rootNamesChanged = false;
		this.#clearNotifications();

		const program = snapshot.getProgram(id);
		if (program === undefined) {
			snapshot.dispose();
			throw new Error(`TypeScript program ${id} is missing from the updated snapshot.`);
		}

		this.#generation = { snapshot, program };
		this.#dependencies = undefined;
	}

	/**
	 * Type-checks the program and emits declarations in a single batched round trip.
	 * Declarations are emitted only when `declaration` is enabled and `noEmit` is off; declaration diagnostics are checked separately under `noEmit`.
	 * @returns Diagnostics, emitted declaration text and, when error-free, the input manifest
	 */
	compile(): CompilationResult {
		const startedAt = Date.now();
		const { program } = this.#generation ??= this.#createGeneration();
		const { declaration, noEmit } = this.#compilerOptions;

		const [ programDiagnostics, syntacticDiagnostics, globalDiagnostics, semanticDiagnostics, sourceFileNames, { emitOutput, declarationDiagnostics } ] = this.#api.batch(
			program.getProgramDiagnostics.gen(),
			program.getSyntacticDiagnostics.gen(),
			program.getGlobalDiagnostics.gen(),
			program.getSemanticDiagnostics.gen(),
			program.getSourceFileNames.gen(),
			declarationStep(program, declaration === true, noEmit === true)
		);

		this.#sourceFileNames = sourceFileNames;

		const diagnostics = [
			...this.#configFileParsingDiagnostics,
			...programDiagnostics,
			...syntacticDiagnostics,
			...globalDiagnostics,
			...semanticDiagnostics,
			...(declarationDiagnostics ?? []),
			...(emitOutput?.diagnostics ?? [])
		];

		const declarations = new Map<AbsolutePath, string>();
		if (emitOutput !== undefined) {
			for (const [ path, { text } ] of emitOutput.outputFiles) {
				if (path.endsWith(FileExtension.DTS)) { declarations.set(path as string as AbsolutePath, text) }
			}
		}

		return { diagnostics, declarations, manifest: diagnostics.length === 0 && this.#compilerOptions.incremental ? this.#createManifest(sourceFileNames, startedAt) : undefined };
	}

	/**
	 * Adopts the inputs of a previous error-free compilation whose inputs are unchanged, so watch dependencies are known without compiling.
	 * @param manifest - Up-to-date input manifest
	 */
	restore({ files }: BuildInputManifest): void {
		this.#sourceFileNames = files.map(([ path ]) => path);
		this.#dependencies = undefined;
	}

	/** Returns project source dependencies of the last compilation (project files that are not declarations). */
	get dependencies(): ReadonlySet<RelativePath> {
		if (this.#dependencies === undefined) {
			const dependencies = new Set<RelativePath>();
			const dirWithSlash = this.#directory + '/';
			for (const fileName of this.#sourceFileNames) {
				if (fileName.startsWith(dirWithSlash) && !fileName.endsWith(FileExtension.DTS)) { dependencies.add(Paths.relative(this.#directory, fileName)) }
			}
			this.#dependencies = dependencies;
		}

		return this.#dependencies;
	}

	/** Releases the current generation and pending state after build work has drained. */
	clear(): void {
		this[Symbol.dispose]();
	}

	/** Disposes the current snapshot, releasing the program and its checker state in the compiler process. */
	[Symbol.dispose](): void {
		const generation = this.#generation;
		this.#generation = undefined;
		this.#dependencies = undefined;
		this.#sourceFileNames = [];
		this.#clearNotifications();
		generation?.snapshot.dispose();
	}

	/** Creates the first generation: a snapshot containing a single synthetic program for the project. */
	#createGeneration(): Generation {
		const snapshot = this.#api.createSnapshot({ createPrograms: [ { rootFiles: this.#rootNames, compilerOptions: this.#compilerOptions, options: this.#programOptions() } ] });
		this.#rootNamesChanged = false;
		this.#clearNotifications();

		return { snapshot, program: snapshot.operation.createdPrograms[0] };
	}

	/** Program options shared by creation and reconfiguration. */
	#programOptions() {
		return this.#projectReferences === undefined ? undefined : { projectReferences: [ ...this.#projectReferences ] };
	}

	/** Resets pending watcher notifications. */
	#clearNotifications() {
		this.#notifications = { changed: [], created: [], deleted: [] };
	}

	/**
	 * Records the stat signature of every program input. An input modified after compilation started may not match what the
	 * compiler read, so it is recorded as unverifiable and the next build recompiles.
	 * @param fileNames - Every source file of the program, including libs and dependency declarations
	 * @param startedAt - Epoch milliseconds captured before the compiler read any input
	 */
	#createManifest(fileNames: readonly string[], startedAt: number): BuildInputManifest {
		const files: BuildInputStat[] = [];
		for (const path of fileNames) {
			const stats = statSync(path, { throwIfNoEntry: false });
			if (stats !== undefined) { files.push([ path, stats.mtimeMs < startedAt ? stats.mtimeMs : unverifiable, stats.size ]) }
		}

		return { key: this.manifestKey, files };
	}
}
