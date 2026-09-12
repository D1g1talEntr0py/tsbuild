import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Files } from '../files';
import { isErrnoException } from '../errors';
import type { WatchrStats, FileSystemEvent } from '@d1g1tal/watchr';
import type { AbsolutePath, PendingFileChange } from '../@types';

type ContentChangeSnapshot = { size: number; modifiedTimeMs: number };
type ContentChangeState = { digest: string; stats?: ContentChangeSnapshot };
interface QueuedPendingChange extends PendingFileChange {
	version: number;
}

/** Inputs needed to filter watcher events and dispatch serial rebuilds. */
export type RebuildQueueOptions = {
	renameTimeoutMs: number;
	sourceText: (path: AbsolutePath) => string | undefined;
	rebuild: (changes: ReadonlyArray<PendingFileChange>) => Promise<void>;
};

const pendingChangeKey = (event: FileSystemEvent, path: AbsolutePath): string => `${event}:${path}`;
const isRenameSuppressedEvent = (event: FileSystemEvent): boolean => event === 'change' || event === 'add' || event === 'addDir' || event === 'unlink' || event === 'unlinkDir';
const hasRenameChanges = (changes: ReadonlyArray<PendingFileChange>): boolean => changes.some(({ event, nextPath }) => nextPath !== undefined && isRenameEvent(event));
const isRenameEventFilter = ({ event, nextPath }: PendingFileChange) => nextPath !== undefined && isRenameEvent(event);

/**
 * Returns whether a watcher event renames a file or directory.
 * @param event - Watcher event type
 */
export function isRenameEvent(event: FileSystemEvent): boolean {
	return event === 'rename' || event === 'renameDir';
}

/**
 * Formats the observed watcher-change summary for rebuild logging.
 * @param changes - Filtered watcher changes that will be applied to the rebuild
 */
export function formatPendingChangeSummary(changes: ReadonlyArray<PendingFileChange>): string {
	const renamedFiles = changes.filter(isRenameEventFilter).length;
	if (renamedFiles > 0) { return `${renamedFiles} file${renamedFiles === 1 ? '' : 's'} renamed detected.` }

	return `${changes.length} file change${changes.length === 1 ? '' : 's'} detected.`;
}

/** Owns watcher-event deduplication, content filtering, and serial rebuild scheduling. */
export class RebuildQueue {
	readonly #options: RebuildQueueOptions;
	#rebuildDispatch: NodeJS.Timeout | undefined;
	#renameCycleTimer: NodeJS.Timeout | undefined;
	#renameCycleDeadline = 0;
	#queueRevision = 0;
	#dispatchRevision = 0;
	#rebuildInFlight = false;
	#rebuildPending = false;
	#stopped = false;
	readonly #pendingChanges: Map<string, QueuedPendingChange> = new Map();
	readonly #pendingChangeKeysByPath: Map<AbsolutePath, string> = new Map();
	readonly #pendingChangeStats: Map<AbsolutePath, ContentChangeSnapshot> = new Map();
	readonly #pendingChangeVersions: Map<AbsolutePath, number> = new Map();
	readonly #renameCyclePaths: Set<AbsolutePath> = new Set();
	readonly #contentStates: Map<AbsolutePath, ContentChangeState> = new Map();

	/**
	 * Creates a queue with the watcher rename-pairing timeout and project callbacks.
	 * @param options - Rename timeout, source-text lookup, and asynchronous rebuild callback
	 */
	constructor(options: RebuildQueueOptions) {
		this.#options = options;
	}

