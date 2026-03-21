import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import type { Closable } from '../src/@types';
import type { processManager as ProcessManagerType } from '../src/process-manager';

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
		it('logs termination message', () => {
			for (const listener of processManagerSigintListeners) { listener() }
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Process terminated by user'));
		});

		it('calls close on all closeables', () => {
			const closable: Closable = { close: vi.fn() };
			processManager.addCloseable(closable);

			for (const listener of processManagerSigintListeners) { listener() }
			expect(closable.close).toHaveBeenCalledOnce();
		});

		it('exits with code 130', () => {
			for (const listener of processManagerSigintListeners) { listener() }
			expect(exitSpy).toHaveBeenCalledWith(130);
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
