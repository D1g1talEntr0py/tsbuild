import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from './logger';
import type { Closable } from './@types';

const ProcessEvent = {
	exit: 'exit',
	sigint: 'SIGINT',
	uncaughtException: 'uncaughtException'
};
const sigintCleanupTimeoutMs = 5000;

/** Manages process events and allows registering closeable classes to be closed on exit */
class ProcessManager implements Closable {
	#hasHandledExit = false;
	readonly #closeableClasses: Closable[] = [];

	constructor() {
		process.addListener(ProcessEvent.exit, this.#handleExit);
		process.addListener(ProcessEvent.sigint, this.#consoleExit);
		process.addListener(ProcessEvent.uncaughtException, this.#handleUncaughtException);
	}

	/**
	 * Adds a closeable class to be closed on exit.
	 * @param closeable The closeable class to add.
	 */
	addCloseable(closeable: Closable): void {
		this.#closeableClasses.push(closeable);
	}

	/**
	 * Removes a previously added closeable so it is no longer retained or closed on exit.
	 * No-op if the closeable was not registered.
	 * @param closeable The closeable class to remove.
	 */
	removeCloseable(closeable: Closable): void {
		const index = this.#closeableClasses.indexOf(closeable);
		if (index !== -1) { this.#closeableClasses.splice(index, 1) }
	}

	/** Closes the process manager and removes all listeners */
	close(): void {
		this.#closeableClasses.length = 0;
		process.removeListener(ProcessEvent.exit, this.#handleExit);
		process.removeListener(ProcessEvent.sigint, this.#consoleExit);
		process.removeListener(ProcessEvent.uncaughtException, this.#handleUncaughtException);
	}

	/** Handles normal process exit */
	#handleExit = () => {
		if (this.#hasHandledExit) { return }

		this.#hasHandledExit = true;
		void this.#runCleanup().catch((error: unknown) => Logger.error('Error while closing resource...', error instanceof Error ? error.stack : error));
	};

	/** Handles SIGINT (ctrl+c) */
	#consoleExit = () => {
		this.#hasHandledExit = true;

		// Exit gracefully so package managers do not report a failed lifecycle when a user stops watch mode.
		void Promise.race([ this.#runCleanup(), delay(sigintCleanupTimeoutMs, undefined, { ref: false }) ]).then(() => process.exit(0), (error: unknown) => {
			Logger.error('Error while closing resource...', error instanceof Error ? error.stack : error);
			process.exit(0);
		});
	};

	/** Performs closeable cleanup and detaches process listeners. */
	async #runCleanup(): Promise<void> {
		const pendingCleanup: Promise<void>[] = [];

		for (const [ index, closeable ] of [ ...this.#closeableClasses ].entries()) {
			const resourceLabel = `${closeable.constructor.name || 'anonymous resource'} #${index + 1}`;

			try {
				const result = closeable.close();
				if (result !== undefined) {
					pendingCleanup.push(result.catch((error: unknown) => Logger.error(`Error while closing ${resourceLabel}...`, error instanceof Error ? error.stack : error)));
				}
			} catch (error) {
				Logger.error(`Error while closing ${resourceLabel}...`, error instanceof Error ? error.stack : error);
			}
		}
		this.close();
		await Promise.all(pendingCleanup);
	}

	/**
	 * Handles uncaught exceptions and exits the process.
	 * @param e The error that was uncaught.
	 */
	#handleUncaughtException = (e: Error) => {
		Logger.error('Uncaught Exception...', e.stack);
		process.exit(99);
	};
}

const processManager: ProcessManager = new ProcessManager();

export { processManager };