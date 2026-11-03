import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { colorize, prettyBytes, Logger } from 'src/logger';
import { isWrittenFiles } from 'src/files';
import { PerformancePhase } from 'src/constants';
import type { WrittenFile, PerformanceSubStep, RelativePath } from 'src/@types';

// eslint-disable-next-line no-control-regex
const ansiEscapePattern = /\x1b\[[0-9;]*m/;

describe('isWrittenFiles', () => {
	const matrix: [string, unknown, boolean][] = [
		['valid WrittenFile array', [{ path: 'a.js', size: 100 }], true],
		['multiple WrittenFiles', [{ path: 'a.js', size: 100 }, { path: 'b.js', size: 200 }], true],
		['empty array', [], true],
		['array with non-object', ['string'], false],
		['array with null', [null], false],
		['object missing path', [{ size: 100 }], false],
		['object missing size', [{ path: 'a.js' }], false],
		['object with wrong path type', [{ path: 42, size: 100 }], false],
		['object with wrong size type', [{ path: 'a.js', size: '100' }], false],
		['number', 42, false],
		['object', { path: 'a.js', size: 100 }, false],
		['null', null, false],
	];

	it.each(matrix)('returns correct result for %s', (_desc, data, expected) => {
		expect(isWrittenFiles(data)).toBe(expected);
	});
});

describe('colorize', () => {
	it('colorizes info as blue', () => {
		const result = colorize('info', 'test');
		expect(result).toMatch(ansiEscapePattern);
		expect(result).not.toBe('test');
		expect(result).toContain('test');
	});

	it('colorizes error as red', () => {
		const result = colorize('error', 'test');
		expect(result).toMatch(ansiEscapePattern);
		expect(result).not.toBe('test');
		expect(result).toContain('test');
	});

	it('colorizes warn as yellow', () => {
		const result = colorize('warn', 'test');
		expect(result).toMatch(ansiEscapePattern);
		expect(result).not.toBe('test');
		expect(result).toContain('test');
	});

	it('colorizes success as green', () => {
		const result = colorize('success', 'test');
		expect(result).toMatch(ansiEscapePattern);
		expect(result).not.toBe('test');
		expect(result).toContain('test');
	});

	it('colorizes done as green', () => {
		const result = colorize('done', 'test');
		expect(result).toMatch(ansiEscapePattern);
		expect(result).not.toBe('test');
		expect(result).toContain('test');
	});

	it('uses the same color for success and done, distinct from info/error/warn', () => {
		const successResult = colorize('success', 'test');
		const doneResult = colorize('done', 'test');
		const infoResult = colorize('info', 'test');
		const errorResult = colorize('error', 'test');
		const warnResult = colorize('warn', 'test');

		expect(successResult).toBe(doneResult);
		expect(successResult).not.toBe(infoResult);
		expect(successResult).not.toBe(errorResult);
		expect(successResult).not.toBe(warnResult);
		expect(infoResult).not.toBe(errorResult);
		expect(infoResult).not.toBe(warnResult);
		expect(errorResult).not.toBe(warnResult);
	});

	it('skips info colorization when onlyImportant is true', () => {
		expect(colorize('info', 'test', true)).toBe('test');
	});

	it('skips success colorization when onlyImportant is true', () => {
		expect(colorize('success', 'test', true)).toBe('test');
	});

	it('always colorizes error even with onlyImportant', () => {
		const result = colorize('error', 'test', true);
		expect(result).toMatch(ansiEscapePattern);
		expect(result).not.toBe('test');
	});

	it('always colorizes warn even with onlyImportant', () => {
		const result = colorize('warn', 'test', true);
		expect(result).toMatch(ansiEscapePattern);
		expect(result).not.toBe('test');
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

	it('cannot be instantiated', () => {
		expect(() => Reflect.construct(Logger, [])).toThrow('Logger is a static class and cannot be instantiated.');
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

	describe('buildReport', () => {
		const phases: PerformanceSubStep[] = [
			{ name: PerformancePhase.INITIALIZATION, duration: '5ms', ms: 5 },
			{ name: PerformancePhase.COMPILE, duration: '189ms', ms: 189 },
			{ name: PerformancePhase.BUNDLE, duration: '29ms', ms: 29 },
			{ name: PerformancePhase.DECLARATIONS, duration: '14ms', ms: 14, result: [{ path: 'dist/types.d.ts' as RelativePath, size: 14000 }] },
			{ name: PerformancePhase.TRANSPILE, duration: '29ms', ms: 29, result: [{ path: 'dist/index.js' as RelativePath, size: 198000 }] }
		];

		it.each([
			[ 'dashboard', 'Build succeeded' ],
			[ 'pipeline', '①' ],
			[ 'artifacts', 'OUTPUTS' ],
			[ 'summary', '3 steps' ],
			[ 'detailed', 'BUILD' ]
		] as const)('renders the %s layout', (style, expected) => {
			Logger.buildReport({ style, duration: '229ms', durationMs: 229, overhead: '6ms', overheadMs: 6, phases, success: true });

			const output = consoleSpy.mock.calls.map(([ line ]) => line).join('\n');
			expect(output).toContain(expected);
			expect(output).toContain('dist/types.d.ts');
			expect(output).toContain('dist/index.js');
			expect(output).toContain('Overhead');
			for (const phase of phases.slice(0, 3)) { expect(output).toContain(phase.name) }
		});

		it.each([ 'dashboard', 'pipeline', 'artifacts', 'summary', 'detailed' ] as const)('renders the %s layout when output phases produced no files', (style) => {
			Logger.buildReport({ style, duration: '20ms', durationMs: 20, phases: phases.map(({ result: _result, ...phase }) => phase), success: false });

			const output = consoleSpy.mock.calls.map(([ line ]) => line).join('\n');
			expect(output).toContain('Build failed');
			expect(output).not.toContain('dist/');
		});

		it('limits summary file listings and does not repeat the summary unless expanded', () => {
			const outputFiles = Array.from({ length: 20 }, (_, index) => ({
				path: `dist/output-${index + 1}.js` as RelativePath,
				size: 1024
			}));
			const manyOutputPhases = phases.map(phase => phase.name === PerformancePhase.TRANSPILE ? { ...phase, result: outputFiles } : phase);

			Logger.buildReport({ style: 'summary', duration: '229ms', durationMs: 229, overhead: '6ms', overheadMs: 6, phases: manyOutputPhases, success: true });

			const output = consoleSpy.mock.calls.map(([ line ]) => line).join('\n');
			expect(output).toContain('dist/output-1.js');
			expect(output).toContain('dist/output-14.js');
			expect(output).not.toContain('dist/output-15.js');
			expect(output).toContain('… and 6 more; use "--outputStyle detailed" to list all outputs');
			expect(output.match(/Build succeeded/g)).toHaveLength(1);
			expect(consoleSpy.mock.calls.at(-1)?.[0]).toBe('');
		});

		describe('interactive outputs prompt', () => {
			class FakeStdin extends EventEmitter {
				isTTY = true;
				isRaw = false;
				setRawMode = vi.fn((mode: boolean) => { this.isRaw = mode; return this });
				resume = vi.fn(() => this);
				pause = vi.fn(() => this);
				ref = vi.fn(() => this);
				unref = vi.fn(() => this);
			}

			const manyOutputPhases = phases.map(phase => phase.name === PerformancePhase.TRANSPILE ? { ...phase, result: Array.from({ length: 20 }, (_, index) => ({ path: `dist/output-${index + 1}.js` as RelativePath, size: 1024 })) } : phase);
			const report = (interactive = true) => Logger.buildReport({ style: 'summary', duration: '229ms', durationMs: 229, overhead: '6ms', overheadMs: 6, phases: manyOutputPhases, success: true, interactive });
			const output = () => consoleSpy.mock.calls.map(([ line ]) => line).join('\n');
			let stdin: FakeStdin;
			let writeSpy: ReturnType<typeof vi.spyOn>;
			let stdoutIsTTY: boolean | undefined;

			beforeEach(() => {
				stdin = new FakeStdin();
				vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
				writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
				stdoutIsTTY = process.stdout.isTTY;
				process.stdout.isTTY = true;
			});

			afterEach(() => {
				process.stdout.isTTY = stdoutIsTTY as true;
				vi.restoreAllMocks();
			});

			it('waits for a key without blocking and expands the hidden outputs on M', () => {
				report();

				expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Press M for 6 more outputs'));
				expect(stdin.setRawMode).toHaveBeenCalledWith(true);
				expect(stdin.resume).toHaveBeenCalled();
				expect(stdin.unref).toHaveBeenCalled();
				expect(output()).not.toContain('dist/output-15.js');

				stdin.emit('data', Buffer.from('M'));

				expect(output()).toContain('dist/output-8.js');
				expect(output().match(/Build succeeded/g)).toHaveLength(2);
				expect(consoleSpy.mock.calls.at(-1)?.[0]).toMatch(/Build succeeded.*\n$/);
				expect(stdin.isRaw).toBe(false);
				expect(stdin.pause).toHaveBeenCalled();
				expect(stdin.ref).toHaveBeenCalled();
				expect(stdin.listenerCount('data')).toBe(0);
			});

			it('never prompts unless the report is interactive', () => {
				report(false);

				expect(stdin.setRawMode).not.toHaveBeenCalled();
				expect(writeSpy).not.toHaveBeenCalled();
				expect(output()).toContain('… and 6 more; use "--outputStyle detailed" to list all outputs');
				expect(consoleSpy.mock.calls.at(-1)?.[0]).toBe('');
			});

			it('dismisses the prompt on any other key', () => {
				report();
				stdin.emit('data', 'x');

				expect(output()).not.toContain('dist/output-15.js');
				expect(output().match(/Build succeeded/g)).toHaveLength(1);
				expect(consoleSpy.mock.calls.at(-1)?.[0]).toBe('');
				expect(stdin.listenerCount('data')).toBe(0);
			});

			it('forwards ctrl+c as SIGINT', () => {
				const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
				report();
				stdin.emit('data', '\u0003');

				expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
			});

			it('dismisses a pending prompt before other output is logged', () => {
				report();
				Logger.warn('rebuilding');

				expect(stdin.listenerCount('data')).toBe(0);
				expect(stdin.isRaw).toBe(false);
				expect(consoleSpy.mock.calls.at(-1)?.[0]).toContain('rebuilding');
			});

			describe('with status lines logged while pending', () => {
				let rows: number;
				let columns: number;

				beforeEach(() => {
					({ rows, columns } = process.stdout);
					Object.assign(process.stdout, { rows: 40, columns: 100 });
				});

				afterEach(() => {
					Object.assign(process.stdout, { rows, columns });
				});

				it('keeps the prompt pinned below single-line info messages', () => {
					report();
					writeSpy.mockClear();
					Logger.info('Watching for changes in: src');

					expect(stdin.listenerCount('data')).toBe(1);
					expect(consoleSpy.mock.calls.slice(-2).map(([ line ]) => line)).toEqual([ '', expect.stringContaining('Watching for changes in: src') ]);
					expect(writeSpy).toHaveBeenLastCalledWith(expect.stringContaining('Press M for 6 more outputs'));
				});

				it('expands in place and replays the status lines below the summary', () => {
					report();
					Logger.info('Watching for changes in: src');
					consoleSpy.mockClear();
					stdin.emit('data', 'm');

					expect(writeSpy).toHaveBeenCalledWith('\x1b[2A\x1b[J');
					const lines = consoleSpy.mock.calls.map(([ line ]) => String(line));
					expect(lines.join('\n')).toContain('dist/output-20.js');
					expect(lines.at(-2)).toContain('Build succeeded');
					expect(lines.at(-1)).toContain('Watching for changes in: src');
				});

				it('replays every status line logged while pending', () => {
					report();
					Logger.info('first');
					Logger.info('second');
					consoleSpy.mockClear();
					stdin.emit('data', 'm');

					expect(writeSpy).toHaveBeenCalledWith('\x1b[3A\x1b[J');
					expect(consoleSpy.mock.calls.slice(-2).map(([ line ]) => String(line))).toEqual([ expect.stringContaining('first'), expect.stringContaining('second') ]);
				});

				it('expands below the status lines when they cannot be redrawn', () => {
					Object.assign(process.stdout, { columns: 10 });
					report();
					Logger.info('Watching for changes in: src');
					consoleSpy.mockClear();
					stdin.emit('data', 'm');

					expect(writeSpy).not.toHaveBeenCalledWith(expect.stringMatching(/\x1b\[\d+A/));
					const lines = consoleSpy.mock.calls.map(([ line ]) => String(line));
					expect(lines.join('\n')).toContain('dist/output-20.js');
					expect(lines.at(-1)).toContain('Build succeeded');
				});

				it('leaves the status lines in place when dismissed', () => {
					report();
					Logger.info('Watching for changes in: src');
					consoleSpy.mockClear();
					stdin.emit('data', 'x');

					expect(consoleSpy).not.toHaveBeenCalled();
					expect(stdin.listenerCount('data')).toBe(0);
				});
			});

			it('dismisses the prompt on a stdin error even if the terminal cannot be restored', () => {
				report();
				stdin.setRawMode.mockImplementation(() => { throw new Error('EIO') });
				stdin.emit('error', new Error('EIO'));

				expect(stdin.listenerCount('data')).toBe(0);
				expect(output()).not.toContain('dist/output-15.js');
			});

			it('falls back to the omitted-count note when stdout is not a terminal', () => {
				process.stdout.isTTY = false as true;
				report();

				expect(stdin.setRawMode).not.toHaveBeenCalled();
				expect(output()).toContain('… and 6 more; use "--outputStyle detailed" to list all outputs');
			});

			it('falls back to the omitted-count note when raw mode is unavailable', () => {
				stdin.setRawMode.mockImplementation(() => { throw new Error('EIO') });
				report();

				expect(output()).toContain('… and 6 more; use "--outputStyle detailed" to list all outputs');
				expect(stdin.listenerCount('data')).toBe(0);
			});
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

		it('shows grouped sub-steps below the threshold and nests their files', () => {
			const steps: PerformanceSubStep[] = [
				{ name: 'Fast', ms: 1, duration: '1ms', result: [{ path: 'dist/index.js' as RelativePath, size: 100 }] },
			];

			Logger.subSteps(steps, true);

			expect(consoleSpy).toHaveBeenCalledTimes(2);
			expect(consoleSpy.mock.calls[0][0]).toContain('Fast');
			expect(consoleSpy.mock.calls[0][0]).toContain('(1ms)');
			expect(consoleSpy.mock.calls[1][0]).toContain('     └─');
			expect(consoleSpy.mock.calls[1][0]).toContain('dist/index.js');
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
