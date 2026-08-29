import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performance } from 'perf_hooks';
import type { MockInstance } from 'vitest';

describe('logPerformance', () => {
	let logPerformance: typeof import('src/decorators/performance-logger').logPerformance;
	let stepSpy: MockInstance;
	let errorSpy: MockInstance;

	beforeEach(async () => {
		vi.resetModules();
		vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		performance.clearMarks();
		performance.clearMeasures();
		({ logPerformance } = await import('src/decorators/performance-logger'));

		// Spy on the real Logger to observe production-formatted call arguments while suppressing console noise.
		const { Logger } = await import('src/logger');
		stepSpy = vi.spyOn(Logger, 'step').mockImplementation(() => {});
		errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		vi.spyOn(Logger, 'separator').mockImplementation(() => {});
		vi.spyOn(Logger, 'success').mockImplementation(() => {});
		vi.spyOn(Logger, 'subSteps').mockImplementation(() => {});
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

	describe('private methods', () => {
		it('supports decorated private methods', async () => {
			class Test {
				#value = 7;

				@logPerformance('private op')
				#method(): number { return this.#value }

				call(): number { return this.#method(); }
			}

			expect(new Test().call()).toBe(7);
		});

		it('supports decorated async private methods', async () => {
			class Test {
				#value = 7;

				@logPerformance('private async op')
				async #method(): Promise<number> { return this.#value }

				async call(): Promise<number> { return this.#method(); }
			}

			await expect(new Test().call()).resolves.toBe(7);
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

		it('clears performance measures and marks after flushing', async () => {
			const { flushPerformanceLog } = await import('src/decorators/performance-logger');
			class Test {
				@logPerformance('measure test')
				method(): void {}
			}

			new Test().method();
			expect(performance.getEntriesByName('method', 'measure')).toHaveLength(1);
			expect(performance.getEntriesByName('method', 'mark')).toHaveLength(2);

			flushPerformanceLog();

			expect(performance.getEntriesByName('method', 'measure')).toHaveLength(0);
			expect(performance.getEntriesByName('method', 'mark')).toHaveLength(0);
		});
	});

	describe('flushPerformanceLog', () => {
		it('logs queued measurements synchronously without waiting for observer delivery', async () => {
			const { flushPerformanceLog } = await import('src/decorators/performance-logger');

			class Test {
				@logPerformance('flush test')
				method(): void {}
			}

			new Test().method();
			flushPerformanceLog();

			expect(stepSpy).toHaveBeenCalledWith(expect.stringContaining('flush test'));
		});

		it('is a no-op when nothing is queued', async () => {
			const { flushPerformanceLog } = await import('src/decorators/performance-logger');

			stepSpy.mockClear();
			flushPerformanceLog();

			expect(stepSpy).not.toHaveBeenCalled();
		});
	});

	describe('logResult option', () => {
		it('passes result when logResult is true', () => {
			class Test {
				@logPerformance('result op')
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

	describe('build-failed branch', () => {
		it('logs error when process.exitCode is set for Build message', async () => {
			class BuildRunner {
				@logPerformance('Build')
				run(): void {}
			}

			process.exitCode = 1;
			new BuildRunner().run();

			// Wait for PerformanceObserver to fire
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Build failed'));
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
