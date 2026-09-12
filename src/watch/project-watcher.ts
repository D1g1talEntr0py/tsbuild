import { Paths } from '../paths';
import { Logger } from '../logger';
import { defaultSourceDirectory } from '../constants';
import { flushPerformanceLog } from '../decorators/performance-logger';
import type { Watchr, WatchrStats, FileSystemEvent } from '@d1g1tal/watchr';
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
		const addTarget = (candidate: AbsolutePath): void => {
			if (targets.some((existing) => candidate === existing || candidate.startsWith(`${existing}/`))) { return }
			targets.push(candidate);
		};

		for (const path of include ?? [ defaultSourceDirectory ]) {
			addTarget(Paths.absolute(directory, path.replace(globCharacters, '')));
		}

		for (const dependency of pluginDependencies) { addTarget(Paths.absolute(directory, dependency)) }

		if (this.#fileWatcher !== undefined && !this.#fileWatcher.isClosed() && targets.length === this.#watchedPaths.length && targets.every((target, index) => target === this.#watchedPaths[index])) {
			return;
		}

		this.#fileWatcher?.close();
		const pathsToIgnore = [ ...exclude ?? [], ...watch.ignore ?? [] ];
		const ignore = (path: string) => pathsToIgnore.some((pattern) => path.includes(`/${pattern}/`) || path.endsWith(`/${pattern}`));
		// watchr reports plain strings; they are always absolute since targets are built from Paths.absolute()
		const fileSystemEventHandler = (event: FileSystemEvent, stats: WatchrStats, path: string, nextPath?: string) => onChange(event, stats, path as AbsolutePath, nextPath as AbsolutePath | undefined);

		this.#fileWatcher = new Watchr(targets, { ...watch, ignore }, fileSystemEventHandler);
		this.#watchedPaths = targets;

		await this.#fileWatcher.readyLock;

		setImmediate(() => {
			if (this.#fileWatcher?.isClosed() ?? true) { return }

			flushPerformanceLog();
			Logger.info(`Watching for changes in: ${targets.join(', ')}`);
		});
	}

	/** Stops the current watcher immediately and permanently disables reconciliation. */
	close(): void {
		if (this.#closed) { return }

		this.#closed = true;
		this.#fileWatcher?.close();
		this.#watchedPaths = [];
	}
}