import { Paths } from '../paths';
import { Logger } from '../logger';
import { defaultSourceDirectory } from '../constants';
import { flushPerformanceLog } from '../decorators/performance-logger';
import type { Watchr, WatchrStats, FileSystemEvent, WatchrEventHandler } from '@d1g1tal/watchr';
import type { AbsolutePath, RelativePath, ProjectBuildConfiguration } from '../@types';

export type FileSystemEventHandler = (event: FileSystemEvent, stats: WatchrStats, path: AbsolutePath, nextPath?: AbsolutePath) => void;

/** Immutable configuration and event boundary for a project's watcher. */
export type ProjectWatcherOptions = {
	directory: AbsolutePath;
	include?: readonly string[];
	exclude?: readonly string[];
	watch: ProjectBuildConfiguration['watch'];
	onChange: FileSystemEventHandler;
};

const globCharacters = /[*?\\[\]!].*$/;

/** Owns watch targets, watcher readiness, and watcher shutdown for a project. */
export class ProjectWatcher {
	#fileWatcher?: Watchr;
	#watchedPaths: readonly AbsolutePath[] = [];
	#closed = false;
	readonly #options: ProjectWatcherOptions;

	/**
	 * Creates a watcher owner without starting filesystem observation.
	 * @param options - Project paths, watch configuration, and event callback
	 */
	constructor(options: ProjectWatcherOptions) {
		this.#options = options;
	}

	/**
	 * Reuses or replaces the watcher to cover source and local plugin dependencies.
	 * @param pluginDependencies - Plugin dependency paths relative to the project directory
	 * @returns A promise that resolves after a new watcher's initial scan, or immediately when reused or closed
	 */
	async reconcile(pluginDependencies: ReadonlySet<RelativePath>): Promise<void> {
		// If the watcher was closed while we were waiting for the Watchr module to load, don't start a new watcher.
		if (this.#closed) { return }

		const { Watchr } = await import('@d1g1tal/watchr');

		// Check again after the async import in case the watcher was closed while we were waiting for the module to load.
		if (this.#closed) { return }

		const { directory, include, exclude, watch, onChange } = this.#options;
		const targets: AbsolutePath[] = [];
		const addTarget = (candidate: AbsolutePath) => {
			if (targets.some((existing) => candidate === existing || candidate.startsWith(`${existing}/`))) { return }
			targets.push(candidate);
		};

		for (const path of include ?? [ defaultSourceDirectory ]) {
			addTarget(Paths.absolute(directory, path.replace(globCharacters, '')));
		}

		for (const dependency of pluginDependencies) { addTarget(Paths.absolute(directory, dependency)) }

		// Reuse the existing watcher if the watched paths haven't changed.
		if (this.#fileWatcher !== undefined && this.#fileWatcher.state !== 'closed' && targets.length === this.#watchedPaths.length && targets.every(this.#targetIsWatched, this)) {
			return await this.#start(this.#fileWatcher);
		}

		this.#fileWatcher?.close();
		this.#fileWatcher = undefined;
		this.#watchedPaths = targets;

		if (targets.length === 0) { return }

		const pathsToIgnore = [ ...exclude ?? [], ...watch.ignore ?? [] ];
		const ignore = (path: string) => pathsToIgnore.some((pattern) => path.includes(`/${pattern}/`) || path.endsWith(`/${pattern}`));

		// watchr reports plain strings; they are always absolute since targets are built from Paths.absolute()
		const fileSystemEventHandler: WatchrEventHandler = (event) => {
			if (event.type === 'rename' || event.type === 'renameDir') {
				onChange(event.type, event.stats, event.from as AbsolutePath, event.to as AbsolutePath);
			} else {
				onChange(event.type, event.stats, event.path as AbsolutePath, undefined);
			}
		};
		const { enabled: _enabled, renameTimeout = 25, ...watchOptions } = watch;
		const fileWatcher = new Watchr(targets, { ...watchOptions, renameTimeout, ignore, handlers: { all: fileSystemEventHandler, error: (error) => Logger.error(`Watcher error: ${error.message}`) } });

		this.#fileWatcher = fileWatcher;

		await this.#start(fileWatcher);

		// Notify that the watcher has started and is actively watching the specified targets.
		setImmediate(() => {
			if (this.#closed || this.#fileWatcher !== fileWatcher || fileWatcher.state !== 'watching') { return }

			flushPerformanceLog();
			Logger.info(`Watching for changes in: ${targets.join(', ')}`);
		});
	}

	/**
	 * Awaits startup while allowing terminal owner shutdown to cancel it.
	 * @param fileWatcher - The watcher whose startup is owned by this project
	 */
	async #start(fileWatcher: Watchr): Promise<void> {
		try { await fileWatcher.start() } catch (error) {
			if (this.#closed && Error.isError(error) && error.message === 'watcher closed before becoming ready.') { return }
			throw error;
		}
	}

	/**
	 * Checks if the given target is currently being watched at the specified index.
	 * @param target - The target path to check.
	 * @param index - The index at which to check the target.
	 * @returns `true` if the target is being watched at the specified index, otherwise `false`.
	 */
	#targetIsWatched = (target: AbsolutePath, index: number) => target === this.#watchedPaths[index];

	/** Stops the current watcher immediately and permanently disables reconciliation. */
	close(): void {
		if (this.#closed) { return }

		this.#closed = true;
		this.#fileWatcher?.close();
		this.#watchedPaths = [];
	}
}