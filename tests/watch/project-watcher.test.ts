import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectWatcher } from '../../src/watch/project-watcher';
import { Paths } from '../../src/paths';
import { Logger } from '../../src/logger';
import { flushPerformanceLog } from '../../src/decorators/performance-logger';
import type { ProjectWatcherOptions } from '../../src/watch/project-watcher';
import type { Watchr, WatchrStats } from '@d1g1tal/watchr';

const boundary = vi.hoisted(() => ({
	create: vi.fn(),
	ready: Promise.resolve(),
	instances: [] as Array<{
		targets: ConstructorParameters<typeof Watchr>[0];
		options: ConstructorParameters<typeof Watchr>[1];
		callback: ConstructorParameters<typeof Watchr>[2];
		close: ReturnType<typeof vi.fn>;
		closed: boolean;
	}>
}));

vi.mock('@d1g1tal/watchr', () => ({
	Watchr: class {
		closed = false;
		readyLock = boundary.ready;
		close = vi.fn(() => { this.closed = true });
		constructor(public targets: ConstructorParameters<typeof Watchr>[0], public options: ConstructorParameters<typeof Watchr>[1], public callback: ConstructorParameters<typeof Watchr>[2]) {
			boundary.create(targets, options, callback);
			boundary.instances.push(this);
		}
		isClosed(): boolean { return this.closed }
	}
}));

vi.mock('../../src/decorators/performance-logger', () => ({ flushPerformanceLog: vi.fn() }));

const directory = Paths.absolute('/project');
const dependencies = (...paths: string[]) => new Set(paths.map((path) => Paths.relative(directory, Paths.absolute(directory, path))));
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
let watcher: ProjectWatcher;

function options(overrides: Partial<ProjectWatcherOptions> = {}): ProjectWatcherOptions {
	return { directory, watch: { enabled: true, recursive: true, persistent: true, ignoreInitial: true }, onChange: vi.fn(), ...overrides };
}

beforeEach(() => {
	vi.clearAllMocks();
	boundary.instances.length = 0;
	boundary.ready = Promise.resolve();
	vi.spyOn(Logger, 'info').mockImplementation(() => {});
});

afterEach(async () => {
	watcher.close();
	await nextTurn();
	vi.restoreAllMocks();
});

