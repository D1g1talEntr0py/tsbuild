import { TextFormat } from '../text-formatter';
import { Logger } from '../logger';
import { closeOnExit } from './close-on-exit';
import { PerformanceObserver, performance, type PerformanceEntryList } from 'perf_hooks';
import type { PerformanceMeasureOptions, DetailedPerformanceEntry, Closable, WrittenFile, MethodFunction } from '../@types';

const type = 'measure';

/** A class that logs the performance of methods using the Performance API */
@closeOnExit
class PerformanceLogger implements Closable {
	readonly #performanceObserver: PerformanceObserver;

	constructor() {
		this.#performanceObserver = new PerformanceObserver((list) => this.#logEntries(list.getEntriesByType(type)));
		this.#performanceObserver.observe({ type });
	}

	/**
	 * Logs measurement entries, most recent first.
	 * @param entries - Chronologically ordered measure entries
	 */
	#logEntries(entries: PerformanceEntryList): void {
		// Reverse the list to display the most recent entries first
		for (const { name, duration, detail: { message, result = [], steps } } of entries.reverse() as DetailedPerformanceEntry<WrittenFile[]>[]) {
			// Special formatting for top-level "Build" step ⚡
			if (message === 'Build') {
				Logger.separator();
				if (process.exitCode) {
					Logger.error(`✗ Build failed in ${TextFormat.cyan(PerformanceLogger.#formatDuration(duration))}\n`);
				} else {
					Logger.step(`Completed in ${TextFormat.cyan(PerformanceLogger.#formatDuration(duration))}\n`);
				}
			} else {
				Logger.step(`${message} ${TextFormat.dim(`(${PerformanceLogger.#formatDuration(duration)})`)}`);
				if (steps?.length) { Logger.subSteps(steps) }

				// If there are result files, log them with tree formatting
				if (result.length > 0) { Logger.success('', ...result) }
			}

			// Clear the marks and measures for this entry to avoid memory leaks
			performance.clearMeasures(name);
			performance.clearMarks(name);
		}
	}

	/** Synchronously logs any measurements still queued for async observer delivery. */
	flush(): void {
		this.#logEntries(this.#performanceObserver.takeRecords());
	}

	/**
	 * Measures the performance of a method and logs the result.
	 * @param message - The message to log with the performance measurement
	 * @returns A Stage 3 method decorator that measures execution time of the decorated method
	 */
	measure(message: string) {
		const _measure = <R>(propertyKey: string, result: R, options: PerformanceMeasureOptions<R>): R => {
			options.detail.result = result;

			({ startTime: options.end } = performance.mark(propertyKey));
			performance.measure(propertyKey, options);

			return result;
		};

		// Stage 3 decorator function
		return function<T, A extends unknown[], R>(targetMethod: MethodFunction<T, A, R>, context: ClassMethodDecoratorContext<T, MethodFunction<T, A, R>>): MethodFunction<T, A, R> {
			const propertyKey = String(context.name);
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
		this.#performanceObserver.disconnect();
	}

	/**
	 * Formats the duration into a human-readable string.
	 * @param duration - The duration to format.
	 * @returns The formatted duration string.
	 */
	static #formatDuration(duration: number) {
		const minutes = ~~(duration / 60000) % 60;
		const seconds = ~~(duration / 1000) % 60;
		const ms = ~~duration % 1000;

		if (minutes > 0) { return `${minutes}m${seconds}s${ms}ms` }
		if (seconds > 0) { return `${seconds}s${ms}ms` }

		return `${ms}ms`;
	}
}

const performanceLogger = new PerformanceLogger();
const measure: typeof PerformanceLogger.prototype.measure = performanceLogger.measure;

/** Synchronously logs any measurements still queued for async observer delivery. */
const flushPerformanceLog = (): void => performanceLogger.flush();

export { measure as logPerformance, flushPerformanceLog };