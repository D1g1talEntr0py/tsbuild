import { TextFormat } from 'src/text-formatter';
import { Logger } from 'src/logger';
import { closeOnExit } from './close-on-exit';
import { PerformanceObserver, performance } from 'perf_hooks';
import type { PerformanceMeasureOptions, DetailedPerformanceEntry, Closable, WrittenFile, MethodFunction } from 'src/@types';

const type = 'measure';

/** A class that logs the performance of methods using the Performance API */
@closeOnExit
class PerformanceLogger implements Closable {
	private readonly performanceObserver: PerformanceObserver;

	constructor() {
		this.performanceObserver = new PerformanceObserver((list): void => {
			// Reverse the list to display the most recent entries first
			for (const { name, duration, detail: { message, result = [] } } of list.getEntriesByType(type).reverse() as DetailedPerformanceEntry<WrittenFile[]>[]) {
				// Special formatting for top-level "Build" step ⚡
				if (message === 'Build') {
					Logger.separator();
					// Check if build failed by examining process.exitCode
					if (process.exitCode) {
						Logger.error(`✗ Build failed in ${TextFormat.cyan(PerformanceLogger.formatDuration(duration))}\n`);
					} else {
						Logger.step(`Completed in ${TextFormat.cyan(PerformanceLogger.formatDuration(duration))}\n`);
					}
				} else {
					Logger.step(`${message} ${TextFormat.dim(`(${PerformanceLogger.formatDuration(duration)})`)}`);

					// If there are result files, log them with tree formatting
					if (result.length > 0) { Logger.success('', ...result) }
				}

				performance.clearResourceTimings(name);
			}
		});

		this.performanceObserver.observe({ type });
	}

	/**
	 * Measures the performance of a method and logs the result.
	 * @param message - The message to log with the performance measurement.
	 * @param logResult - Whether to log the result of the method.
	 * @returns A Stage 3 method decorator that measures the performance of the method it decorates.
	 */
	measure(message: string, logResult: boolean = false) {
		const _measure = <R>(propertyKey: string, result: R, options: PerformanceMeasureOptions<R>): R => {
			if (logResult) { options.detail.result = result }

			({ startTime: options.end } = performance.mark(propertyKey));
			performance.measure(propertyKey, options);

			return result;
		};

		// Stage 3 decorator function
		return function<T, A extends unknown[], R>(targetMethod: MethodFunction<T, A, R>, context: ClassMethodDecoratorContext<T, MethodFunction<T, A, R>>): MethodFunction<T, A, R> {
			const propertyKey = String(context.name);

			/**
			 * Wraps the target method to measure its performance.
			 * @param args - The arguments to pass to the target method.
			 * @returns The result of the target method.
			 */
			return function(this: T, ...args: A): R {
				const options: PerformanceMeasureOptions<R> = { start: performance.mark(propertyKey).startTime, detail: { message } };
				const result = targetMethod.apply(this, args);

				return result instanceof Promise ? result.then((r: R) => _measure(propertyKey, r, options)) as R : _measure(propertyKey, result, options);
			};
		};
	}

	/**
	 * Closes the performance logger.
	 */
	close(): void {
		this.performanceObserver.disconnect();
	}

	/**
	 * Formats the duration into a human-readable string.
	 * @param duration - The duration to format.
	 * @returns The formatted duration string.
	 */
	private static formatDuration(duration: number): string {
		const minutes = ~~(duration / 60000) % 60;
		const seconds = ~~(duration / 1000) % 60;
		const ms = ~~duration % 1000;

		if (minutes > 0) { return `${minutes}m${seconds}s${ms}ms` }
		if (seconds > 0) { return `${seconds}s${ms}ms` }

		return `${ms}ms`;
	}
}

const measure: typeof PerformanceLogger.prototype.measure = new PerformanceLogger().measure;

export { measure as logPerformance };