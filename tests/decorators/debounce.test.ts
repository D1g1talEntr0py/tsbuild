import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce, debounceManager } from 'src/decorators/debounce';

describe('debounce', () => {
	beforeEach(() => { vi.useFakeTimers() });
	afterEach(() => { vi.useRealTimers() });

	describe('decorator behavior', () => {
		it('initializes one debounced public method per instance', () => {
			const debounceSpy = vi.spyOn(debounceManager, 'debounce');

			class Counter {
				count = 0;

				@debounce(100)
				increment() { this.count++ }
			}

			const first = new Counter();
			const second = new Counter();

			expect(debounceSpy).toHaveBeenCalledTimes(2);

			first.increment();
			first.increment();
			second.increment();

			expect(debounceSpy).toHaveBeenCalledTimes(2);

			debounceSpy.mockRestore();
		});

		it('delays method execution until wait expires', async () => {
			class Counter {
				count = 0;

				@debounce(100)
				increment() { this.count++ }
			}

			const instance = new Counter();
			instance.increment();
			expect(instance.count).toBe(0);

			vi.advanceTimersByTime(100);
			await Promise.resolve();

			expect(instance.count).toBe(1);
		});

		it('only executes once for rapid calls', async () => {
			class Counter {
				count = 0;

				@debounce(100)
				increment() { this.count++ }
			}

			const instance = new Counter();
			instance.increment();
			instance.increment();
			instance.increment();

			vi.advanceTimersByTime(100);
			await Promise.resolve();

			expect(instance.count).toBe(1);
		});

		it('preserves this context', async () => {
			class Context {
				value = 'test';
				result = '';

				@debounce(100)
				capture() { this.result = this.value }
			}

			const instance = new Context();
			instance.capture();

			vi.advanceTimersByTime(100);
			await Promise.resolve();

			expect(instance.result).toBe('test');
		});

		it('passes arguments to the debounced method', async () => {
			class Adder {
				sum = 0;

				@debounce(50)
				add(a: number, b: number) { this.sum = a + b }
			}

			const instance = new Adder();
			instance.add(3, 4);

			vi.advanceTimersByTime(50);
			await Promise.resolve();

			expect(instance.sum).toBe(7);
		});

		it('uses last call arguments when debounced', async () => {
			class Tracker {
				lastArg = '';

				@debounce(100)
				track(val: string) { this.lastArg = val }
			}

			const instance = new Tracker();
			instance.track('first');
			instance.track('second');
			instance.track('third');

			vi.advanceTimersByTime(100);
			await Promise.resolve();

			expect(instance.lastArg).toBe('third');
		});
	});

	describe('promise behavior', () => {
		it('returns a promise', () => {
			class Test {
				@debounce(100)
				method() { return 'value' }
			}

			const instance = new Test();
			const result = instance.method();
			expect(result).toBeInstanceOf(Promise);
		});

		it('resolves earlier calls with undefined on cancellation', async () => {
			class Test {
				@debounce(100)
				method() { return 'final' }
			}

			const instance = new Test();
			const first = instance.method();
			const second = instance.method();

			vi.advanceTimersByTime(100);

			expect(await first).toBeUndefined();
			expect(await second).toBe('final');
		});
	});

	describe('error handling', () => {
		it('throws if wait is negative', () => {
			expect(() => {
				class _Test {
					@debounce(-10)
					method() {}
				}
				void _Test;
			}).toThrow('wait must be non-negative');
		});

		it('rejects promise when method throws Error', async () => {
			class Test {
				@debounce(100)
				bad() { throw new Error('method failed') }
			}

			const instance = new Test();
			const promise = instance.bad();

			vi.advanceTimersByTime(100);

			await expect(promise).rejects.toThrow('method failed');
		});

		it('rejects with casted error for non-Error throws', async () => {
			class Test {
				@debounce(100)
				bad() { throw 'string error' }
			}

			const instance = new Test();
			const promise = instance.bad();

			vi.advanceTimersByTime(100);

			await expect(promise).rejects.toThrow('string error');
		});
	});

	describe('zero wait', () => {
		it('supports wait of 0', async () => {
			class Test {
				called = false;

				@debounce(0)
				run() { this.called = true }
			}

			const instance = new Test();
			instance.run();

			vi.advanceTimersByTime(0);
			await Promise.resolve();

			expect(instance.called).toBe(true);
		});
	});

	describe('DebounceManager.close via process exit', () => {
		it('clears all active timers when process exits', async () => {
			class Test {
				count = 0;

				@debounce(200)
				increment() { this.count++ }
			}

			const instance = new Test();
			// Create pending timers
			instance.increment();
			instance.increment();

			// Trigger process exit handler which calls close() on all closeables
			// including the module-level DebounceManager instance
			process.emit('exit', 0);

			// Advance timers — the pending debounce should have been cleared
			vi.advanceTimersByTime(200);
			await vi.advanceTimersByTimeAsync(0);

			expect(instance.count).toBe(0);
		});
	});

	describe('private method support', () => {
		it('initializes one debounced private method per instance', () => {
			const debounceSpy = vi.spyOn(debounceManager, 'debounce');

			class Counter {
				#count = 0;

				@debounce(100)
				#increment() { this.#count++ }

				trigger() { void this.#increment() }
			}

			const first = new Counter();
			const second = new Counter();

			expect(debounceSpy).toHaveBeenCalledTimes(2);

			first.trigger();
			first.trigger();
			second.trigger();

			expect(debounceSpy).toHaveBeenCalledTimes(2);

			debounceSpy.mockRestore();
		});

		it('debounces a private method correctly', async () => {
			class Counter {
				#count = 0;

				@debounce(100)
				#increment() { this.#count++ }

				trigger() { void this.#increment() }
				get count() { return this.#count }
			}

			const instance = new Counter();
			instance.trigger();
			instance.trigger();
			instance.trigger();

			expect(instance.count).toBe(0);

			vi.advanceTimersByTime(100);
			await Promise.resolve();

			expect(instance.count).toBe(1);
		});

		it('maintains independent state per instance', async () => {
			class Counter {
				#count = 0;

				@debounce(100)
				#increment() { this.#count++ }

				trigger() { void this.#increment() }
				get count() { return this.#count }
			}

			const a = new Counter();
			const b = new Counter();

			a.trigger();
			b.trigger();
			b.trigger();

			vi.advanceTimersByTime(100);
			await Promise.resolve();

			expect(a.count).toBe(1);
			expect(b.count).toBe(1);
		});
	});
});
