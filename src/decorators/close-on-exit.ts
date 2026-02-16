import { processManager } from 'src/process-manager';
import type { ClosableConstructor } from 'src/@types';

/**
 * Decorator to automatically close the instance on process exit.
 * Stage 3 decorator that registers the instance with the process manager after construction.
 * @param value The constructor of the class to decorate.
 * @param _context The context of the decorator (not used).
 * @returns The decorated class constructor.
 */
export function closeOnExit<T extends ClosableConstructor>(value: T, _context: ClassDecoratorContext): T {
	// Return a new class that extends the original and registers with processManager
	return class extends value {
		/**
		 * Creates an instance and registers it with the process manager.
		 * @param args Arguments to pass to the original constructor.
		 */
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		constructor(...args: any[]) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			super(...args);
			// Classes that extend Closable will have their 'close' method called on process exit
			processManager.addCloseable(this);
		}
	};
}