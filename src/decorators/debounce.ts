import { castError } from 'src/errors';
import { closeOnExit } from './close-on-exit';
import type { Fn, Closable, MethodFunction, OptionalReturn, InferredFunction } from 'src/@types';

/**
 * Factory class to create debounced functions and ensure they are cleaned up on exit.
 */
@closeOnExit
class DebounceManager implements Closable {
	static readonly #timers = new Set<NodeJS.Timeout>();

	/**
	 * Creates a debounced version of a function.
	 * @param func - The function to debounce.
	 * @param wait - The number of milliseconds to wait before invoking the function.
	 * @returns A debounced version of the function that returns a Promise.
	 */
	debounce<T extends (...args: unknown[]) => OptionalReturn<T> | PromiseLike<OptionalReturn<T>>>(func: T, wait: number): InferredFunction {
		let timeoutId: NodeJS.Timeout | undefined;
		let pendingResolve: Fn<OptionalReturn<T>, void> | undefined;

		return function(this: ThisParameterType<T>, ...args: Parameters<T>) {
			return new Promise((resolve, reject) => {
				// Clear previous timer
				if (timeoutId) {
					clearTimeout(timeoutId);
					DebounceManager.#timers.delete(timeoutId);
				}

				// Cancel previous promise immediately
				if (pendingResolve) { pendingResolve(undefined) }

				pendingResolve = resolve;

				timeoutId = setTimeout(() => {
					if (timeoutId) { DebounceManager.#timers.delete(timeoutId) }

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

				DebounceManager.#timers.add(timeoutId);
			});
		};
	}

	/** Closes the manager by clearing all active timers. */
	close(): void {
		for (const timer of DebounceManager.#timers) { clearTimeout(timer) }
		DebounceManager.#timers.clear();
	}
}

const debounceManager: DebounceManager = new DebounceManager();
export { debounceManager };

/**
 * Debounces an async method. Can only be applied to methods that return a Promise.
 *
 * @param wait - The wait time in milliseconds
 * @returns A method decorator that debounces an async method
 */
export function debounce(wait: number) {
	if (wait < 0) { throw new Error('🚨 wait must be non-negative.') }

	return function(targetMethod: MethodFunction, context: ClassMethodDecoratorContext): MethodFunction {
		if (!context.private) {
			context.addInitializer(function(this: ThisParameterType<MethodFunction>) {
				Object.defineProperty(this, context.name, { writable: true, configurable: true, value: debounceManager.debounce(targetMethod.bind(this), wait) });
			});

			return targetMethod;
		}

		type DebouncedMethod = (...args: unknown[]) => Promise<unknown>;
		const debouncedMethodKey = Symbol(String(context.name));
		const createDebouncedMethod = (instance: object): DebouncedMethod => debounceManager.debounce((...args: unknown[]) => targetMethod.apply(instance, args) as unknown, wait) as DebouncedMethod;
		context.addInitializer(function(this: ThisParameterType<MethodFunction>) {
			Object.defineProperty(this, debouncedMethodKey, { configurable: true, value: createDebouncedMethod(this as object) });
		});

		return function(this: ThisParameterType<MethodFunction>, ...args: unknown[]) {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
			const debouncedMethod = this[debouncedMethodKey] as DebouncedMethod | undefined;
			if (debouncedMethod === undefined) { throw new Error('🚨 Debounced private method was not initialized.') }

			return debouncedMethod(...args);
		};
	};
}
