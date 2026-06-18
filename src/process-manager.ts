import { Logger } from 'src/logger';
import type { Closable } from './@types';

const ProcessEvent = {
	exit: 'exit',
	sigint: 'SIGINT',
	uncaughtException: 'uncaughtException'
} as const;

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

		// Perform cleanup for all registered closeable classes
		for (const closeable of this.#closeableClasses) { closeable.close() }

		this.close();
	};

	/** Handles SIGINT (ctrl+c) */
	#consoleExit = () => {
		Logger.warn('\nProcess terminated by user');
		this.#hasHandledExit = true;

		// Perform cleanup immediately
		for (const closeable of this.#closeableClasses) { closeable.close() }

		this.close();

		// Exit with standard SIGINT exit code (128 + 2 = 130)
		// This is the conventional exit code for processes terminated by SIGINT
		process.exit(130);
	};

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