import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { Closable } from '../src/@types';
import type { processManager as ProcessManagerType } from '../src/process-manager';
import { alwaysUndefined } from 'src/constants';

vi.mock('node:timers/promises', () => ({
	setTimeout: (milliseconds: number) => new Promise<void>((resolve) => { globalThis.setTimeout(resolve, milliseconds) }),
}));

describe('ProcessManager', () => {
	let processManager: typeof ProcessManagerType;
	let exitSpy: MockInstance;
	let warnSpy: MockInstance;
	let errorSpy: MockInstance;
	let sigintListenersBefore: Function[];
	let processManagerSigintListeners: Array<() => void>;

	beforeEach(async () => {
		sigintListenersBefore = process.listeners('SIGINT');
		vi.resetModules();
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(alwaysUndefined as never);

			const { Logger } = await import('../src/logger');
		warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
		errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});

		const mod = await import('../src/process-manager');
		processManager = mod.processManager;

		const sigintListenersAfter = process.listeners('SIGINT');
		processManagerSigintListeners = sigintListenersAfter.filter((l) => !sigintListenersBefore.includes(l)) as Array<() => void>;
	});

	afterEach(() => {
		processManager.close();
		vi.restoreAllMocks();
	});

	describe('addCloseable', () => {
		it('adds a closeable that is called on exit', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			process.emit('exit', 0);
			expect(closable.close).toHaveBeenCalled();
		});

		it('adds multiple closeables', () => {
			const closables = [{ close: vi.fn() }, { close: vi.fn() }, { close: vi.fn() }];
			for (const c of closables) { processManager.addCloseable(c) }

			process.emit('exit', 0);
			for (const c of closables) { expect(c.close).toHaveBeenCalled() }
		});
	});

	describe('removeCloseable', () => {
		it('removes a closeable so it is not called on subsequent exit', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			processManager.removeCloseable(closable);
			process.emit('exit', 0);
			expect(closable.close).not.toHaveBeenCalled();
		});

		it('only removes the targeted closeable, leaving others intact', () => {
			const closable1: Closable = { close: vi.fn() };
			const closable2: Closable = { close: vi.fn() };
			processManager.addCloseable(closable1);
			processManager.addCloseable(closable2);

			processManager.removeCloseable(closable1);
			process.emit('exit', 0);
			expect(closable1.close).not.toHaveBeenCalled();
			expect(closable2.close).toHaveBeenCalledOnce();
		});

		it('is a no-op when the closeable was never added', () => {
			const closable: Closable = { close: vi.fn() };
			expect(() => processManager.removeCloseable(closable)).not.toThrow();

			process.emit('exit', 0);
			expect(closable.close).not.toHaveBeenCalled();
		});

		it('is idempotent when called multiple times for the same closeable', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			processManager.removeCloseable(closable);
			expect(() => processManager.removeCloseable(closable)).not.toThrow();

			process.emit('exit', 0);
			expect(closable.close).not.toHaveBeenCalled();
		});
	});

	describe('close', () => {
		it('clears all closeables so they are not called on subsequent exit', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			processManager.close();
			vi.clearAllMocks();
			process.emit('exit', 0);
			expect(closable.close).not.toHaveBeenCalled();
		});

		it('removes process listeners after close', () => {
			const beforeClose = process.listeners('SIGINT');
			processManager.close();
			const afterClose = process.listeners('SIGINT');
			expect(afterClose).toEqual(beforeClose.filter((l) => !processManagerSigintListeners.includes(l as () => void)));
		});
	});

	describe('cleanup resilience', () => {
		it('reports asynchronous cleanup failures without skipping other resources', async () => {
			const rejecting: Closable = { close: vi.fn().mockRejectedValue(new Error('async cleanup failed')) };
			const after: Closable = { close: vi.fn() };
			processManager.addCloseable(rejecting);
			processManager.addCloseable(after);

			process.emit('exit', 0);
			await Promise.resolve();
			expect(after.close).toHaveBeenCalledOnce();
			expect(errorSpy).toHaveBeenCalledWith('Error while closing Object #1...', expect.stringContaining('async cleanup failed'));
		});

		it('continues closing remaining closeables when one removes itself during cleanup', () => {
			const selfRemoving: Closable = { close: vi.fn(() => processManager.removeCloseable(selfRemoving)) };
			const after: Closable = { close: vi.fn() };
			processManager.addCloseable(selfRemoving);
			processManager.addCloseable(after);

			process.emit('exit', 0);
			expect(selfRemoving.close).toHaveBeenCalledOnce();
			expect(after.close).toHaveBeenCalledOnce();
		});

		it('continues closing remaining closeables when one throws during cleanup', () => {
			const throwing: Closable = { close: vi.fn(() => { throw new Error('boom') }) };
			const after: Closable = { close: vi.fn() };
			processManager.addCloseable(throwing);
			processManager.addCloseable(after);

			expect(() => process.emit('exit', 0)).not.toThrow();
			expect(throwing.close).toHaveBeenCalledOnce();
			expect(after.close).toHaveBeenCalledOnce();
			expect(errorSpy).toHaveBeenCalledWith('Error while closing Object #1...', expect.stringContaining('boom'));
		});
	});

	describe('exit event handling', () => {
		it('calls close on all closeables when exit fires', () => {
			const closable1: Closable = { close: vi.fn() };
			const closable2: Closable = { close: vi.fn() };
			processManager.addCloseable(closable1);
			processManager.addCloseable(closable2);

			process.emit('exit', 0);
			expect(closable1.close).toHaveBeenCalledOnce();
			expect(closable2.close).toHaveBeenCalledOnce();
		});

		it('does not re-enter cleanup when exit fires during cleanup', () => {
			const closable: Closable = { close: vi.fn(() => process.emit('exit', 0)) };
			processManager.addCloseable(closable);

			process.emit('exit', 0);

			expect(closable.close).toHaveBeenCalledOnce();
		});

		it('does not close twice if hasHandledExit is set by SIGINT', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			for (const listener of processManagerSigintListeners) { listener() }
			vi.clearAllMocks();

			process.emit('exit', 0);
			expect(closable.close).not.toHaveBeenCalled();
		});
	});

	describe('SIGINT handling', () => {
		const waitForCleanup = () => new Promise<void>((resolve) => { setImmediate(resolve) });

		it('does not log a termination message', () => {
			for (const listener of processManagerSigintListeners) { listener() }
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('calls close on all closeables', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			for (const listener of processManagerSigintListeners) { listener() }
			expect(closable.close).toHaveBeenCalledOnce();
		});

		it('exits with code 0 for user cancellation', async () => {
			for (const listener of processManagerSigintListeners) { listener() }
			await waitForCleanup();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it('waits for asynchronous cleanup before exiting', async () => {
			let resolveCleanup!: () => void;
			const cleanup = new Promise<void>((resolve) => { resolveCleanup = resolve });
			const closable: Closable = { close: vi.fn(() => cleanup) };
			processManager.addCloseable(closable);

			for (const listener of processManagerSigintListeners) { listener() }
			expect(closable.close).toHaveBeenCalledOnce();
			expect(exitSpy).not.toHaveBeenCalled();

			resolveCleanup();
			await waitForCleanup();
			expect(exitSpy).toHaveBeenCalledWith(0);
		});

		it('exits when asynchronous cleanup exceeds the timeout', async () => {
			vi.useFakeTimers();
			try {
				const cleanup = new Promise<void>(() => {});
				processManager.addCloseable({ close: vi.fn(() => cleanup) });

				for (const listener of processManagerSigintListeners) { listener() }
				await vi.advanceTimersByTimeAsync(5000);

				expect(exitSpy).toHaveBeenCalledWith(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('sets hasHandledExit flag to prevent double-close', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			for (const listener of processManagerSigintListeners) { listener() }
			vi.clearAllMocks();
			process.emit('exit', 0);
			expect(closable.close).not.toHaveBeenCalled();
		});
	});

	describe('uncaughtException handling', () => {
		it('logs the exception with stack trace', () => {
			const err = new Error('Test Exception');
			process.emit('uncaughtException', err);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Uncaught Exception...'), err.stack);
		});

		it('exits with code 99', () => {
			process.emit('uncaughtException', new Error('Test'));
			expect(exitSpy).toHaveBeenCalledWith(99);
		});

		it('handles errors without stack traces', () => {
			const err = new Error('No stack');
			delete err.stack;
			process.emit('uncaughtException', err);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Uncaught Exception...'), undefined);
			expect(exitSpy).toHaveBeenCalledWith(99);
		});
	});
});
