import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Closable } from 'src/@types';

describe('closeOnExit', () => {
	let processManager: Awaited<typeof import('src/process-manager')>['processManager'];

	beforeEach(async () => {
		vi.resetModules();
		vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		({ processManager } = await import('src/process-manager'));
	});

	afterEach(() => {
		processManager.close();
		vi.restoreAllMocks();
	});

	it('registers instance with processManager on construction', async () => {
		const { closeOnExit } = await import('src/decorators/close-on-exit');
		const closeSpy = vi.fn();

		@closeOnExit
		class TestClosable implements Closable {
			close = closeSpy;
		}

		new TestClosable();

		process.emit('exit', 0);
		expect(closeSpy).toHaveBeenCalledOnce();
	});

	it('calls close on all decorated instances', async () => {
		const { closeOnExit } = await import('src/decorators/close-on-exit');
		const spyA = vi.fn();
		const spyB = vi.fn();

		@closeOnExit
		class A implements Closable { close = spyA }

		@closeOnExit
		class B implements Closable { close = spyB }

		new A();
		new B();

		process.emit('exit', 0);
		expect(spyA).toHaveBeenCalledOnce();
		expect(spyB).toHaveBeenCalledOnce();
	});

	it('preserves the original constructor behavior', async () => {
		const { closeOnExit } = await import('src/decorators/close-on-exit');

		@closeOnExit
		class WithArgs implements Closable {
			value: number;
			constructor(val: number) { this.value = val }
			close() {}
		}

		const instance = new WithArgs(42);
		expect(instance.value).toBe(42);
	});

	it('decorated instance is still instanceof original class', async () => {
		const { closeOnExit } = await import('src/decorators/close-on-exit');

		@closeOnExit
		class OriginalClass implements Closable {
			close() {}
		}

		const instance = new OriginalClass();
		expect(instance).toBeInstanceOf(OriginalClass);
	});
});
