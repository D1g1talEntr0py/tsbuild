import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { vol } from 'memfs';
import { readFile } from 'node:fs/promises';
import { RebuildQueue, formatPendingChangeSummary, isRenameEvent } from '../../src/watch/rebuild-queue';
import { Paths } from '../../src/paths';
import type { WatchrStats } from '@d1g1tal/watchr';
import type { RebuildQueueOptions } from '../../src/watch/rebuild-queue';

vi.mock('node:fs/promises', async () => {
	const { fs } = await import('memfs');
	return { ...fs.promises, readFile: vi.fn(fs.promises.readFile) };
});

const path = Paths.absolute('/project/index.ts');
const nextPath = Paths.absolute('/project/renamed.ts');
const otherPath = Paths.absolute('/project/other.ts');
const stats = (size: number, modifiedTimeMs: number): WatchrStats => ({ size, modifiedTimeMs } as WatchrStats);
const settle = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 25));
	await new Promise<void>((resolve) => setImmediate(resolve));
};
const rebuild = vi.fn<RebuildQueueOptions['rebuild']>();
const sourceText = vi.fn<RebuildQueueOptions['sourceText']>();
let queue: RebuildQueue;

beforeEach(() => {
	vi.clearAllMocks();
	vol.fromJSON({ [path]: 'new' });
	rebuild.mockResolvedValue(undefined);
	sourceText.mockReturnValue('old');
	queue = new RebuildQueue({ renameTimeoutMs: 3, sourceText, rebuild });
});

afterEach(async () => {
	queue.stop();
	queue.clear();
	await settle();
	vol.reset();
});

