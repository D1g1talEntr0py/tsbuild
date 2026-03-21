import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performance } from 'perf_hooks';

vi.mock('src/logger', () => ({
	Logger: {
		info: vi.fn(), error: vi.fn(), log: vi.fn(), clear: vi.fn(),
		warn: vi.fn(), success: vi.fn(), header: vi.fn(), separator: vi.fn(),
		step: vi.fn(), subSteps: vi.fn(),
		EntryType: { Info: 'info', Success: 'success', Done: 'done', Error: 'error', Warn: 'warn' }
	}
}));

describe('logPerformance', () => {
	let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
	let logPerformance: typeof import('src/decorators/performance-logger').logPerformance;
	let addPerformanceStep: typeof import('src/decorators/performance-logger').addPerformanceStep;

	beforeEach(async () => {
		vi.resetModules();
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		performance.clearMarks();
		performance.clearMeasures();
		({ logPerformance, addPerformanceStep } = await import('src/decorators/performance-logger'));
	});

	afterEach(async () => {
		const { processManager } = await import('src/process-manager');
		processManager.close();
		vi.restoreAllMocks();
		performance.clearMarks();
		performance.clearMeasures();
	});

	describe('sync methods', () => {
		it('preserves return value', () => {
			class Test {
				@logPerformance('sync op')
				method(): string { return 'result' }
			}

			expect(new Test().method()).toBe('result');
		});

		it('preserves this context', () => {
			class Test {
				value = 100;

				@logPerformance('ctx op')
				method(): number { return this.value }
			}

			expect(new Test().method()).toBe(100);
		});

		it('preserves parameters', () => {
			class Test {
				@logPerformance('param op')
				method(a: number, b: string): string { return `${a}-${b}` }
			}

			expect(new Test().method(42, 'test')).toBe('42-test');
		});

		it('propagates errors', () => {
			class Test {
				@logPerformance('error op')
				method(): never { throw new Error('test error') }
			}

			expect(() => new Test().method()).toThrow('test error');
		});
	});

	describe('async methods', () => {
		it('preserves resolved value', async () => {
			class Test {
				@logPerformance('async op')
				async method(): Promise<number> { return 42 }
			}

			expect(await new Test().method()).toBe(42);
		});

		it('propagates rejections', async () => {
			class Test {
				@logPerformance('async err')
				async method(): Promise<never> { throw new Error('async error') }
			}

			await expect(new Test().method()).rejects.toThrow('async error');
		});
	});

	describe('performance marks and measures', () => {
		it('creates performance marks', () => {
			class Test {
				@logPerformance('mark test')
				method(): void {}
			}

			performance.clearMarks();
			new Test().method();

			const marks = performance.getEntriesByType('mark');
			expect(marks.length).toBeGreaterThan(0);
		});

		it('creates performance measures', async () => {
			class Test {
				@logPerformance('measure test')
				method(): void {}
			}

			performance.clearMeasures();
			new Test().method();

			// Wait for PerformanceObserver to process
			await new Promise(resolve => setTimeout(resolve, 50));

			const measures = performance.getEntriesByType('measure');
			expect(measures.length).toBeGreaterThan(0);
		});
	});

	describe('logResult option', () => {
		it('passes result when logResult is true', () => {
			class Test {
				@logPerformance('result op', true)
				method(): number[] { return [1, 2, 3] }
			}

			expect(new Test().method()).toEqual([1, 2, 3]);
		});
	});

	describe('multiple methods', () => {
		it('supports multiple decorated methods on one class', () => {
			class Test {
				@logPerformance('op1')
				method1(): number { return 1 }

				@logPerformance('op2')
				method2(): number { return 2 }
			}

			const instance = new Test();
			expect(instance.method1()).toBe(1);
			expect(instance.method2()).toBe(2);
		});
	});

	describe('symbol keys', () => {
		it('handles symbol property keys', () => {
			const key = Symbol('testMethod');

			class Test {
				@logPerformance('symbol op')
				[key](): string { return 'symbol result' }
			}

			expect(new Test()[key]()).toBe('symbol result');
		});
	});

	describe('addPerformanceStep', () => {
		it('accumulates sub-steps for the next measurement', async () => {
			const { Logger } = await import('src/logger');

			class Test {
				@logPerformance('op with steps')
				method(): void {
					addPerformanceStep('sub-step-1', 50);
					addPerformanceStep('sub-step-2', 100);
				}
			}

			new Test().method();

			// Wait for PerformanceObserver to fire
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(Logger.subSteps).toHaveBeenCalled();
		});
	});

	describe('build-failed branch', () => {
		it('logs error when process.exitCode is set for Build message', async () => {
			const { Logger } = await import('src/logger');

			class BuildRunner {
				@logPerformance('Build')
				run(): void {}
			}

			process.exitCode = 1;
			new BuildRunner().run();

			// Wait for PerformanceObserver to fire
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Build failed'));
			process.exitCode = undefined;
		});
	});

	describe('close', () => {
		it('disconnects the performance observer on process exit without errors', () => {
			// The PerformanceLogger is registered with processManager via @closeOnExit.
			// Emitting 'exit' triggers handleExit which calls close() on all closeables,
			// including the PerformanceLogger (which calls performanceObserver.disconnect()).
			expect(() => process.emit('exit', 0)).not.toThrow();
		});
	});
});
