import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isWrittenFiles, colorize, prettyBytes, Logger } from 'src/logger';
import type { WrittenFile, PerformanceSubStep, RelativePath } from 'src/@types';

describe('isWrittenFiles', () => {
	const matrix: [string, unknown[], boolean][] = [
		['valid WrittenFile array', [{ path: 'a.js', size: 100 }], true],
		['multiple WrittenFiles', [{ path: 'a.js', size: 100 }, { path: 'b.js', size: 200 }], true],
		['empty array', [], true],
		['array with non-object', ['string'], false],
		['array with null', [null], false],
		['object missing path', [{ size: 100 }], false],
		['object missing size', [{ path: 'a.js' }], false],
		['non-array', [42], false],
	];

	it.each(matrix)('returns correct result for %s', (_desc, data, expected) => {
		expect(isWrittenFiles(data)).toBe(expected);
	});
});

describe('colorize', () => {
	it('colorizes info as blue', () => {
		const result = colorize('info', 'test');
		expect(result).toContain('\x1b[34m');
	});

	it('colorizes error as red', () => {
		const result = colorize('error', 'test');
		expect(result).toContain('\x1b[31m');
	});

	it('colorizes warn as yellow', () => {
		const result = colorize('warn', 'test');
		expect(result).toContain('\x1b[33m');
	});

	it('colorizes success as green', () => {
		const result = colorize('success', 'test');
		expect(result).toContain('\x1b[32m');
	});

	it('colorizes done as green', () => {
		const result = colorize('done', 'test');
		expect(result).toContain('\x1b[32m');
	});

	it('skips info colorization when onlyImportant is true', () => {
		expect(colorize('info', 'test', true)).toBe('test');
	});

	it('skips success colorization when onlyImportant is true', () => {
		expect(colorize('success', 'test', true)).toBe('test');
	});

	it('always colorizes error even with onlyImportant', () => {
		const result = colorize('error', 'test', true);
		expect(result).toContain('\x1b[31m');
	});

	it('always colorizes warn even with onlyImportant', () => {
		const result = colorize('warn', 'test', true);
		expect(result).toContain('\x1b[33m');
	});
});

describe('prettyBytes', () => {
	const bytesMatrix: [number, string, string][] = [
		[0, '0', 'B'],
		[100, '100.00', 'B'],
		[1024, '1.00', 'KB'],
		[1536, '1.50', 'KB'],
		[1048576, '1.00', 'MB'],
		[1073741824, '1.00', 'GB'],
		[1099511627776, '1.00', 'TB'],
	];

	it.each(bytesMatrix)('%d bytes → %s %s', (bytes, value, unit) => {
		const result = prettyBytes(bytes);
		expect(result.value).toBe(value);
		expect(result.unit).toBe(unit);
	});
});

describe('Logger', () => {
	let consoleSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(() => {
		consoleSpy.mockRestore();
	});

	describe('clear', () => {
		it('outputs clear escape code', () => {
			Logger.clear();
			expect(consoleSpy).toHaveBeenCalledWith('\x1Bc');
		});
	});

	describe('header', () => {
		it('outputs a bordered header box', () => {
			Logger.header('Test');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const output = consoleSpy.mock.calls[0][0] as string;
			expect(output).toContain('Test');
			expect(output).toContain('╭');
			expect(output).toContain('╰');
		});

		it('handles ANSI codes in message width calculation', () => {
			Logger.header('\x1b[1mBold\x1b[22m');
			const output = consoleSpy.mock.calls[0][0] as string;
			// The box width should be based on visible text "Bold" (4 chars), not the ANSI codes
			expect(output).toContain('Bold');
		});
	});

	describe('separator', () => {
		it('outputs a dim separator line', () => {
			Logger.separator();
			expect(consoleSpy).toHaveBeenCalledTimes(1);
			const output = consoleSpy.mock.calls[0][0] as string;
			expect(output).toContain('─');
		});

		it('uses custom width', () => {
			Logger.separator(10);
			const output = consoleSpy.mock.calls[0][0] as string;
			// Should contain 10 dash characters
			expect(output).toContain('─'.repeat(10));
		});
	});

	describe('step', () => {
		it('outputs a check mark prefix', () => {
			Logger.step('Done');
			const output = consoleSpy.mock.calls[0][0] as string;
			expect(output).toContain('✓');
			expect(output).toContain('Done');
		});

		it('outputs indented tree prefix', () => {
			Logger.step('Sub-step', true);
			const output = consoleSpy.mock.calls[0][0] as string;
			expect(output).toContain('└─');
			expect(output).toContain('Sub-step');
		});
	});

	describe('subSteps', () => {
		it('outputs sub-step entries in tree format', () => {
			const steps: PerformanceSubStep[] = [
				{ name: 'Step 1', ms: 100, duration: '100ms' },
				{ name: 'Step 2', ms: 200, duration: '200ms' },
			];
			Logger.subSteps(steps);
			expect(consoleSpy).toHaveBeenCalledTimes(2);
			const output1 = consoleSpy.mock.calls[0][0] as string;
			const output2 = consoleSpy.mock.calls[1][0] as string;
			expect(output1).toContain('├─');
			expect(output1).toContain('Step 1');
			expect(output2).toContain('└─');
			expect(output2).toContain('Step 2');
		});

		it('filters out sub-steps below 5ms', () => {
			const steps: PerformanceSubStep[] = [
				{ name: 'Fast', ms: 3, duration: '3ms' },
				{ name: 'Slow', ms: 100, duration: '100ms' },
			];
			Logger.subSteps(steps);
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});

		it('outputs nothing when all sub-steps are below threshold', () => {
			const steps: PerformanceSubStep[] = [
				{ name: 'Fast1', ms: 1, duration: '1ms' },
				{ name: 'Fast2', ms: 2, duration: '2ms' },
			];
			Logger.subSteps(steps);
			expect(consoleSpy).not.toHaveBeenCalled();
		});
	});

	describe('success', () => {
		it('logs a success message', () => {
			Logger.success('Build complete');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('info', () => {
		it('logs an info message', () => {
			Logger.info('Starting build');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('error', () => {
		it('logs an error message', () => {
			Logger.error('Build failed');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('warn', () => {
		it('logs a warning message', () => {
			Logger.warn('Deprecated option');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('log', () => {
		it('logs message without data', () => {
			Logger.log('plain message', 'info');
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});

		it('logs message with extra data', () => {
			Logger.log('message', 'info', 'extra', 42);
			expect(consoleSpy).toHaveBeenCalledWith(expect.any(String), 'extra', 42);
		});

		it('logs WrittenFile array in formatted manner', () => {
			const files: WrittenFile[] = [
				{ path: 'dist/index.js' as RelativePath, size: 1024 },
				{ path: 'dist/utils.js' as RelativePath, size: 512 },
			];
			Logger.log('Output:', 'success', ...files);
			// One call for the message, two calls for the files
			expect(consoleSpy).toHaveBeenCalledTimes(3);
		});

		it('logs WrittenFile array with empty message skips message', () => {
			const files: WrittenFile[] = [
				{ path: 'dist/index.js' as RelativePath, size: 1024 },
			];
			Logger.log('', 'success', ...files);
			// Only 1 call for the file (no message logged)
			expect(consoleSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('EntryType', () => {
		it('has all expected log entry types', () => {
			expect(Logger.EntryType.Info).toBe('info');
			expect(Logger.EntryType.Success).toBe('success');
			expect(Logger.EntryType.Done).toBe('done');
			expect(Logger.EntryType.Error).toBe('error');
			expect(Logger.EntryType.Warn).toBe('warn');
		});
	});
});
