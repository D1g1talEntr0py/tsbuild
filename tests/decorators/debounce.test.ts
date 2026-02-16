import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from '../../src/decorators/debounce';

describe('debounce decorator', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('should debounce a method', async () => {
		class TestClass {
			count = 0;

			@debounce(100)
			increment() {
				this.count++;
			}
		}

		const instance = new TestClass();
		instance.increment();
		instance.increment();
		instance.increment();

		expect(instance.count).toBe(0);

		vi.advanceTimersByTime(100);

		// Wait for promise resolution (debounce returns a promise internally)
		await Promise.resolve();

		expect(instance.count).toBe(1);
	});

	it('should preserve context', async () => {
		class TestClass {
			value = 'test';
			result = '';

			@debounce(100)
			method() {
				this.result = this.value;
			}
		}

		const instance = new TestClass();
		instance.method();

		vi.advanceTimersByTime(100);
		await Promise.resolve();

		expect(instance.result).toBe('test');
	});

	it('should throw if wait is negative', () => {
		expect(() => {
			class TestClass {
				@debounce(-10)
				method() {}
			}
		}).toThrow('wait must be non-negative');
	});

	it('should reject with casted error when method throws', async () => {
		class TestClass {
			@debounce(100)
			throwingMethod() {
				throw new Error('method failed');
			}
		}

		const instance = new TestClass();
		const promise = instance.throwingMethod();

		vi.advanceTimersByTime(100);

		await expect(promise).rejects.toThrow('method failed');
	});

	it('should reject with casted error for non-Error throws', async () => {
		class TestClass {
			@debounce(100)
			throwingMethod() {
				throw 'string error';
			}
		}

		const instance = new TestClass();
		const promise = instance.throwingMethod();

		vi.advanceTimersByTime(100);

		await expect(promise).rejects.toThrow('string error');
	});
});
