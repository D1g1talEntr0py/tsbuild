import { TextFormat } from './text-formatter';
import { dataUnits, newLine, PerformancePhase } from './constants';
import { isWrittenFiles } from './files';
import type { BuildOutputStyle, LogEntryType, WrittenFile, PerformanceSubStep } from './@types';

const LOG_1024 = Math.log(1024);
const summaryOutputLimit = 15;
// eslint-disable-next-line no-control-regex
const ansiEscapePattern = /\x1b\[[0-9;]*m/g;

/**
 * Colorizes a string based on the entry type.
 * @param type - The type of the log entry.
 * @param data - The string to colorize.
 * @param onlyImportant - If true, info and success messages will not be colorized.
 * @returns The colorized string.
 * @internal
 */
export const colorize = (type: LogEntryType, data: string, onlyImportant = false): string => {
	if (onlyImportant && (type === 'info' || type === 'success')) { return data }

	switch (type) {
		case 'info': return TextFormat.blue(data);
		case 'error': return TextFormat.red(data);
		case 'warn': return TextFormat.yellow(data);
		default: return TextFormat.green(data);
	}
};

/**
 * Formats a number of bytes into a human-readable string.
 * @param bytes - The number of bytes.
 * @returns An object with the numeric value and unit separately.
 * @internal
 */
export const prettyBytes = (bytes: number): { value: string; unit: string } => {
	if (bytes === 0) { return { value: '0', unit: 'B' } }

	const exp = ~~(Math.log(bytes) / LOG_1024);

	return { value: (bytes / Math.pow(1024, exp)).toFixed(2), unit: dataUnits[exp] };
};

/** A simple logger class with different log levels and formatting */
export class Logger {
	private constructor() { throw new Error('Logger is a static class and cannot be instantiated.') }

	static readonly EntryType = {
		Info: 'info',
		Success: 'success',
		Done: 'done',
		Error: 'error',
		Warn: 'warn'
	} as const;

	/** The pending "press M for more" prompt; it is dismissed (restoring the terminal) before other output is written. */
	static #outputsPrompt?: { dismiss(): void; interject(line: string): void };

	/** Clears the console */
	static clear(): void {
		Logger.#outputsPrompt?.dismiss();
		console.log('\x1Bc');
	}

	/**
	 * Logs a header box with a message.
	 * The header is styled with a cyan border and the message is centered inside. ANSI escape codes are stripped from the message when calculating the width to ensure proper formatting.
	 * This ensures the header box is sized correctly even when the message contains color codes or other formatting.
	 * @param message The message to display in the header.
	 */
	static header(message: string): void {
		// Calculate the visible length of the message by removing ANSI escape codes, which do not take up space in the console.
		Logger.#outputsPrompt?.dismiss();
		const innerWidth = message.replace(ansiEscapePattern, '').length + 2;
		console.log(TextFormat.cyan(`╭${'─'.repeat(innerWidth)}╮${newLine}│ ${message} │${newLine}╰${'─'.repeat(innerWidth)}╯`));
	}

	/**
	 * Logs a separator line.
	 * @param width Optional width of the separator (default: 40).
	 */
	static separator(width: number = 40): void {
		console.log(TextFormat.dim('─'.repeat(width)));
	}

	/**
	 * Shows a non-blocking "press M for more" prompt that expands the hidden outputs on demand.
	 * The prompt stays pinned below plain status lines (such as the watch notice) logged while it is pending.
	 * @param outputFiles - All output files; those past the summary limit are hidden until expanded.
	 * @param summaryLine - The summary line repeated after the expanded list.
	 * @returns Whether the prompt was shown (requires an interactive terminal).
	 */
	static #promptForMoreOutputs(outputFiles: WrittenFile[], summaryLine: string): boolean {
		const input = process.stdin;
		const output = process.stdout;
		if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') { return false }

		const wasRaw = input.isRaw;
		try {
			input.setRawMode(true);
		} catch {
			return false;
		}

		const prompt = `  ${TextFormat.dim(`Press M for ${outputFiles.length - summaryOutputLimit} more outputs; any other key to dismiss`)}`;
		const clearLine = '\r\x1b[2K';
		// Lines printed between the truncated list and the prompt; replayed below the expanded list.
		const interjected: string[] = [];
		const fitsOnScreen = () => interjected.length < output.rows - 1 && interjected.every(line => line.replace(ansiEscapePattern, '').length < output.columns);

		const dismiss = (expand: boolean) => {
			Logger.#outputsPrompt = undefined;
			input.off('data', onData).off('error', onError);
			try { input.setRawMode(wasRaw) } catch { /* the terminal is already gone */ }
			input.pause();
			input.ref();
			output.write(clearLine);
			if (!expand) {
				if (interjected.length === 0) { console.log('') }
				return;
			}

			const replay = interjected.length > 0 && fitsOnScreen();
			if (replay) { output.write(`\x1b[${interjected.length}A\x1b[J`) }
			Logger.#displayFileStatistics(outputFiles, '  ', summaryOutputLimit);
			console.log(`\n${summaryLine}\n`);
			if (replay) { for (const line of interjected.slice(1)) { console.log(line) } }
		};
		const onError = () => dismiss(false);
		const onData = (data: Buffer | string) => {
			const key = data.toString().toLowerCase();
			dismiss(key === 'm');
			if (key === '\u0003') { process.kill(process.pid, 'SIGINT') }
		};

		Logger.#outputsPrompt = {
			dismiss: () => dismiss(false),
			interject: (line: string) => {
				output.write(clearLine);
				// Keep the padding line between the outputs and any status lines.
				if (interjected.length === 0) { interjected.push(''); console.log('') }
				interjected.push(line);
				console.log(line);
				output.write(prompt);
			}
		};
		input.on('data', onData).once('error', onError).resume();
		// Never keep the process alive just to wait for a key.
		input.unref();
		output.write(prompt);

		return true;
	}

	/**
	 * Logs a completed build using the selected report layout.
	 * @param report - Build timings, generated files, status, and output style. `interactive` enables the "press M for more" prompt, which
	 * never blocks and should only be requested when the process stays alive afterwards (watch mode).
	 */
	static buildReport(report: { style: BuildOutputStyle; duration: string; durationMs: number; overhead?: string; overheadMs?: number; phases: PerformanceSubStep[]; success: boolean; interactive?: boolean }): void {
		Logger.#outputsPrompt?.dismiss();
		const { style, duration, overhead, phases, success } = report;
		const phase = (name: string) => phases.find(item => item.name === name);
		const topLevelPhases = [ phase(PerformancePhase.INITIALIZATION), phase(PerformancePhase.COMPILE), phase(PerformancePhase.BUNDLE) ].filter((item): item is PerformanceSubStep => item !== undefined);
		const outputPhases = [ phase(PerformancePhase.DECLARATIONS), phase(PerformancePhase.TRANSPILE) ].filter((item): item is PerformanceSubStep => item !== undefined);
		const outputFiles = outputPhases.flatMap((item) => item.result ?? []);
		const totalBytes = outputFiles.reduce((total, file) => total + file.size, 0);
		const formattedSize = prettyBytes(totalBytes);
		const status = success ? TextFormat.green('✓ Build succeeded') : TextFormat.red('✗ Build failed');
		const durationText = TextFormat.blueBright(duration);
		const summaryLine = `${status} in ${durationText} ${TextFormat.dim('·')} ${topLevelPhases.length} steps ${TextFormat.dim('·')} ${outputFiles.length} outputs ${TextFormat.dim('·')} ${formattedSize.value} ${formattedSize.unit}${overhead === undefined ? '' : ` ${TextFormat.dim('·')} Overhead ${TextFormat.yellow(overhead)}`}`;

		const logPhase = (item: PerformanceSubStep, indentation = '  ', includeChildren = false, includeChildFiles = true) => {
			console.log(`${indentation}${TextFormat.green('✓')} ${TextFormat.bold(item.name)} ${TextFormat.cyan(item.duration)}`);
			if (!includeChildren) { return }

			const children = outputPhases;
			for (let index = 0; index < children.length; index++) {
				const child = children[index];
				const isLast = index === children.length - 1;
				console.log(`${indentation}  ${TextFormat.dim(isLast ? '└─' : '├─')} ${TextFormat.bold(child.name)} ${TextFormat.dim(`(${child.duration})`)}`);
				if (includeChildFiles && child.result?.length) { Logger.#displayFileStatistics(child.result, `${indentation}  ${isLast ? '   ' : '│  '}`) }
			}
		};

		switch (style) {
			case 'dashboard': {
				console.log(`${status} ${TextFormat.dim('·')} Completed in ${durationText}`);
				for (const item of topLevelPhases) { logPhase(item, '  ', item.name === PerformancePhase.BUNDLE) }
				break;
			}
			case 'pipeline': {
				const markers = [ '①', '②', '③' ];
				for (let index = 0; index < topLevelPhases.length; index++) {
					const item = topLevelPhases[index];
					const marker = markers[index] ?? String(index + 1);
					console.log(`  ${TextFormat.blue(marker)} ${TextFormat.bold(item.name)} ${TextFormat.dim('─'.repeat(4))} ${TextFormat.cyan(item.duration)}`);
					if (item.name === PerformancePhase.BUNDLE) {
						for (let childIndex = 0; childIndex < outputPhases.length; childIndex++) {
							const child = outputPhases[childIndex];
							const isLast = childIndex === outputPhases.length - 1;
							console.log(`      ${TextFormat.dim(isLast ? '└─' : '├─')} ${TextFormat.bold(child.name)} ${TextFormat.dim(`(${child.duration})`)}`);
							if (child.result?.length) { Logger.#displayFileStatistics(child.result, isLast ? '         ' : '      │  ') }
						}
					}
				}
				console.log(`${status} ${TextFormat.dim('·')} ${durationText}`);
				break;
			}
			case 'artifacts': {
				console.log(`${status} ${TextFormat.dim('·')} ${durationText}`);
				console.log(`\n${TextFormat.bold('OUTPUTS')}`);
				for (const [ name, label ] of [ [ PerformancePhase.DECLARATIONS, 'Declarations' ], [ PerformancePhase.TRANSPILE, 'JavaScript' ] ]) {
					const item = phase(name);
					if (item?.result?.length) {
						console.log(`  ${TextFormat.blue(label)}`);
						Logger.#displayFileStatistics(item.result, '    ');
					}
				}
				console.log(`\n${TextFormat.bold('TIMING')}`);
				console.log(`  ${topLevelPhases.map(item => `${item.name} ${TextFormat.cyan(item.duration)}`).join(TextFormat.dim('  ·  '))}`);
				break;
			}
			case 'summary': {
				console.log(summaryLine);
				console.log(`\n  ${topLevelPhases.map(item => `${item.name} ${TextFormat.cyan(item.duration)}`).join(` ${TextFormat.dim('→')} `)}`);
				const hiddenCount = outputFiles.length - summaryOutputLimit;
				if (outputFiles.length) {
					console.log(`\n${TextFormat.bold('Outputs')}`);
					Logger.#displayFileStatistics(outputFiles, '  ', 0, summaryOutputLimit);
				}
				if (hiddenCount > 0) {
					if (report.interactive && Logger.#promptForMoreOutputs(outputFiles, summaryLine)) { break }
					console.log(`  ${TextFormat.dim(`… and ${hiddenCount} more; use "--outputStyle detailed" to list all outputs`)}`);
				}
				console.log('');
				break;
			}
			case 'detailed': {
				console.log(`${status} in ${durationText}`);
				console.log(`\n  ${TextFormat.bold('BUILD')}`);
				for (const item of topLevelPhases) { logPhase(item, '  ', item.name === PerformancePhase.BUNDLE, false) }
				console.log(`\n  ${TextFormat.bold('OUTPUTS')}`);
				const outputGroups = [
					{ name: PerformancePhase.DECLARATIONS, label: 'Declarations' },
					{ name: PerformancePhase.TRANSPILE, label: 'JavaScript' }
				].flatMap(({ name, label }) => {
					const item = phase(name);
					return item?.result?.length ? [{ files: item.result, label }] : [];
				});
				for (let index = 0; index < outputGroups.length; index++) {
					const { files, label } = outputGroups[index];
					const isLast = index === outputGroups.length - 1;
					console.log(`  ${TextFormat.dim(isLast ? '└─' : '├─')} ${TextFormat.blue(label)}`);
					Logger.#displayFileStatistics(files, `  ${isLast ? '   ' : '│  '}`);
				}
				break;
			}
		}

		if (style !== 'summary' && overhead !== undefined) {
			console.log(`\n  Overhead ${TextFormat.yellow(overhead)}`);
		}
	}

	/**
	 * Logs a success message with a check mark and optional indentation.
	 * @param message The message to log.
	 * @param indent Whether to indent the message (tree structure).
	 */
	static step(message: string, indent: boolean = false): void {
		Logger.#outputsPrompt?.dismiss();
		console.log(TextFormat.green(`${indent ? '  └─' : '✓'} ${message}`));
	}

	/**
	 * Logs sub-step timing entries in a tree format below a parent step.
	 * @param steps The sub-steps to log.
	 * @param grouped Whether to render all entries as grouped timing children.
	 */
	static subSteps(steps: PerformanceSubStep[], grouped = false): void {
		const visible = grouped ? steps : steps.filter(({ ms }) => ms >= 5);

		if (visible.length === 0) { return }

		let maxNameLength = 0;
		let maxDurationLength = 0;
		for (let i = 0, length = visible.length; i < length; i++) {
			const { name, duration } = visible[i];
			const formattedDuration = grouped ? `(${duration})` : duration;

			if (name.length > maxNameLength) { maxNameLength = name.length }

			if (formattedDuration.length > maxDurationLength) { maxDurationLength = formattedDuration.length }
		}

		for (let i = 0, length = visible.length; i < length; i++) {
			const { name, duration, result = [] } = visible[i];
			const isLast = i === length - 1;
			const formattedDuration = (grouped ? `(${duration})` : duration).padStart(maxDurationLength);

			console.log(`${TextFormat.dim(isLast ? '  └─' : '  ├─')} ${TextFormat.bold(name.padEnd(maxNameLength))} ${grouped ? TextFormat.dim(formattedDuration) : TextFormat.cyan(formattedDuration)}`);

			if (Array.isArray(result) && isWrittenFiles(result) && result.length > 0) { Logger.#displayFileStatistics(result, isLast ? '     ' : '  │  ') }
		}
	}

	/**
	 * Logs a success message.
	 * @param message The message to log.
	 * @param args Additional data to log.
	 * @returns void
	 */
	static success<const Args extends unknown[]>(message: string, ...args: Args): void {
		return Logger.log(message, 'success', ...args);
	}

	/**
	 * Logs an info message.
	 * @param message The message to log.
	 * @param args Additional data to log.
	 * @returns void
	 */
	static info<const Args extends unknown[]>(message: string, ...args: Args): void {
		return Logger.log(message, 'info', ...args);
	}

	/**
	 * Logs an error message.
	 * @param message The message to log.
	 * @param args Additional data to log.
	 * @returns void
	 */
	static error<const Args extends unknown[]>(message: string, ...args: Args): void {
		return Logger.log(message, 'error', ...args);
	}

	/**
	 * Logs a warning message.
	 * @param message The message to log.
	 * @param args Additional data to log.
	 * @returns void
	 */
	static warn<const Args extends unknown[]>(message: string, ...args: Args): void {
		return Logger.log(message, 'warn', ...args);
	}

	/**
	 * Logs a done message.
	 * @param message The message to log.
	 * @param type The type of the log entry.
	 * @param data Additional data to log.
	 */
	static log(message: string, type: LogEntryType, ...data: unknown[]): void {
		if (Logger.#outputsPrompt !== undefined) {
			// Single-line status messages keep the prompt pinned below them; anything else dismisses it.
			if (type === 'info' && data.length === 0 && !message.includes(newLine)) { return Logger.#outputsPrompt.interject(colorize(type, message, true)) }
			Logger.#outputsPrompt.dismiss();
		}
		if (data.length) {
			if (isWrittenFiles(data)) {
				// Only log the message if it's not empty
				if (message) { console.log(colorize(type, message, true)) }
				Logger.#displayFileStatistics(data);
			} else {
				console.log(colorize(type, message, true), ...data);
			}
		} else {
			console.log(colorize(type, message, true));
		}
	}

	/**
	 * Logs an array of WrittenFile objects in a formatted manner.
	 * @param files - The array of WrittenFile objects to log.
	 * @param indentation - Prefix applied before each file tree branch.
	 * @param start - Index of the first file to print; columns stay aligned across all files so a list can be printed in chunks.
	 * @param end - Index after the last file to print.
	 */
	static #displayFileStatistics(files: WrittenFile[], indentation = '  ', start = 0, end = files.length) {
		let maxPathLength = 0;
		let maxValueLength = 0;
		let maxUnitLength = 0;
		const formatted: Array<{ path: string; value: string; unit: string }> = [];

		for (let i = 0, length = files.length; i < length; i++) {
			const { path, size } = files[i];
			const { value, unit } = prettyBytes(size);

			if (path.length > maxPathLength) { maxPathLength = path.length }

			if (value.length > maxValueLength) { maxValueLength = value.length }

			if (unit.length > maxUnitLength) { maxUnitLength = unit.length }

			formatted.push({ path, value, unit });
		}

		for (let i = start, length = Math.min(end, formatted.length); i < length; i++) {
			const { path, value, unit } = formatted[i];
			// Determine the prefix based on the file's position in the array. Last file gets '└─', others get '├─'.
			const prefix = `${indentation}${i === formatted.length - 1 ? '└─' : '├─'}`;

			console.log(`${TextFormat.dim(prefix)} ${TextFormat.bold(path.padEnd(maxPathLength))} ${TextFormat.cyan(value.padStart(maxValueLength))} ${TextFormat.dim(unit.padEnd(maxUnitLength))}`);
		}
	}
}
