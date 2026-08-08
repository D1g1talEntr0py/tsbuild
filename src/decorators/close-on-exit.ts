import { processManager } from '../process-manager';
import type { ClosableConstructor } from '../@types';

/**
 * Decorator to automatically close the instance on process exit.
 * Stage 3 decorator that registers the instance with the process manager after construction.
 * @param value - The constructor of the class to decorate
 * @param _context - The decorator context (unused)
 */
export function closeOnExit<T extends ClosableConstructor>(value: T, _context: ClassDecoratorContext): T {
	// Return a new class that extends the original and registers with processManager
	return class extends value {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		constructor(...args: any[]) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-argument
			super(...args);
			processManager.addCloseable(this);
		}
	};
}