describe('ProjectWatcher', () => {
	it('defaults to src and includes uncovered plugin dependencies in order', async () => {
		watcher = new ProjectWatcher(options());
		await watcher.reconcile(dependencies('src/value.ts', 'build/plugin.ts', 'build/helper.ts', '../shared/plugin.ts'));
		expect(boundary.instances[0]!.targets).toEqual([ '/project/src', '/project/build/plugin.ts', '/project/build/helper.ts', '/shared/plugin.ts' ]);
	});

	it('preserves glob truncation and order-dependent target deduplication', async () => {
		watcher = new ProjectWatcher(options({ include: [ 'src/nested/**', 'src/**', 'src', 'src/file.ts', 'src-other/*.ts', 'question?.ts', 'bracket[ab].ts', 'bang!file.ts', 'back\\file.ts' ] }));
		await watcher.reconcile(dependencies('src-other/plugin.ts', 'build/plugin.ts'));
		expect(boundary.instances[0]!.targets).toEqual([ '/project/src/nested', '/project/src', '/project/src-other', '/project/question', '/project/bracket', '/project/bang', '/project/back', '/project/build/plugin.ts' ]);
	});

	it('keeps an explicitly empty include list empty', async () => {
		watcher = new ProjectWatcher(options({ include: [] }));
		await watcher.reconcile(dependencies());
		expect(boundary.instances[0]!.targets).toEqual([]);
	});

	it('reuses active watchers with identical targets without another banner', async () => {
		watcher = new ProjectWatcher(options());
		await watcher.reconcile(dependencies('build/plugin.ts'));
		await nextTurn();
		await watcher.reconcile(dependencies('src/new.ts', 'build/plugin.ts'));
		await nextTurn();
		expect(boundary.create).toHaveBeenCalledTimes(1);
		expect(boundary.instances[0]!.close).not.toHaveBeenCalled();
		expect(Logger.info).toHaveBeenCalledTimes(1);
	});

	it('closes and replaces watchers when plugin targets are added, reordered, or removed', async () => {
		watcher = new ProjectWatcher(options());
		await watcher.reconcile(dependencies('build/plugin.ts'));
		await watcher.reconcile(dependencies('build/plugin.ts', 'build/helper.ts'));
		await watcher.reconcile(dependencies('build/helper.ts', 'build/plugin.ts'));
		await watcher.reconcile(dependencies());
		expect(boundary.instances.map(({ targets }) => targets)).toEqual([
			[ '/project/src', '/project/build/plugin.ts' ],
			[ '/project/src', '/project/build/plugin.ts', '/project/build/helper.ts' ],
			[ '/project/src', '/project/build/helper.ts', '/project/build/plugin.ts' ],
			[ '/project/src' ]
		]);
		for (const instance of boundary.instances.slice(0, -1)) { expect(instance.close).toHaveBeenCalledTimes(1) }
		expect(boundary.instances[3]!.close).not.toHaveBeenCalled();
	});

	it('replaces an externally closed watcher even when targets are unchanged', async () => {
		watcher = new ProjectWatcher(options());
		await watcher.reconcile(dependencies());
		boundary.instances[0]!.close();
		await watcher.reconcile(dependencies());
		expect(boundary.create).toHaveBeenCalledTimes(2);
		expect(boundary.instances[1]!.closed).toBe(false);
	});

	it('passes watch options through and matches excludes and ignores literally by path segment or suffix', async () => {
		const configuration = options({ exclude: [ 'dist', 'nested/excluded', '**/generated' ] });
		configuration.watch.ignore = [ 'node_modules', 'skip.ts' ];
		configuration.watch.debounce = 17;
		configuration.watch.renameTimeout = 23;
		watcher = new ProjectWatcher(configuration);
		await watcher.reconcile(dependencies());
		const actual = boundary.instances[0]!.options;
		expect(actual).toEqual({ ...configuration.watch, ignore: expect.any(Function) });
		const ignore = actual!.ignore;
		if (typeof ignore !== 'function') { throw new Error('Expected an ignore predicate') }
		for (const path of [ '/project/dist', '/project/dist/index.ts', '/project/nested/excluded/file.ts', '/project/node_modules/lib.ts', '/project/src/skip.ts', '/project/**/generated/file.ts' ]) {
			expect(ignore(path)).toBe(true);
		}
		for (const path of [ '/project/distance/index.ts', '/project/src/skip.tsx', '/project/generated/file.ts', '/project/nested/generated/file.ts' ]) {
			expect(ignore(path)).toBe(false);
		}
	});

	it('uses a false ignore predicate when no excludes or ignores are configured', async () => {
		watcher = new ProjectWatcher(options());
		await watcher.reconcile(dependencies());
		const ignore = boundary.instances[0]!.options!.ignore;
		if (typeof ignore !== 'function') { throw new Error('Expected an ignore predicate') }
		expect(ignore('/project/src/index.ts')).toBe(false);
	});

	it('forwards source and outside-plugin events without taking ownership of eligibility filtering', async () => {
		const onChange = vi.fn<ProjectWatcherOptions['onChange']>();
		watcher = new ProjectWatcher(options({ onChange }));
		await watcher.reconcile(dependencies('build/plugin.ts'));
		const callback = boundary.instances[0]!.callback;
		const stats = { size: 12, modifiedTimeMs: 34 } as WatchrStats;
		callback?.('change', stats, '/project/build/plugin.ts');
		callback?.('rename', stats, '/project/src/index.ts', '/project/src/renamed.ts');
		callback?.('change', stats, '/project/src/untracked.ts');
		expect(onChange.mock.calls).toEqual([
			[ 'change', stats, '/project/build/plugin.ts', undefined ],
			[ 'rename', stats, '/project/src/index.ts', '/project/src/renamed.ts' ],
			[ 'change', stats, '/project/src/untracked.ts', undefined ]
		]);
	});

	it('waits for readiness and defers the performance flush before the watching banner', async () => {
		const ready = Promise.withResolvers<void>();
		boundary.ready = ready.promise;
		watcher = new ProjectWatcher(options());
		const settled = vi.fn();
		const reconciliation = watcher.reconcile(dependencies('build/plugin.ts')).then(settled);
		await vi.dynamicImportSettled();
		expect(boundary.create).toHaveBeenCalledTimes(1);
		expect(settled).not.toHaveBeenCalled();
		expect(flushPerformanceLog).not.toHaveBeenCalled();
		expect(Logger.info).not.toHaveBeenCalled();
		ready.resolve();
		await reconciliation;
		expect(settled).toHaveBeenCalledTimes(1);
		expect(Logger.info).not.toHaveBeenCalled();
		await nextTurn();
		expect(flushPerformanceLog).toHaveBeenCalledTimes(1);
		expect(Logger.info).toHaveBeenCalledExactlyOnceWith('Watching for changes in: /project/src, /project/build/plugin.ts');
		expect(vi.mocked(flushPerformanceLog).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(Logger.info).mock.invocationCallOrder[0]!);
	});

	it('does not create a watcher when closed before reconciliation', async () => {
		watcher = new ProjectWatcher(options());
		watcher.close();
		await watcher.reconcile(dependencies());
		expect(boundary.create).not.toHaveBeenCalled();
	});

	it('does not resurrect a watcher when closed while the dynamic import is pending', async () => {
		watcher = new ProjectWatcher(options());
		const reconciliation = watcher.reconcile(dependencies());
		watcher.close();
		await reconciliation;
		expect(boundary.create).not.toHaveBeenCalled();
		await nextTurn();
		expect(Logger.info).not.toHaveBeenCalled();
	});

	it('stops immediately during readiness and prevents later reconciliation or banners', async () => {
		const ready = Promise.withResolvers<void>();
		boundary.ready = ready.promise;
		watcher = new ProjectWatcher(options());
		const reconciliation = watcher.reconcile(dependencies());
		await vi.dynamicImportSettled();
		watcher.close();
		watcher.close();
		expect(boundary.instances[0]!.close).toHaveBeenCalledTimes(1);
		ready.resolve();
		await reconciliation;
		await watcher.reconcile(dependencies('build/plugin.ts'));
		await nextTurn();
		expect(boundary.create).toHaveBeenCalledTimes(1);
		expect(flushPerformanceLog).not.toHaveBeenCalled();
		expect(Logger.info).not.toHaveBeenCalled();
	});

	it('suppresses a queued banner when closed after readiness', async () => {
		watcher = new ProjectWatcher(options());
		await watcher.reconcile(dependencies());
		watcher.close();
		await nextTurn();
		expect(boundary.instances[0]!.close).toHaveBeenCalledTimes(1);
		expect(flushPerformanceLog).not.toHaveBeenCalled();
		expect(Logger.info).not.toHaveBeenCalled();
	});
});