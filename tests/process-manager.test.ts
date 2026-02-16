import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { Closable } from '../src/@types';
import type { processManager as ProcessManagerType } from '../src/process-manager';

describe('process-manager', () => {
	let processManager: typeof ProcessManagerType;
	let exitSpy: MockInstance;
	let warnSpy: MockInstance;
	let errorSpy: MockInstance;
	let sigintListenersBefore: Function[];
	let processManagerSigintListeners: Array<() => void>;

	beforeEach(async () => {
		sigintListenersBefore = process.listeners('SIGINT');
		vi.resetModules();
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
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
		it('should add a closeable to the list', () => {
			const closable: Closable = {
				close: vi.fn(),
			};

			processManager.addCloseable(closable);

			// Trigger exit to verify it was added
			process.emit('exit', 0);

			expect(closable.close).toHaveBeenCalled();
		});

		it('should add multiple closeables', () => {
			const closable1: Closable = { close: vi.fn() };
			const closable2: Closable = { close: vi.fn() };
			const closable3: Closable = { close: vi.fn() };

			processManager.addCloseable(closable1);
			processManager.addCloseable(closable2);
			processManager.addCloseable(closable3);

			// Trigger exit to verify all were added
			process.emit('exit', 0);

			expect(closable1.close).toHaveBeenCalled();
			expect(closable2.close).toHaveBeenCalled();
			expect(closable3.close).toHaveBeenCalled();
		});
	});

	describe('close', () => {
		it('should clear all closeables', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			processManager.close();

			// After close, closeables array should be empty
			// Trigger exit - closable should not be called since array was cleared
			vi.clearAllMocks();
			process.emit('exit', 0);

			expect(closable.close).not.toHaveBeenCalled();
		});

		it('should stop reacting to process events after close()', () => {
			const sigintListenersBeforeClose = process.listeners('SIGINT');
			processManager.close();
			vi.clearAllMocks();
			expect(process.listeners('SIGINT')).toEqual(sigintListenersBeforeClose.filter((l) => !processManagerSigintListeners.includes(l as () => void)));
			const uncaughtExceptionGuard = vi.fn();
			process.addListener('uncaughtException', uncaughtExceptionGuard);
			process.emit('uncaughtException', new Error('Test Exception'));
			process.removeListener('uncaughtException', uncaughtExceptionGuard);
			expect(uncaughtExceptionGuard).toHaveBeenCalledOnce();
			expect(exitSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		});
	});

	describe('exit event handling', () => {
		it('should call close on all closeables when exit event fires', () => {
			const closable1: Closable = { close: vi.fn() };
			const closable2: Closable = { close: vi.fn() };

			processManager.addCloseable(closable1);
			processManager.addCloseable(closable2);

			process.emit('exit', 0);

			expect(closable1.close).toHaveBeenCalledOnce();
			expect(closable2.close).toHaveBeenCalledOnce();
		});

		it('should call processManager.close() on exit', () => {
			const closeSpy = vi.spyOn(processManager, 'close');

			process.emit('exit', 0);

			expect(closeSpy).toHaveBeenCalled();
		});

		it('should not close twice if hasHandledExit is true', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			// First exit (via SIGINT which sets hasHandledExit)
			for (const listener of processManagerSigintListeners) { listener(); }

			vi.clearAllMocks();

			// Second exit event
			process.emit('exit', 0);

			// Should not be called again
			expect(closable.close).not.toHaveBeenCalled();
		});
	});

	describe('SIGINT handling', () => {
		it('should log termination message on SIGINT', () => {
			for (const listener of processManagerSigintListeners) { listener(); }
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Process terminated by user'));
		});

		it('should call close on all closeables on SIGINT', () => {
			const closable1: Closable = { close: vi.fn() };
			const closable2: Closable = { close: vi.fn() };

			processManager.addCloseable(closable1);
			processManager.addCloseable(closable2);

			for (const listener of processManagerSigintListeners) { listener(); }

			expect(closable1.close).toHaveBeenCalledOnce();
			expect(closable2.close).toHaveBeenCalledOnce();
		});

		it('should call processManager.close() on SIGINT', () => {
			const closeSpy = vi.spyOn(processManager, 'close');

			for (const listener of processManagerSigintListeners) { listener(); }

			expect(closeSpy).toHaveBeenCalled();
		});

		it('should exit with code 130 on SIGINT', () => {
			for (const listener of processManagerSigintListeners) { listener(); }

			expect(exitSpy).toHaveBeenCalledWith(130);
		});

		it('should set hasHandledExit flag on SIGINT', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			for (const listener of processManagerSigintListeners) { listener(); }

			vi.clearAllMocks();

			// Trigger exit event - should not call close again
			process.emit('exit', 0);

			expect(closable.close).not.toHaveBeenCalled();
		});
	});

	describe('uncaughtException handling', () => {
		it('should log uncaught exception message', () => {
			const testError = new Error('Test Exception');

			process.emit('uncaughtException', testError);

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Uncaught Exception...'), testError.stack);
		});

		it('should log error stack trace', () => {
			const testError = new Error('Test Exception');

			process.emit('uncaughtException', testError);

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Uncaught Exception...'), testError.stack);
		});

		it('should exit with code 99 on uncaught exception', () => {
			const testError = new Error('Test Exception');

			process.emit('uncaughtException', testError);

			expect(exitSpy).toHaveBeenCalledWith(99);
		});

		it('should handle errors without stack traces', () => {
			const testError = new Error('No stack');
			delete testError.stack;

			process.emit('uncaughtException', testError);

			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Uncaught Exception...'), undefined);
			expect(exitSpy).toHaveBeenCalledWith(99);
		});
	});
});