	/**
	 * Enqueues a watcher event, retaining the latest metadata for each path.
	 * Follow-up events for renamed paths are suppressed without dropping unrelated changes.
	 * @param event - Watcher event type
	 * @param stats - Watcher file stats snapshot
	 * @param path - Absolute path of changed file
	 * @param nextPath - Absolute rename target when applicable
	 */
	enqueue(event: FileSystemEvent, stats: WatchrStats | undefined, path: AbsolutePath, nextPath?: AbsolutePath): void {
		if (this.#stopped) { return }
		const renameCycleActive = this.#isRenameCycleActive();
		const followsActiveRename = this.#renameCyclePaths.has(path) || (nextPath !== undefined && this.#renameCyclePaths.has(nextPath));

		if (followsActiveRename && (this.#rebuildInFlight || renameCycleActive)) { return }

		if (!renameCycleActive && this.#renameCyclePaths.size > 0) { this.#renameCyclePaths.clear() }

		if (isRenameEvent(event)) {
			this.#activateRenameCycle();
			this.#renameCyclePaths.add(path);
			if (nextPath !== undefined) { this.#renameCyclePaths.add(nextPath) }
		} else if (this.#renameCyclePaths.has(path) || (nextPath !== undefined && this.#renameCyclePaths.has(nextPath))) {
			return;
		}

		const version = (this.#pendingChangeVersions.get(path) ?? 0) + 1;
		this.#pendingChangeVersions.set(path, version);

		if (stats !== undefined) {
			this.#pendingChangeStats.set(path, { size: stats.size, modifiedTimeMs: stats.modifiedTimeMs });
		} else {
			this.#pendingChangeStats.delete(path);
		}

		const relatedKeys = new Set<string>();
		const pathKey = this.#pendingChangeKeysByPath.get(path);
		if (pathKey !== undefined) { relatedKeys.add(pathKey) }

		if (nextPath !== undefined) {
			const nextPathKey = this.#pendingChangeKeysByPath.get(nextPath);
			if (nextPathKey !== undefined) { relatedKeys.add(nextPathKey) }
		}

		const mapPendingChange = (key: string) => this.#pendingChanges.get(key);
		const hasNextPath = (change: QueuedPendingChange | undefined) => change?.nextPath !== undefined;

		if (Array.from(relatedKeys, mapPendingChange).some(hasNextPath) && isRenameSuppressedEvent(event)) { return }

		for (const key of relatedKeys) { this.#deletePendingChange(key) }

		const key = pendingChangeKey(event, path);
		this.#pendingChanges.set(key, { event, path, nextPath, version });
		this.#pendingChangeKeysByPath.set(path, key);
		if (nextPath !== undefined) { this.#pendingChangeKeysByPath.set(nextPath, key) }

		this.#queueRevision++;
		this.#requestRebuild();
	}

	/** Permanently closes the queue and synchronously cancels delayed dispatch. */
	stop(): void {
		this.#stopped = true;

		if (this.#rebuildDispatch !== undefined) {
			clearTimeout(this.#rebuildDispatch);
			this.#rebuildDispatch = undefined;
		}

		if (this.#renameCycleTimer !== undefined) {
			clearTimeout(this.#renameCycleTimer);
			this.#renameCycleTimer = undefined;
		}

		this.#rebuildPending = false;
	}

	/** Releases retained state after the owner has stopped the queue and drained its build. */
	clear(): void {
		this.#renameCyclePaths.clear();
		this.#queueRevision = 0;
		this.#dispatchRevision = 0;
		this.#pendingChangeStats.clear();
		this.#pendingChangeVersions.clear();
		this.#pendingChangeKeysByPath.clear();
		this.#contentStates.clear();
		this.#pendingChanges.clear();
	}

	/**
	 * Transfers rename content state or forgets an unlink once the project applies that operation.
	 * The owner acknowledges renames after context invalidation and unlinks only when removing a root.
	 * @param change - Applied rename or root unlink
	 */
	markApplied(change: PendingFileChange): void {
		if (this.#stopped) { return }
		const { event, path, nextPath } = change;
		if (nextPath !== undefined && isRenameEvent(event)) {
			const previousState = this.#contentStates.get(path);
			if (previousState !== undefined) {
				this.#contentStates.delete(path);
				this.#contentStates.set(nextPath, previousState);
			}
		} else if (event === 'unlink') {
			this.#contentStates.delete(path);
		}
	}

	/**
	 * Removes a queued change and its path-index entries.
	 * @param key - Pending-change map key to remove
	 */
	#deletePendingChange(key: string) {
		const change = this.#pendingChanges.get(key);

		if (change === undefined) { return }

		this.#pendingChanges.delete(key);

		if (this.#pendingChangeKeysByPath.get(change.path) === key) { this.#pendingChangeKeysByPath.delete(change.path) }

		if (change.nextPath !== undefined && this.#pendingChangeKeysByPath.get(change.nextPath) === key) { this.#pendingChangeKeysByPath.delete(change.nextPath) }
	}

	/** Starts or extends the suppression window for follow-up edits to renamed paths. */
	#activateRenameCycle() {
		if (this.#stopped) { return }

		const timeoutMs = this.#options.renameTimeoutMs;
		this.#renameCycleDeadline = performance.now() + timeoutMs;

		if (this.#renameCycleTimer !== undefined) { clearTimeout(this.#renameCycleTimer) }

		this.#renameCycleTimer = setTimeout(() => {
			if (!this.#isRenameCycleActive()) {
				this.#renameCyclePaths.clear();
				this.#renameCycleTimer = undefined;
			}
		}, timeoutMs + 1);
	}

	/** Returns whether the rename suppression deadline has not yet passed. */
	#isRenameCycleActive() {
		return performance.now() <= this.#renameCycleDeadline;
	}

	/** Queues one rebuild after Watchr's rename-pairing window. */
	#requestRebuild() {
		if (this.#stopped) { return }

		if (this.#rebuildInFlight) {
			this.#rebuildPending = true;
			return;
		}

		if (this.#pendingChanges.size === 0) { return }

		if (this.#rebuildDispatch !== undefined) {
			if (!this.#isRenameCycleActive()) { return }

			clearTimeout(this.#rebuildDispatch);
			this.#rebuildDispatch = undefined;
		}

		this.#rebuildDispatch = setTimeout(() => {
			this.#rebuildDispatch = undefined;
			this.#dispatchRevision = this.#queueRevision;
			void this.#triggerRebuild(this.#dispatchRevision);
		}, this.#options.renameTimeoutMs + 1);
	}

	/**
	 * Waits one event-loop turn and confirms the queue has not changed.
	 * @param expectedRevision - Queue revision captured after collection
	 */
	async #awaitQueueStability(expectedRevision: number): Promise<boolean> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		return this.#queueRevision === expectedRevision;
	}

	/**
	 * Drains and stabilizes pending events before invoking the serial rebuild callback.
	 * @param expectedRevision - Queue revision captured at dispatch
	 */
	async #triggerRebuild(expectedRevision: number) {
		if (this.#stopped || this.#pendingChanges.size === 0) { return }

		if (this.#queueRevision !== expectedRevision) {
			this.#requestRebuild();
			return;
		}

		if (this.#rebuildInFlight) {
			this.#rebuildPending = true;
			return;
		}

		this.#rebuildInFlight = true;
		let includesRenameChange = false;

		try {
			const pendingFileChanges = await this.#collectPendingFileChanges();

			// If the queue changed during collection, schedule another rebuild to catch any new changes.
			if (this.#stopped) { return }

			includesRenameChange = hasRenameChanges(pendingFileChanges);

			if (includesRenameChange) { this.#activateRenameCycle() }

			const settledRevision = this.#queueRevision;
			if (settledRevision !== expectedRevision && this.#pendingChanges.size > 0) {
				this.#requestRebuild();
				return;
			}

			if (pendingFileChanges.length === 0) { return }

			const stable = await this.#awaitQueueStability(settledRevision);

			// If the queue changed during the rebuild, schedule another rebuild to catch any new changes.
			if (this.#stopped) { return }

			if (!stable) {
				this.#requestRebuild();
				return;
			}

			await this.#options.rebuild(pendingFileChanges);
		} finally {
			this.#rebuildInFlight = false;

			if (includesRenameChange) { this.#activateRenameCycle() }

			if (!this.#isRenameCycleActive()) { this.#renameCyclePaths.clear() }

			if (this.#rebuildPending) {
				this.#rebuildPending = false;
				this.#requestRebuild();
			}
		}
	}

	/** Drains queued watcher events, including events arriving during content hashing. */
	async #collectPendingFileChanges() {
		const pendingFileChanges: QueuedPendingChange[] = [];
		while (this.#pendingChanges.size > 0) {
			const queuedChanges = [ ...this.#pendingChanges.values() ];

			this.#pendingChanges.clear();
			this.#pendingChangeKeysByPath.clear();

			for (const change of queuedChanges) {
				const modified = await this.#isContentModified(change);

				if (this.#stopped) { return [] }

				if (modified) { pendingFileChanges.push(change) }
			}
		}

		return pendingFileChanges;
	}

	/**
	 * Filters unchanged size/mtime or bytes, ignoring superseded hashes and missing paths.
	 * Size changes bypass hashing; other read failures remain meaningful changes.
	 * @param change - Versioned pending watcher event
	 */
	async #isContentModified(change: QueuedPendingChange) {
		const { event, path, nextPath, version } = change;

		if (nextPath !== undefined || event !== 'change') { return true }

		try {
			if (this.#pendingChangeVersions.get(path) !== version) { return false }

			const stats = this.#pendingChangeStats.get(path);
			const previousState = this.#contentStates.get(path);

			if (stats?.size !== undefined && stats.modifiedTimeMs !== undefined && previousState?.stats?.size === stats.size && previousState.stats.modifiedTimeMs === stats.modifiedTimeMs) {
				if (this.#pendingChangeVersions.get(path) === version) { this.#pendingChangeStats.delete(path) }
				return false;
			}

			if (stats?.size !== undefined && previousState?.stats?.size !== undefined && previousState.stats.size !== stats.size) {
				this.#contentStates.set(path, { digest: previousState.digest, stats });
				if (this.#pendingChangeVersions.get(path) === version) { this.#pendingChangeStats.delete(path) }
				return true;
			}

			const digest = createHash('sha1').update(await Files.read(path)).digest('hex');

			if (this.#stopped || this.#pendingChangeVersions.get(path) !== version) { return false }

			if (previousState === undefined) {
				const sourceText = this.#options.sourceText(path);
				if (sourceText !== undefined) {
					if (digest === createHash('sha1').update(sourceText).digest('hex')) {
						this.#contentStates.set(path, { digest, stats });
						this.#pendingChangeStats.delete(path);
						return false;
					}
				}
			}

			this.#contentStates.set(path, { digest, stats });
			this.#pendingChangeStats.delete(path);

			return previousState === undefined || previousState.digest !== digest;
		} catch (error) {
			if (this.#stopped) { return false }

			const code = isErrnoException(error) ? error.code : undefined;

			if (code === 'ENOENT') {
				if (this.#pendingChangeVersions.get(path) === version) { this.#pendingChangeStats.delete(path) }
				return false;
			}

			if (this.#pendingChangeVersions.get(path) === version) { this.#pendingChangeStats.delete(path) }

			return true;
		}
	}
}