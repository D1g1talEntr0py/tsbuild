import { TextFormat } from './text-formatter';
import { dataUnits, newLine } from 'src/constants';
import type { LogEntryType, WrittenFile } from './@types';

/**
 * Checks if the given data is an array of WrittenFile objects.
 * @param data - The data to check.
 * @returns True if the data is an array of WrittenFile objects, false otherwise.
 * @internal
 */
export const isWrittenFiles = (data: unknown[]): data is WrittenFile[] => {
	if (!Array.isArray(data)) { return false }

	return data.every((writtenFile): boolean => {
		return writtenFile !== null && typeof writtenFile === 'object' && 'path' in writtenFile && 'size' in writtenFile;
	});
};

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

	const exp = ~~(Math.log(bytes) / Math.log(1024));

	return { value: (bytes / Math.pow(1024, exp)).toFixed(2), unit: dataUnits[exp] };
};

/** A simple logger class with different log levels and formatting */
export class Logger {
	private constructor() {}

	static readonly EntryType = {
		Info: 'info',
		Success: 'success',
		Done: 'done',
		Error: 'error',
		Warn: 'warn'
	} as const;

	/** Clears the console */
	static clear(): void {
		console.log('\x1Bc');
	}

	/**
	 * Logs a header box with a message.
	 * @param message The message to display in the header.
	 */
	static header(message: string): void {
		const innerWidth = message.length + 2;
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
	 * Logs a success message with a check mark and optional indentation.
	 * @param message The message to log.
	 * @param indent Whether to indent the message (tree structure).
	 */
	static step(message: string, indent: boolean = false): void {
		const prefix = indent ? '  └─' : '✓';
		console.log(TextFormat.green(`${prefix} ${message}`));
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
		if (data.length) {
			if (isWrittenFiles(data)) {
				// Only log the message if it's not empty
				if (message) {
					console.log(colorize(type, message, true));
				}
				Logger.files(data);
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
	 * @internal
	 */
	private static files(files: WrittenFile[]): void {
		const maxPathLength = files.reduce((max, { path }): number => Math.max(max, path.length), 0);
		const formatted = files.map(({ path, size }) => ({ path, ...prettyBytes(size) }));
		const maxValueLength = formatted.reduce((max, { value }): number => Math.max(max, value.length), 0);
		const maxUnitLength = formatted.reduce((max, { unit }): number => Math.max(max, unit.length), 0);

		for (let i = 0, length = formatted.length; i < length; i++) {
			const { path, value, unit } = formatted[i];
			const paddedPath = path.padEnd(maxPathLength);
			const paddedValue = value.padStart(maxValueLength);
			const paddedUnit = unit.padEnd(maxUnitLength);
			// Determine the prefix based on the file's position in the array. Last file gets '└─', others get '├─'.
			const prefix = i === length - 1 ? '  └─' : '  ├─';
			console.log(`${TextFormat.dim(prefix)} ${TextFormat.bold(paddedPath)} ${TextFormat.cyan(paddedValue)} ${TextFormat.dim(paddedUnit)}`);
		}
	}
}
