import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Closable } from '../../src/@types';

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

describe('decorators/close-on-exit', () => {
	let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
	let processManager: any;
	let sigintListenersBefore: Function[];

	beforeEach(async () => {
		sigintListenersBefore = process.listeners('SIGINT');
		vi.resetModules();
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		
		// Import fresh processManager
		const pmModule = await import('../../src/process-manager');
		processManager = pmModule.processManager;
	});

	afterEach(() => {
		processManager.close();
		vi.restoreAllMocks();
	});

	describe('@closeOnExit decorator', () => {
		it('should call close on decorated instance when process exits', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');
			const closeSpy = vi.fn();

			@closeOnExit
			class TestClosable implements Closable {
				close = closeSpy;
			}

			new TestClosable();

			// Trigger exit event
			process.emit('exit', 0);

			expect(closeSpy).toHaveBeenCalledOnce();
		});

		it('should call close on decorated instances when process exits', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');
			const closeSpy = vi.fn();

			@closeOnExit
			class TestClosable implements Closable {
				close = closeSpy;
			}

			new TestClosable();
			new TestClosable();

			// Trigger exit event
			process.emit('exit', 0);

			expect(closeSpy).toHaveBeenCalledTimes(2);
		});

		it('should preserve constructor arguments', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');

			@closeOnExit
			class TestClosable implements Closable {
				constructor(
					public name: string,
					public value: number,
					public flag: boolean
				) {}
				close = vi.fn();
			}

			const instance = new TestClosable('test', 42, true);

			expect(instance.name).toBe('test');
			expect(instance.value).toBe(42);
			expect(instance.flag).toBe(true);
		});

		it('should preserve class methods and properties', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');

			@closeOnExit
			class TestClosable implements Closable {
				public count = 0;

				increment(): number {
					return ++this.count;
				}

				close = vi.fn();
			}

			const instance = new TestClosable();

			expect(instance.count).toBe(0);
			expect(instance.increment()).toBe(1);
			expect(instance.increment()).toBe(2);
			expect(instance.count).toBe(2);
		});

		it('should work with classes that have complex constructors', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');
			const closeSpy = vi.fn();

			@closeOnExit
			class ComplexClosable implements Closable {
				private data: Map<string, number>;

				constructor(entries: [string, number][]) {
					this.data = new Map(entries);
				}

				getData(): Map<string, number> {
					return this.data;
				}

				close = closeSpy;
			}

			const entries: [string, number][] = [['a', 1], ['b', 2], ['c', 3]];
			const instance = new ComplexClosable(entries);

			expect(instance.getData().size).toBe(3);
			expect(instance.getData().get('a')).toBe(1);
			expect(instance.getData().get('b')).toBe(2);
			expect(instance.getData().get('c')).toBe(3);

			// Verify it's registered for cleanup
			process.emit('exit', 0);
			expect(closeSpy).toHaveBeenCalled();
		});

		it('should handle SIGINT event for decorated instances', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');
			const closeSpy = vi.fn();

			@closeOnExit
			class TestClosable implements Closable {
				close = closeSpy;
			}

			new TestClosable();
			const sigintListenersAfter = process.listeners('SIGINT');
			const processManagerListeners = sigintListenersAfter.filter((l) => !sigintListenersBefore.includes(l));
			for (const listener of processManagerListeners) { (listener as () => void)(); }

			expect(closeSpy).toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledWith(130);
		});

		it('should allow multiple decorators on the same class', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');

			// Simple decorator that adds a property
			function addProperty<T extends new (...args: any[]) => any>(constructor: T) {
				return class extends constructor {
					decorated = true;
				};
			}

			@addProperty
			@closeOnExit
			class TestClosable implements Closable {
				close = vi.fn();
			}

			const instance: any = new TestClosable();

			expect(instance.decorated).toBe(true);
			expect(typeof instance.close).toBe('function');
		});

		it('should work with inheritance', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');
			const baseCloseSpy = vi.fn();
			const derivedCloseSpy = vi.fn();

			class BaseClosable implements Closable {
				close = baseCloseSpy;
			}

			@closeOnExit
			class DerivedClosable extends BaseClosable {
				close = derivedCloseSpy;
			}

			const instance = new DerivedClosable();

			process.emit('exit', 0);

			expect(derivedCloseSpy).toHaveBeenCalled();
		});

		it('should maintain instanceof checks', async () => {
			const { closeOnExit } = await import('../../src/decorators/close-on-exit');

			class BaseClass {
				close = vi.fn();
			}

			@closeOnExit
			class DecoratedClass extends BaseClass implements Closable {}

			const instance = new DecoratedClass();

			expect(instance instanceof DecoratedClass).toBe(true);
			expect(instance instanceof BaseClass).toBe(true);
		});
	});
});
