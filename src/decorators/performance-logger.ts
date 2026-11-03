import { TextFormat } from '../text-formatter';
import { Logger } from '../logger';
import { isWrittenFiles } from '../files';
import { closeOnExit } from './close-on-exit';
import { PerformanceObserver, performance, type PerformanceEntryList } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BuildOutputStyle } from '../constants';
import { PerformancePhase } from '../performance-phase';
import type { PerformanceMeasureOptions, DetailedPerformanceEntry, Closable, WrittenFile, MethodFunction, BuildOutputStyle as BuildOutputStyleType, PerformanceSubStep } from '../@types';

type PhaseMeasurement = { duration: number; result?: WrittenFile[] };
type BuildPerformanceContext = { measurements: Map<PerformancePhase, PhaseMeasurement>; outputStyle: BuildOutputStyleType; interactive: boolean };

const type = 'measure';
const groupedPhases = new Set<PerformancePhase>([ PerformancePhase.DECLARATIONS, PerformancePhase.TRANSPILE ]);
const buildPhaseOrder = [ PerformancePhase.INITIALIZATION, PerformancePhase.COMPILE, PerformancePhase.BUNDLE, PerformancePhase.DECLARATIONS, PerformancePhase.TRANSPILE ];
const buildPhases = new Set<PerformancePhase>(buildPhaseOrder);
const buildPhaseMeasurements = new AsyncLocalStorage<BuildPerformanceContext>();

/**
 * Selects the output layout for the build currently running in this async context.
 * @param outputStyle - The configured build report style.
 * @param interactive - Whether the report may prompt for keyboard input (only while the process is kept alive, e.g. watch mode).
 */
function setBuildOutputStyle(outputStyle: BuildOutputStyleType, interactive = false): void {
	const buildContext = buildPhaseMeasurements.getStore();

	if (buildContext !== undefined) {
		buildContext.outputStyle = outputStyle;
		buildContext.interactive = interactive;
	}
}

/**
 * Calculates build time not represented by the displayed critical-path phases.
 * @param buildDuration - End-to-end build duration
 * @param measurements - Phase measurements captured within the current build
 * @returns Displayed overhead in milliseconds
 */
function calculateOverhead(buildDuration: number, measurements: ReadonlyMap<PerformancePhase, PhaseMeasurement>) {
	const duration = (phase: PerformancePhase) => Math.trunc(measurements.get(phase)?.duration ?? 0);

	return Math.max(0, Math.trunc(buildDuration) - duration(PerformancePhase.INITIALIZATION) - duration(PerformancePhase.COMPILE) - duration(PerformancePhase.BUNDLE));
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
	 * @param phase - The performance phase to log with the performance measurement
	 * @param childPhases - Child measurements to render beneath this measurement
	 * @returns A Stage 3 method decorator that measures execution time of the decorated method
	 */
	measure(phase: PerformancePhase, ...childPhases: PerformancePhase[]) {
		const _measure = <R>(propertyKey: string, result: R, startTime: number, options: PerformanceMeasureOptions<R>, buildContext: BuildPerformanceContext | undefined): R => {
			({ startTime: options.end } = performance.mark(propertyKey));
			const duration = options.end - startTime;
			const phaseMeasurements = buildContext?.measurements;

			if (phase === PerformancePhase.BUILD) {
				if (phaseMeasurements !== undefined) {
					options.detail.overheadMs = calculateOverhead(duration, phaseMeasurements);
					options.detail.outputStyle = buildContext?.outputStyle ?? BuildOutputStyle.SUMMARY;
					options.detail.interactive = buildContext?.interactive;
					options.detail.phases = buildPhaseOrder.flatMap((phase): PerformanceSubStep[] => {
						const measurement = phaseMeasurements.get(phase);

						return measurement === undefined ? [] : [{ name: phase, duration: PerformanceLogger.#formatDuration(measurement.duration), ms: Math.trunc(measurement.duration), result: measurement.result }];
					});
				}
			} else {
				const outputFiles = Array.isArray(result) && isWrittenFiles(result) ? result : undefined;
				if (buildContext !== undefined && buildPhases.has(phase)) { options.detail.buildPhase = true }
				phaseMeasurements?.set(phase, { duration, ...(outputFiles === undefined ? {} : { result: outputFiles }) });
			}

			if (childPhases.length > 0) {
				options.detail.steps = childPhases.flatMap((phase) => {
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
					const buildContext = buildPhaseMeasurements.getStore();
					const startTime = performance.mark(propertyKey).startTime;
					const options: PerformanceMeasureOptions<R> = { start: startTime, detail: { phase } };
					const result = targetMethod.apply(this, args);

					// Promise<R> collapses to R at runtime when R is itself a Promise; TS can't express that, hence the cast
					return result instanceof Promise ? result.then((r: R) => _measure(propertyKey, r, startTime, options, buildContext)) as R : _measure(propertyKey, result, startTime, options, buildContext);
				};

				return phase === PerformancePhase.BUILD ? buildPhaseMeasurements.run({ measurements: new Map(), outputStyle: BuildOutputStyle.SUMMARY, interactive: false }, invoke) : invoke();
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
		for (const { name, duration, detail: { phase, result = [], steps, phases = [], overheadMs, outputStyle, interactive, buildPhase } } of entries.reverse() as DetailedPerformanceEntry<unknown>[]) {
			if (groupedPhases.has(phase) || buildPhase) {
				performance.clearMeasures(name);
				performance.clearMarks(name);
				continue;
			}

			if (phase === PerformancePhase.BUILD) {
				Logger.buildReport({
					style: outputStyle ?? BuildOutputStyle.SUMMARY,
					duration: PerformanceLogger.#formatDuration(duration),
					durationMs: Math.trunc(duration),
					overhead: typeof overheadMs === 'number' ? PerformanceLogger.#formatDuration(overheadMs) : undefined,
					overheadMs,
					phases,
					success: !process.exitCode,
					interactive
				});
			} else {
				Logger.step(`${phase} ${TextFormat.dim(`(${PerformanceLogger.#formatDuration(duration)})`)}`);
				if (steps?.length) { Logger.subSteps(steps, phase === PerformancePhase.BUNDLE) }

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

export { measure as logPerformance, flushPerformanceLog, setBuildOutputStyle };