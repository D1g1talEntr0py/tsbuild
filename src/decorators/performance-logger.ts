import { TextFormat } from '../text-formatter';
import { Logger } from '../logger';
import { isWrittenFiles } from '../files';
import { closeOnExit } from './close-on-exit';
import { PerformanceObserver, performance, type PerformanceEntryList } from 'perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PerformanceMeasureOptions, DetailedPerformanceEntry, Closable, WrittenFile, MethodFunction } from '../@types';

type PhaseMeasurement = { duration: number; result?: WrittenFile[] };

const type = 'measure';
const buildMessage = 'Build';
const bundleMessage = 'Bundle';
const initializationMessage = 'Initialization';
const typeCheckMessage = 'Type-checking/Emit';
const declarationMessage = 'Process Declarations';
const transpileMessage = 'Transpile';
const groupedPhaseMessages = new Set([ declarationMessage, transpileMessage ]);
const buildPhaseMeasurements = new AsyncLocalStorage<Map<string, PhaseMeasurement>>();

/**
 * Calculates build time not represented by the displayed critical-path phases.
 * @param buildDuration - End-to-end build duration
 * @param measurements - Phase measurements captured within the current build
 * @returns Displayed overhead in milliseconds
 */
function calculateOverhead(buildDuration: number, measurements: ReadonlyMap<string, PhaseMeasurement>) {
	const duration = (message: string) => Math.trunc(measurements.get(message)?.duration ?? 0);
	const initialization = duration(initializationMessage);
	const typeCheck = duration(typeCheckMessage);
	const bundle = duration(bundleMessage);

	return Math.max(0, Math.trunc(buildDuration) - initialization - typeCheck - bundle);
}

/**
 * Orders and narrows entries to the shape this module always populates via `measure()`'s `options.detail`.
 * @param entries - Entries produced by this module's own PerformanceObserver
 */
function toOrderedDetailedEntries(entries: PerformanceEntryList) {
	return entries.reverse() as DetailedPerformanceEntry<unknown>[];
}

/** A class that logs the performance of methods using the Performance API */
@closeOnExit
class PerformanceLogger implements Closable {
	readonly #performanceObserver: PerformanceObserver;

	constructor() {
		this.#performanceObserver = new PerformanceObserver((list) => this.#logEntries(list.getEntriesByType(type)));
		this.#performanceObserver.observe({ type });
	}

	/**
	 * Measures the performance of a method and logs the result.
	 * @param message - The message to log with the performance measurement
	 * @param groupedPhases - Child measurements to render beneath this measurement
	 * @returns A Stage 3 method decorator that measures execution time of the decorated method
	 */
	measure(message: string, groupedPhases: readonly string[] = []) {
		const _measure = <R>(propertyKey: string, result: R, startTime: number, options: PerformanceMeasureOptions<R>): R => {
			({ startTime: options.end } = performance.mark(propertyKey));
			const duration = options.end - startTime;
			const phaseMeasurements = buildPhaseMeasurements.getStore();
			if (message === buildMessage) {
				if (phaseMeasurements !== undefined) { options.detail.overheadMs = calculateOverhead(duration, phaseMeasurements) }
			} else {
				const outputFiles = Array.isArray(result) && isWrittenFiles(result) ? result : undefined;
				phaseMeasurements?.set(message, { duration, ...(outputFiles === undefined ? {} : { result: outputFiles }) });
			}

			if (groupedPhases.length > 0) {
				options.detail.steps = groupedPhases.flatMap((phase) => {
					const measurement = phaseMeasurements?.get(phase);
					return measurement === undefined ? [] : [{ name: phase, duration: PerformanceLogger.#formatDuration(measurement.duration), ms: measurement.duration, result: measurement.result }];
				});
			} else {
				options.detail.result = result;
			}
			performance.measure(propertyKey, options);

			return result;
		};

		// Stage 3 decorator function
		return function<T, A extends unknown[], R>(targetMethod: MethodFunction<T, A, R>, context: ClassMethodDecoratorContext<T, MethodFunction<T, A, R>>): MethodFunction<T, A, R> {
			const propertyKey = String(context.name);
			return function(this: T, ...args: A): R {
				const invoke = (): R => {
					const startTime = performance.mark(propertyKey).startTime;
					const options: PerformanceMeasureOptions<R> = { start: startTime, detail: { message } };
					const result = targetMethod.apply(this, args);

					// Promise<R> collapses to R at runtime when R is itself a Promise; TS can't express that, hence the cast
					return result instanceof Promise ? result.then((r: R) => _measure(propertyKey, r, startTime, options)) as R : _measure(propertyKey, result, startTime, options);
				};

				return message === buildMessage ? buildPhaseMeasurements.run(new Map(), invoke) : invoke();
			};
		};
	}

	/** Synchronously logs any measurements still queued for async observer delivery. */
	flush(): void {
		this.#logEntries(this.#performanceObserver.takeRecords());
	}

	/**
	 * Closes the performance logger.
	 */
	close(): void {
		this.#performanceObserver.disconnect();
	}

	/**
	 * Logs measurement entries, most recent first.
	 * @param entries - Chronologically ordered measure entries
	 */
	#logEntries(entries: PerformanceEntryList) {
		// Reverse the list to display the most recent entries first
		for (const { name, duration, detail: { message, result = [], steps, overheadMs } } of toOrderedDetailedEntries(entries)) {
			if (groupedPhaseMessages.has(message)) {
				performance.clearMeasures(name);
				performance.clearMarks(name);
				continue;
			}

			// Special formatting for top-level "Build" step ⚡
			if (message === buildMessage) {
				Logger.separator();
				if (process.exitCode) {
					Logger.error(`✗ Build failed in ${TextFormat.cyan(PerformanceLogger.#formatDuration(duration))}\n`);
				} else {
					if (typeof overheadMs === 'number') { Logger.step(`Overhead ${TextFormat.dim(`(${PerformanceLogger.#formatDuration(overheadMs)})`)}`) }
					Logger.step(`Completed in ${TextFormat.cyan(PerformanceLogger.#formatDuration(duration))}\n`);
				}
			} else {
				Logger.step(`${message} ${TextFormat.dim(`(${PerformanceLogger.#formatDuration(duration)})`)}`);
				if (steps?.length) { Logger.subSteps(steps, message === bundleMessage) }

				// If there are result files, log them with tree formatting
				if (Array.isArray(result) && isWrittenFiles(result) && result.length > 0) { Logger.success('', ...result) }
			}

			// Clear the marks and measures for this entry to avoid memory leaks
			performance.clearMeasures(name);
			performance.clearMarks(name);
		}
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