describe('RebuildQueue', () => {
	it('deduplicates a save burst and dispatches the latest same-path event once', async () => {
		queue.enqueue('change', stats(3, 1), path);
		queue.enqueue('change', stats(3, 2), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(rebuild.mock.calls[0]![0]).toMatchObject([ { event: 'change', path } ]);
		expect(readFile).toHaveBeenCalledTimes(1);
		await settle();
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it('rebuilds for a zero-size add without hashing', async () => {
		queue.enqueue('add', stats(0, 0), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(rebuild.mock.calls[0]![0]).toMatchObject([ { event: 'add', path } ]);
		expect(readFile).not.toHaveBeenCalled();
	});

	it('filters initial no-op bytes against source text and then uses matching size and mtime', async () => {
		sourceText.mockReturnValue('new');
		queue.enqueue('change', stats(3, 1), path);
		await settle();
		expect(sourceText).toHaveBeenCalledExactlyOnceWith(path);
		queue.enqueue('change', stats(3, 1), path);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(1);
		expect(rebuild).not.toHaveBeenCalled();
	});

	it('filters unchanged bytes with newer mtime and accepts same-size byte changes', async () => {
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		queue.enqueue('change', stats(3, 2), path);
		await settle();
		expect(rebuild).toHaveBeenCalledTimes(1);
		vol.writeFileSync(path, 'two');
		queue.enqueue('change', stats(3, 3), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
		expect(readFile).toHaveBeenCalledTimes(3);
		expect(sourceText).toHaveBeenCalledTimes(1);
	});

	it('accepts a first content change when the compiler has no source text', async () => {
		sourceText.mockReturnValue(undefined);
		queue.enqueue('change', undefined, path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(sourceText).toHaveBeenCalledExactlyOnceWith(path);
	});

	it('keeps the last stats snapshot when a burst replaces earlier sizes', async () => {
		queue.enqueue('change', stats(100, 1), path);
		queue.enqueue('change', stats(3, 2), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		queue.enqueue('change', stats(3, 2), path);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(1);
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it('skips hashing for changed sizes and retains the previous digest', async () => {
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		queue.enqueue('change', stats(30, 2), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
		expect(readFile).toHaveBeenCalledTimes(1);
		queue.enqueue('change', stats(30, 2), path);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(1);
		queue.enqueue('change', undefined, path);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(2);
		expect(rebuild).toHaveBeenCalledTimes(2);
	});

	it('discards stale queued stats when the newest event has no stats', async () => {
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		queue.enqueue('change', stats(30, 2), path);
		queue.enqueue('change', undefined, path);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(2);
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it('ignores an in-flight hash superseded by a newer same-path event and drains unrelated changes', async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		vi.mocked(readFile).mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
			return 'old';
		});
		queue.enqueue('change', stats(3, 1), path);
		await started.promise;
		queue.enqueue('change', stats(3, 2), path);
		queue.enqueue('add', stats(0, 0), otherPath);
		released.resolve();
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(rebuild.mock.calls[0]![0]).toMatchObject([ { event: 'change', path }, { event: 'add', path: otherPath } ]);
		expect(readFile).toHaveBeenCalledTimes(2);
		expect(sourceText).toHaveBeenCalledTimes(1);
		queue.enqueue('change', stats(3, 2), path);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(2);
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it('rejects superseded batch entries before reading and collects their latest versions', async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		vol.writeFileSync(otherPath, 'two');
		vi.mocked(readFile).mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
			return 'new';
		});
		queue.enqueue('change', undefined, path);
		queue.enqueue('change', stats(3, 1), otherPath);
		await started.promise;
		queue.enqueue('change', stats(3, 2), otherPath);
		released.resolve();
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(rebuild.mock.calls[0]![0]).toMatchObject([ { path }, { path: otherPath } ]);
		expect(readFile).toHaveBeenCalledTimes(2);
	});

	it.each([ 'ENOENT', 'EIO' ])('preserves the %s read fallback and accepts a later valid read', async (code) => {
		vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
		queue.enqueue('change', stats(3, 1), path);
		await settle();
		expect(rebuild).toHaveBeenCalledTimes(code === 'ENOENT' ? 0 : 1);
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(code === 'ENOENT' ? 1 : 2));
		expect(readFile).toHaveBeenCalledTimes(2);
	});

	it('ignores an actual missing file through the filesystem boundary', async () => {
		queue.enqueue('change', undefined, otherPath);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(1);
		expect(rebuild).not.toHaveBeenCalled();
	});

	it('replaces old and destination path events with one rename and suppresses its chain', async () => {
		queue.enqueue('add', undefined, path);
		queue.enqueue('change', undefined, nextPath);
		queue.enqueue('rename', undefined, path, nextPath);
		queue.enqueue('rename', undefined, nextPath, otherPath);
		for (const event of [ 'add', 'addDir', 'change', 'unlink', 'unlinkDir' ] as const) {
			queue.enqueue(event, undefined, path);
			queue.enqueue(event, undefined, nextPath);
		}
		queue.enqueue('add', undefined, otherPath);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(rebuild.mock.calls[0]![0]).toMatchObject([ { event: 'rename', path, nextPath }, { event: 'add', path: otherPath } ]);
		expect(readFile).not.toHaveBeenCalled();
	});

	it('coalesces independent file and directory renames without dropping unrelated changes', async () => {
		queue.enqueue('rename', undefined, path, nextPath);
		queue.enqueue('renameDir', undefined, otherPath, Paths.absolute('/project/moved'));
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(rebuild.mock.calls[0]![0]).toHaveLength(2);
		expect(formatPendingChangeSummary(rebuild.mock.calls[0]![0])).toBe('2 files renamed detected.');
	});

	it('dispatches a rename without a destination as a meaningful event', async () => {
		queue.enqueue('rename', undefined, path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		expect(formatPendingChangeSummary(rebuild.mock.calls[0]![0])).toBe('1 file change detected.');
		expect(readFile).not.toHaveBeenCalled();
	});

	it('serializes pending rebuilds while a callback remains in flight', async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		rebuild.mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
		});
		queue.enqueue('add', undefined, path);
		await started.promise;
		queue.enqueue('add', undefined, otherPath);
		queue.enqueue('unlink', undefined, otherPath);
		await settle();
		expect(rebuild).toHaveBeenCalledTimes(1);
		released.resolve();
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
		expect(rebuild.mock.calls[1]![0]).toMatchObject([ { event: 'unlink', path: otherPath } ]);
	});

	it('suppresses renamed-path events during rebuild but dispatches unrelated pending changes', async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		rebuild.mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
		});
		queue.enqueue('rename', undefined, path, nextPath);
		await started.promise;
		queue.enqueue('change', undefined, nextPath);
		queue.enqueue('add', undefined, otherPath);
		expect(rebuild).toHaveBeenCalledTimes(1);
		released.resolve();
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
		expect(rebuild.mock.calls[1]![0]).toMatchObject([ { event: 'add', path: otherPath } ]);
		await settle();
		queue.enqueue('add', undefined, nextPath);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(3));
	});

	it('transfers content state only when the owner applies a rename', async () => {
		sourceText.mockReturnValue(undefined);
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		vol.renameSync(path, nextPath);
		queue.enqueue('rename', undefined, path, nextPath);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
		await settle();
		queue.markApplied({ event: 'rename', path, nextPath });
		queue.enqueue('change', stats(3, 1), nextPath);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(1);
		expect(rebuild).toHaveBeenCalledTimes(2);
		vol.writeFileSync(path, 'new');
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(3));
		expect(readFile).toHaveBeenCalledTimes(2);
	});

	it.each([ false, true ])('forgets unlink content state only when applied: %s', async (applied) => {
		sourceText.mockReturnValue(undefined);
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		queue.enqueue('unlink', undefined, path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
		if (applied) { queue.markApplied({ event: 'unlink', path }) }
		queue.enqueue('change', stats(3, 1), path);
		await settle();
		expect(rebuild).toHaveBeenCalledTimes(applied ? 3 : 2);
		expect(readFile).toHaveBeenCalledTimes(applied ? 2 : 1);
	});

	it('does not alter content state for applied adds or renames of unknown paths', async () => {
		queue.enqueue('change', stats(3, 1), path);
		await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
		queue.markApplied({ event: 'add', path });
		queue.markApplied({ event: 'rename', path: otherPath, nextPath: path });
		queue.enqueue('change', stats(3, 1), path);
		await settle();
		expect(readFile).toHaveBeenCalledTimes(1);
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it('does not dispatch when stopped between collection and the stability turn', async () => {
		sourceText.mockImplementationOnce(() => {
			setImmediate(() => queue.stop());
			return 'old';
		});
		queue.enqueue('change', undefined, path);
		await settle();
		expect(sourceText).toHaveBeenCalledTimes(1);
		expect(rebuild).not.toHaveBeenCalled();
	});

	it('does not rearm rename timers or dispatch pending changes after stopping an active rebuild', async () => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		rebuild.mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
		});
		queue.enqueue('rename', undefined, path, nextPath);
		await started.promise;
		queue.enqueue('add', undefined, otherPath);
		queue.stop();
		released.resolve();
		const scheduling = vi.spyOn(globalThis, 'setTimeout');
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(scheduling).not.toHaveBeenCalled();
		} finally {
			scheduling.mockRestore();
		}
		queue.clear();
		queue.markApplied({ event: 'rename', path, nextPath });
		queue.enqueue('add', undefined, path);
		await settle();
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it('formats rename and ordinary summaries without counting missing rename destinations', () => {
		expect(isRenameEvent('rename')).toBe(true);
		expect(isRenameEvent('renameDir')).toBe(true);
		expect(isRenameEvent('change')).toBe(false);
		expect(formatPendingChangeSummary([])).toBe('0 file changes detected.');
		expect(formatPendingChangeSummary([ { event: 'change', path } ])).toBe('1 file change detected.');
		expect(formatPendingChangeSummary([ { event: 'change', path }, { event: 'add', path: otherPath } ])).toBe('2 file changes detected.');
		expect(formatPendingChangeSummary([ { event: 'renameDir', path, nextPath }, { event: 'rename', path: otherPath } ])).toBe('1 file renamed detected.');
	});

	it.each([
		{ result: 'success', clear: false },
		{ result: 'ENOENT', clear: false },
		{ result: 'EIO', clear: false },
		{ result: 'success', clear: true },
		{ result: 'ENOENT', clear: true },
		{ result: 'EIO', clear: true }
	])('does not rebuild or restore hash state when stopped during $result with clear=$clear', async ({ result, clear }) => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		vi.mocked(readFile).mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
			if (result !== 'success') { throw Object.assign(new Error(result), { code: result }) }
			return 'new';
		});
		queue.enqueue('change', stats(3, 1), path);
		await started.promise;
		queue.stop();
		if (clear) { queue.clear() }
		released.resolve();
		await settle();
		queue.enqueue('add', undefined, nextPath);
		await settle();
		expect(sourceText).not.toHaveBeenCalled();
		expect(rebuild).not.toHaveBeenCalled();
		expect(readFile).toHaveBeenCalledTimes(1);
	});

	it('synchronously cancels rename and dispatch timers and remains closed after clear', async () => {
		queue.enqueue('rename', undefined, path, nextPath);
		queue.stop();
		queue.stop();
		queue.clear();
		queue.enqueue('add', undefined, path);
		await settle();
		expect(rebuild).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
	});
});