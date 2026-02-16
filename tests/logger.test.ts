import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, isWrittenFiles, colorize, prettyBytes } from '../src/logger';
import { TextFormat } from '../src/text-formatter';
import { TestHelper } from './scripts/test-helper';

describe('logger', () => {
	beforeEach(async () => {
		await TestHelper.setupMemfs();
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	describe('isWrittenFiles', () => {
		it('should return true for an array of WrittenFile objects', () => {
			const data = [{ path: 'a', size: 1 }, { path: 'b', size: 2 }];
			expect(isWrittenFiles(data)).toBe(true);
		});

		it('should return true for an empty array', () => {
			expect(isWrittenFiles([])).toBe(true);
		});

		it('should return true for WrittenFile with additional properties', () => {
			const data = [{ path: 'test.ts', size: 100, extra: 'property' }];
			expect(isWrittenFiles(data)).toBe(true);
		});

		it('should return false for an array with non-WrittenFile objects', () => {
			const data = [{ path: 'a', size: 1 }, { path: 'b' }];
			expect(isWrittenFiles(data as unknown as unknown[])).toBe(false);
		});

		it('should return false for a non-array', () => {
			expect(isWrittenFiles('not-an-array' as unknown as unknown[])).toBe(false);
		});

		it('should return false for an array with null values', () => {
			const data = [null];
			expect(isWrittenFiles(data)).toBe(false);
		});

		it('should return false for an array with primitive values', () => {
			const data = ['string', 123, true];
			expect(isWrittenFiles(data as unknown as unknown[])).toBe(false);
		});

		it('should return false for objects missing path property', () => {
			const data = [{ size: 100 }];
			expect(isWrittenFiles(data as unknown as unknown[])).toBe(false);
		});

		it('should return false for objects missing size property', () => {
			const data = [{ path: 'test.ts' }];
			expect(isWrittenFiles(data as unknown as unknown[])).toBe(false);
		});
	});

	describe('colorize', () => {
		it('should not colorize info when onlyImportant is true', () => {
			expect(colorize('info', 'test', true)).toBe('test');
		});

		it('should not colorize success when onlyImportant is true', () => {
			expect(colorize('success', 'test', true)).toBe('test');
		});

		it('should colorize info when onlyImportant is false', () => {
			expect(colorize('info', 'test', false)).toBe(TextFormat.blue('test'));
		});

		it('should colorize info by default (onlyImportant not provided)', () => {
			expect(colorize('info', 'test')).toBe(TextFormat.blue('test'));
		});

		it('should colorize success when onlyImportant is false', () => {
			expect(colorize('success', 'test', false)).toBe(TextFormat.green('test'));
		});

		it('should colorize error regardless of onlyImportant', () => {
			expect(colorize('error', 'test', true)).toBe(TextFormat.red('test'));
			expect(colorize('error', 'test', false)).toBe(TextFormat.red('test'));
		});

		it('should colorize warn regardless of onlyImportant', () => {
			expect(colorize('warn', 'test', true)).toBe(TextFormat.yellow('test'));
			expect(colorize('warn', 'test', false)).toBe(TextFormat.yellow('test'));
		});

		it('should colorize done with green', () => {
			expect(colorize('done', 'test')).toBe(TextFormat.green('test'));
			expect(colorize('done', 'test', true)).toBe(TextFormat.green('test'));
		});
	});

	describe('prettyBytes', () => {
		it('should return { value: "0", unit: "B" } for 0 bytes', () => {
			expect(prettyBytes(0)).toEqual({ value: '0', unit: 'B' });
		});

		it('should format bytes correctly', () => {
			expect(prettyBytes(1)).toEqual({ value: '1.00', unit: 'B' });
			expect(prettyBytes(512)).toEqual({ value: '512.00', unit: 'B' });
			expect(prettyBytes(1023)).toEqual({ value: '1023.00', unit: 'B' });
		});

		it('should format kilobytes correctly', () => {
			expect(prettyBytes(1024)).toEqual({ value: '1.00', unit: 'KB' });
			expect(prettyBytes(1536)).toEqual({ value: '1.50', unit: 'KB' });
			expect(prettyBytes(10240)).toEqual({ value: '10.00', unit: 'KB' });
		});

		it('should format megabytes correctly', () => {
			expect(prettyBytes(1048576)).toEqual({ value: '1.00', unit: 'MB' });
			expect(prettyBytes(5242880)).toEqual({ value: '5.00', unit: 'MB' });
		});

		it('should format gigabytes correctly', () => {
			expect(prettyBytes(1073741824)).toEqual({ value: '1.00', unit: 'GB' });
			expect(prettyBytes(2147483648)).toEqual({ value: '2.00', unit: 'GB' });
		});

		it('should format terabytes correctly', () => {
			expect(prettyBytes(1099511627776)).toEqual({ value: '1.00', unit: 'TB' });
		});

		it('should handle large numbers', () => {
			expect(prettyBytes(1125899906842624)).toEqual({ value: '1.00', unit: 'PB' });
		});
	});
});

describe('Logger', () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}));

	afterEach(() => {
		logSpy.mockRestore();
	});

	describe('clear', () => {
		it('should clear the console', () => {
			Logger.clear();
			expect(logSpy).toHaveBeenCalledWith('\x1Bc');
		});
	});

	describe('success', () => {
		it('should log a success message without colorization', () => {
			Logger.success('Success message');
			expect(logSpy).toHaveBeenCalledWith('Success message');
		});

		it('should log a success message with additional data', () => {
			Logger.success('Success with data', { key: 'value' });
			expect(logSpy).toHaveBeenCalledWith('Success with data', { key: 'value' });
		});
	});

	describe('info', () => {
		it('should log an info message without colorization', () => {
			Logger.info('Info message');
			expect(logSpy).toHaveBeenCalledWith('Info message');
		});

		it('should log an info message with additional data', () => {
			Logger.info('Info with data', 123, true);
			expect(logSpy).toHaveBeenCalledWith('Info with data', 123, true);
		});
	});

	describe('error', () => {
		it('should log an error message with colorization', () => {
			Logger.error('Error message');
			expect(logSpy).toHaveBeenCalledWith(TextFormat.red('Error message'));
		});

		it('should log an error message with additional data', () => {
			const errorData = new Error('Test error');
			Logger.error('Error occurred', errorData);
			expect(logSpy).toHaveBeenCalledWith(TextFormat.red('Error occurred'), errorData);
		});
	});

	describe('warn', () => {
		it('should log a warning message with colorization', () => {
			Logger.warn('Warning message');
			expect(logSpy).toHaveBeenCalledWith(TextFormat.yellow('Warning message'));
		});

		it('should log a warning message with additional data', () => {
			Logger.warn('Warning with data', 'extra info');
			expect(logSpy).toHaveBeenCalledWith(TextFormat.yellow('Warning with data'), 'extra info');
		});
	});

	describe('log', () => {
		it('should log a message without additional data', () => {
			Logger.log('Simple message', 'info');
			expect(logSpy).toHaveBeenCalledWith('Simple message');
		});

		it('should log a message with non-file data', () => {
			Logger.log('Message with data', 'info', { a: 1 }, [1, 2]);
			expect(logSpy).toHaveBeenCalledWith('Message with data', { a: 1 }, [1, 2]);
		});

	it('should log files with WrittenFile array', () => {
		const files = [
			{ path: 'file1.ts', size: 1024 },
			{ path: 'file2.js', size: 2048 },
		];
		Logger.log('Compiled files:', 'success', ...files);
		expect(logSpy).toHaveBeenCalledWith('Compiled files:');
		expect(logSpy).toHaveBeenCalledTimes(3);
		expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('file1.ts'));
		expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('1.00'));
		expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('KB'));
		expect(logSpy).toHaveBeenNthCalledWith(3, expect.stringContaining('file2.js'));
		expect(logSpy).toHaveBeenNthCalledWith(3, expect.stringContaining('2.00'));
		expect(logSpy).toHaveBeenNthCalledWith(3, expect.stringContaining('KB'));
	});

	it('should log single WrittenFile', () => {
		const file = { path: 'single.ts', size: 512 };
		Logger.log('Single file:', 'success', file);
		expect(logSpy).toHaveBeenCalledWith('Single file:');
		expect(logSpy).toHaveBeenCalledTimes(2);
		expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('single.ts'));
		expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('512.00'));
		expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('B'));
	});		it('should not colorize info messages when logging files', () => {
			const files = [{ path: 'file.ts', size: 123 }];
			Logger.log('Info with files', 'info', ...files);
			expect(logSpy).toHaveBeenCalledWith('Info with files');
			expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('file.ts'));
		});

		it('should not colorize success messages when logging files', () => {
			const files = [{ path: 'test.ts', size: 100 }];
			Logger.log('Success with files', 'success', ...files);
			expect(logSpy).toHaveBeenCalledWith('Success with files');
		});

		it('should colorize error messages even when logging files', () => {
			const files = [{ path: 'error.ts', size: 100 }];
			Logger.log('Error with files', 'error', ...files);
			expect(logSpy).toHaveBeenCalledWith(TextFormat.red('Error with files'));
		});

		it('should colorize warn messages even when logging files', () => {
			const files = [{ path: 'warn.ts', size: 100 }];
			Logger.log('Warning with files', 'warn', ...files);
			expect(logSpy).toHaveBeenCalledWith(TextFormat.yellow('Warning with files'));
		});

		it('should handle mixed data types (not all WrittenFiles)', () => {
			Logger.log('Mixed data', 'info', 'string', { path: 'file.ts', size: 100 });
			expect(logSpy).toHaveBeenCalledWith('Mixed data', 'string', { path: 'file.ts', size: 100 });
		});

		it('should format file paths with proper padding', () => {
			const files = [
				{ path: 'short.ts', size: 100 },
				{ path: 'verylongfilename.ts', size: 200 },
			];
			Logger.log('Files:', 'success', ...files);
			expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringMatching(/short\.ts\s+/));
			expect(logSpy).toHaveBeenNthCalledWith(3, expect.stringContaining('verylongfilename.ts'));
		});

		it('should use done type colorization', () => {
			Logger.log('Done message', 'done');
			expect(logSpy).toHaveBeenCalledWith(TextFormat.green('Done message'));
		});
	});

	describe('step', () => {
		it('should log a step message with check mark prefix', () => {
			Logger.step('Step message');
			expect(logSpy).toHaveBeenCalledWith(TextFormat.green('✓ Step message'));
		});

		it('should log a step message with tree indent when indent is true', () => {
			Logger.step('Indented step', true);
			expect(logSpy).toHaveBeenCalledWith(TextFormat.green('  └─ Indented step'));
		});
	});
});
