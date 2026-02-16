import { castError } from 'src/errors';
import { closeOnExit } from './close-on-exit';
import type { Function, Closable, MethodFunction, OptionalReturn, TypedFunction, InferredFunction } from 'src/@types';

/**
 * Factory class to create debounced functions and ensure they are cleaned up on exit.
 */
@closeOnExit
class DebounceManager implements Closable {
	private static readonly timers = new Set<NodeJS.Timeout>();

	/**
	 * Creates a debounced version of a function.
	 * @param func - The function to debounce.
	 * @param wait - The number of milliseconds to wait before invoking the function.
	 * @returns A debounced version of the function that returns a Promise.
	 */
	debounce<T extends TypedFunction<T>>(func: T, wait: number): InferredFunction {
		let timeoutId: NodeJS.Timeout | undefined;
		let pendingResolve: Function<OptionalReturn<T>, void> | undefined;

		return function(this: ThisParameterType<T>, ...args: Parameters<T>): Promise<OptionalReturn<T>> {
			return new Promise((resolve, reject) => {
				// Clear previous timer
				if (timeoutId) {
					clearTimeout(timeoutId);
					DebounceManager.timers.delete(timeoutId);
				}

				// Cancel previous promise immediately
				if (pendingResolve) { pendingResolve(undefined) }

				pendingResolve = resolve;

				timeoutId = setTimeout(() => {
					if (timeoutId) { DebounceManager.timers.delete(timeoutId) }

					try {
						resolve(func.apply(this, args));
					} catch (error) {
						// Use the provided castError to standardize the rejection
						reject(castError(error));
					} finally {
						// Cleanup to prevent memory leaks
						pendingResolve = undefined;
						timeoutId = undefined;
					}
				}, wait);

				DebounceManager.timers.add(timeoutId);
			});
		};
	}

	/** Closes the manager by clearing all active timers. */
	close(): void {
		for (const timer of DebounceManager.timers) { clearTimeout(timer) }
		DebounceManager.timers.clear();
	}
}

const debounceManager = new DebounceManager();

/**
 * Debounces an async method. Can only be applied to methods that return a Promise.
 *
 * @param wait - The wait time in milliseconds
 * @returns A method decorator that debounces an async method
 */
export function debounce(wait: number) {
	if (wait < 0) { throw new Error('🚨 wait must be non-negative.') }

	return function(targetMethod: MethodFunction, context: ClassMethodDecoratorContext): MethodFunction {
		context.addInitializer(function() {
			Object.defineProperty(this, context.name, { writable: true, configurable: true, value: debounceManager.debounce(targetMethod.bind(this), wait) });
		});

		return targetMethod;
	};
}
