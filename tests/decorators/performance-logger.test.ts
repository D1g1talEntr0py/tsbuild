import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performance } from 'perf_hooks';

vi.mock('src/logger', () => ({
	Logger: {
		info: vi.fn(),
		error: vi.fn(),
		log: vi.fn(),
		clear: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		header: vi.fn(),
		separator: vi.fn(),
		step: vi.fn(),
		EntryType: { Info: 'info', Success: 'success', Done: 'done', Error: 'error', Warn: 'warn' }
	}
}));

describe('decorators/performance-logger', () => {
	let exitSpy: any;
	let logPerformance: typeof import('../../src/decorators/performance-logger').logPerformance;

	beforeEach(async () => {
		vi.resetModules();
		// Mock process.exit to prevent test crashes from @closeOnExit decorator
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		// Clear any existing performance marks/measures
		performance.clearMarks();
		performance.clearMeasures();
		({ logPerformance } = await import('../../src/decorators/performance-logger'));
	});

	afterEach(async () => {
		const { processManager } = await import('../../src/process-manager');
		processManager.close();
		vi.restoreAllMocks();
		performance.clearMarks();
		performance.clearMeasures();
	});

	describe('@logPerformance decorator', () => {
		it('should not affect the return value of synchronous methods', () => {
			class TestClass {
				@logPerformance('Test operation')
				syncMethod(): string {
					return 'result';
				}
			}

			const instance = new TestClass();
			const result = instance.syncMethod();

			expect(result).toBe('result');
		});

		it('should not affect the return value of async methods', async () => {
			class TestClass {
				@logPerformance('Async operation')
				async asyncMethod(): Promise<number> {
					return 42;
				}
			}

			const instance = new TestClass();
			const result = await instance.asyncMethod();

			expect(result).toBe(42);
		});

		it('should create performance marks for methods', () => {
			class TestClass {
				@logPerformance('Test operation')
				testMethod(): void {
					// Method body
				}
			}

			const instance = new TestClass();
			performance.clearMarks();

			instance.testMethod();

			// Marks are created with the method name as key
			const marks = performance.getEntriesByType('mark');
			expect(marks.length).toBeGreaterThan(0);
		});

		it('should create performance measures for methods', async () => {
			class TestClass {
				@logPerformance('Test operation')
				testMethod(): void {
					// Method body
				}
			}

			const instance = new TestClass();
			performance.clearMeasures();

			instance.testMethod();

			// Wait for PerformanceObserver to process
			await new Promise(resolve => setTimeout(resolve, 50));

			const measures = performance.getEntriesByType('measure');
			expect(measures.length).toBeGreaterThan(0);
		});

		it('should preserve method context (this binding)', () => {
			class TestClass {
				value = 100;

				@logPerformance('Method with context')
				methodUsingThis(): number {
					return this.value;
				}
			}

			const instance = new TestClass();
			const result = instance.methodUsingThis();

			expect(result).toBe(100);
		});

		it('should handle methods with parameters', () => {
			class TestClass {
				@logPerformance('Method with params')
				methodWithParams(a: number, b: string): string {
					return `${a}-${b}`;
				}
			}

			const instance = new TestClass();
			const result = instance.methodWithParams(42, 'test');

			expect(result).toBe('42-test');
		});

		it('should work with multiple methods on the same class', () => {
			class TestClass {
				@logPerformance('Method 1')
				method1(): number {
					return 1;
				}

				@logPerformance('Method 2')
				method2(): number {
					return 2;
				}

				@logPerformance('Method 3')
				method3(): number {
					return 3;
				}
			}

			const instance = new TestClass();

			expect(instance.method1()).toBe(1);
			expect(instance.method2()).toBe(2);
			expect(instance.method3()).toBe(3);
		});

		it('should handle symbol property keys', () => {
			const methodKey = Symbol('testMethod');

			class TestClass {
				@logPerformance('Symbol method')
				[methodKey](): string {
					return 'symbol result';
				}
			}

			const instance = new TestClass();
			const result = instance[methodKey]();

			expect(result).toBe('symbol result');
		});

		it('should handle methods that throw errors', () => {
			class TestClass {
				@logPerformance('Error method')
				errorMethod(): never {
					throw new Error('Test error');
				}
			}

			const instance = new TestClass();

			expect(() => instance.errorMethod()).toThrow('Test error');
		});

		it('should handle async methods that reject', async () => {
			class TestClass {
				@logPerformance('Async error method')
				async asyncErrorMethod(): Promise<never> {
					throw new Error('Async test error');
				}
			}

			const instance = new TestClass();

			await expect(instance.asyncErrorMethod()).rejects.toThrow('Async test error');
		});

		it('should handle methods returning arrays', () => {
			class TestClass {
				@logPerformance('Array result', true)
				arrayMethod(): number[] {
					return [1, 2, 3, 4, 5];
				}
			}

			const instance = new TestClass();
			const result = instance.arrayMethod();

			expect(result).toEqual([1, 2, 3, 4, 5]);
		});

		it('should handle methods returning objects', () => {
			class TestClass {
				@logPerformance('Object result')
				objectMethod(): { data: string } {
					return { data: 'test' };
				}
			}

			const instance = new TestClass();
			const result = instance.objectMethod();

			expect(result).toEqual({ data: 'test' });
		});

		it('should handle async methods with delays', async () => {
			class TestClass {
				@logPerformance('Slow operation')
				async slowMethod(): Promise<string> {
					await new Promise(resolve => setTimeout(resolve, 10));
					return 'done';
				}
			}

			const instance = new TestClass();
			const result = await instance.slowMethod();

			expect(result).toBe('done');
		});

		it('should not interfere with method chaining', () => {
			class TestClass {
				value = 0;

				@logPerformance('Add operation')
				add(n: number): this {
					this.value += n;
					return this;
				}

				@logPerformance('Multiply operation')
				multiply(n: number): this {
					this.value *= n;
					return this;
				}
			}

			const instance = new TestClass();
			instance.add(10).multiply(2);

			expect(instance.value).toBe(20);
		});

		it('should handle methods with rest parameters', () => {
			class TestClass {
				@logPerformance('Rest params method')
				sumAll(...numbers: number[]): number {
					return numbers.reduce((a, b) => a + b, 0);
				}
			}

			const instance = new TestClass();
			const result = instance.sumAll(1, 2, 3, 4, 5);

			expect(result).toBe(15);
		});

		it('should cleanup performance observer on SIGINT', async () => {
			const sigintListenersBefore = process.listeners('SIGINT');
			// Import processManager to trigger SIGINT handling
			const { processManager } = await import('../../src/process-manager');
			const sigintListenersAfter = process.listeners('SIGINT');
			const processManagerListeners = sigintListenersAfter.filter((l) => !sigintListenersBefore.includes(l)) as Array<() => void>;

			class TestClass {
				@logPerformance('Test before SIGINT')
				testMethod(): string {
					return 'result';
				}
			}

			const instance = new TestClass();

			// Method should work before SIGINT
			expect(instance.testMethod()).toBe('result');

			// Simulate SIGINT handling without emitting SIGINT on the real process
			for (const listener of processManagerListeners) { listener(); }

			// The close method should have been called (covered by this test)
			// Method should still work after close (decorator doesn't break functionality)
			expect(instance.testMethod()).toBe('result');
		});
		it('should format durations > 1 minute correctly', async () => {
			vi.resetModules();
			
			let observerCallback: any;
			vi.doMock('perf_hooks', async () => {
				const actual = await vi.importActual<any>('perf_hooks');
				return {
					...actual,
					PerformanceObserver: class {
						constructor(cb: any) {
							observerCallback = cb;
						}
						observe = vi.fn();
						disconnect = vi.fn();
					}
				};
			});

			// Re-import to use the mock
			const { logPerformance } = await import('../../src/decorators/performance-logger');
			const { Logger } = await import('../../src/logger');
			const stepSpy = vi.spyOn(Logger, 'step').mockImplementation(() => {});

			class TestClass {
				@logPerformance('Long operation')
				longMethod(): void {}
			}

			const instance = new TestClass();
			instance.longMethod();

			// Trigger observer with > 1 minute duration
			const mockList = {
				getEntriesByType: () => [{
					name: 'TestClass.longMethod',
					duration: 65123, // 1m 5s 123ms
					detail: { message: 'Long operation' }
				}]
			};

			if (observerCallback) {
				observerCallback(mockList);
			} else {
				throw new Error('PerformanceObserver callback was not captured');
			}

			expect(stepSpy).toHaveBeenCalledWith(expect.stringContaining('1m5s123ms'));
		});

		it('should format durations > 1 second correctly', async () => {
			vi.resetModules();
			
			let observerCallback: any;
			vi.doMock('perf_hooks', async () => {
				const actual = await vi.importActual<any>('perf_hooks');
				return {
					...actual,
					PerformanceObserver: class {
						constructor(cb: any) {
							observerCallback = cb;
						}
						observe = vi.fn();
						disconnect = vi.fn();
					}
				};
			});

			const { logPerformance } = await import('../../src/decorators/performance-logger');
			const { Logger } = await import('../../src/logger');
			const stepSpy = vi.spyOn(Logger, 'step').mockImplementation(() => {});

			class TestClass {
				@logPerformance('Medium operation')
				mediumMethod(): void {}
			}

			const instance = new TestClass();
			instance.mediumMethod();

			// Trigger observer with > 1 second duration
			const mockList = {
				getEntriesByType: () => [{
					name: 'TestClass.mediumMethod',
					duration: 1500, // 1s 500ms
					detail: { message: 'Medium operation' }
				}]
			};

			if (observerCallback) {
				observerCallback(mockList);
			} else {
				throw new Error('PerformanceObserver callback was not captured');
			}

			expect(stepSpy).toHaveBeenCalledWith(expect.stringContaining('1s500ms'));
		});
	});
});
