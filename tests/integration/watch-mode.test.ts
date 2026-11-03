import { vi, describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptProject } from '../../src/type-script-project';
import { processManager } from '../../src/process-manager';
import { Files } from '../../src/files';
import { Logger } from '../../src/logger';
import { Paths } from '../../src/paths';
import { ProjectWatcher } from '../../src/watch/project-watcher';
import { TestHelper } from '../scripts/test-helper';
import { bundleDeclarations } from '../../src/dts/declaration-bundler';
import { WatchrStats, type WatchrEventHandler } from '@d1g1tal/watchr';
import type { AbsolutePath } from '../../src/@types';

vi.mock('../../src/dts/declaration-bundler', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/dts/declaration-bundler')>();
	return { ...actual, bundleDeclarations: vi.fn(actual.bundleDeclarations) };
});

// Temporary fixture removal may cause operational errors during cleanup.
vi.mock('@d1g1tal/watchr', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@d1g1tal/watchr')>();
	class SafeWatchr extends actual.Watchr {
		constructor(...args: ConstructorParameters<typeof actual.Watchr>) {
			super(args[0], { ...args[1], handlers: { ...args[1]?.handlers, error: () => {} } });
			const all = args[1]?.handlers?.all;
			watchCallback = typeof all === 'function' ? all : all?.handler;
		}
	}
	return { ...actual, Watchr: SafeWatchr };
});

const readUtf8 = (path: string): Promise<string> => readFile(path, 'utf8');
let watchCallback: WatchrEventHandler<'all'> | undefined;
const eventStats = (size: number, modifiedTimeMs: number): WatchrStats => ({ size, modifiedTimeMs } as WatchrStats);

describe('TypeScriptProject - Watch Mode', () => {
	let cleanup: (() => Promise<void>) | undefined;
	let project: TypeScriptProject | undefined;

	afterEach(async () => {
		project?.close();
		project = undefined;
		watchCallback = undefined;
		processManager.close();
		await cleanup?.();
		cleanup = undefined;
		process.exitCode = undefined;
	});

	it('starts watching after build() and close() stops the watcher without error', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		expect(await project.build()).toBeNull();
		await new Promise<void>(resolve => setImmediate(resolve));
		await expect(stat(join(dir, '.tsbuild', 'tsconfig.tsbuildinfo'))).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readUtf8(join(dir, 'dist', 'index.d.ts'))).resolves.toContain('version');

		expect(() => project!.close()).not.toThrow();
		expect(() => project!.close()).not.toThrow();
	});

	it('rejects watcher startup for a missing required target without a watching banner', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject();
		cleanup = c;
		const infoSpy = vi.spyOn(Logger, 'info');
		const watcher = new ProjectWatcher({
			directory: Paths.absolute(dir),
			include: [ 'missing-source' ],
			watch: { enabled: true, recursive: true, persistent: true, emitInitial: false },
			onChange: vi.fn()
		});
		try {
			await expect(watcher.reconcile(new Set())).rejects.toThrow();
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(infoSpy.mock.calls.some(([ message ]) => message.startsWith('Watching for changes in:'))).toBe(false);
		} finally {
			watcher.close();
			infoSpy.mockRestore();
		}
	});

	it('keeps type-check-only watch rebuilds from producing outputs', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const value: number = 1;' }
		});
		cleanup = c;
		const errorSpy = vi.spyOn(Logger, 'error');
		project = new TypeScriptProject(dir, { compilerOptions: { noEmit: true } }, { clearCache: false, force: false, watch: true, minify: false });

		try {
			{
				await using resource = await project.build();
				expect(resource).toBeNull();
			}
			await writeFile(join(dir, 'src/index.ts'), 'export const value: number = "bad";');

			await vi.waitFor(() => {
				expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Found 1 error'));
			}, { timeout: 7_500, interval: 100 });

			await expect(stat(join(dir, 'dist/index.js'))).rejects.toMatchObject({ code: 'ENOENT' });
			await expect(stat(join(dir, 'dist/index.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
			expect(process.exitCode).toBeUndefined();
		} finally {
			await project.close();
			errorSpy.mockRestore();
		}
	});

	it('triggers a rebuild when a watched source file changes', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();

		await new Promise<void>(resolve => setImmediate(resolve));

		await writeFile(join(dir, 'src/index.ts'), 'export const version = 2;');

		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('version = 2') || output.includes('version=2')).toBe(true);
			expect(process.exitCode).toBeUndefined();
		}, { timeout: 7_500, interval: 100 });

		expect(process.exitCode).toBeUndefined();
	});

	it('applies consecutive source changes to JavaScript and declarations in the live compiler session', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>(resolve => setImmediate(resolve));

		for (const value of [ 2, 3 ]) {
			await writeFile(join(dir, 'src/index.ts'), `export const version = ${value};`);

			await vi.waitFor(async () => {
				expect(await readUtf8(join(dir, 'dist/index.js'))).toMatch(new RegExp(`version\\s*=\\s*${value}`));
				expect(await readUtf8(join(dir, 'dist/index.d.ts'))).toContain(`version = ${value}`);
				expect(process.exitCode).toBeUndefined();
			}, { timeout: 7_500, interval: 100 });
		}
	});

	it('bounds live syntax cache paths through signature changes, deletion, rename and re-addition', { timeout: 20_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version: number = 0;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;
		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		const cache = vi.mocked(bundleDeclarations).mock.calls.at(-1)![0].sourceFileCache!;
		const indexPath = Paths.absolute(dir, 'dist/index.d.ts');
		const originalPath = Paths.absolute(dir, 'dist/item.d.ts');
		const renamedPath = Paths.absolute(dir, 'dist/renamed.d.ts');
		const item = (version: number) => `export const value: number = ${version}; export interface Shape { step${version}: string }`;
		const entry = (version: number, name?: string) => `export const version: number = ${version};${name ? ` export * from "./${name}.js";` : ''}`;
		const verify = async (version: number, path?: AbsolutePath) => {
			await vi.waitFor(async () => {
				expect(await readUtf8(join(dir, 'dist/index.js'))).toMatch(new RegExp(`version\\s*=\\s*${version}\\b`));
				const declaration = await readUtf8(join(dir, 'dist/index.d.ts'));
				if (path === undefined) {
					expect(declaration).not.toContain('interface Shape');
				} else {
					expect(declaration).toContain(`step${version}: string`);
					expect(await readUtf8(join(dir, 'dist/index.js'))).toMatch(new RegExp(`value\\s*=\\s*${version}\\b`));
				}
				expect([...cache.keys()].sort()).toEqual([ indexPath, ...(path === undefined ? [] : [ path ]) ].sort());
				expect(vi.mocked(bundleDeclarations).mock.calls.at(-1)![0].sourceFileCache).toBe(cache);
				expect(process.exitCode).toBeUndefined();
			}, { timeout: 7_500, interval: 50 });
		};
		try {
			await new Promise<void>(resolve => setImmediate(resolve));
			await writeFile(join(dir, 'src/item.ts'), item(1));
			await writeFile(join(dir, 'src/index.ts'), entry(1, 'item'));
			await verify(1, originalPath);
			const original = cache.get(originalPath)!.sourceFile;

			await writeFile(join(dir, 'src/item.ts'), item(2));
			await writeFile(join(dir, 'src/index.ts'), entry(2, 'item'));
			await verify(2, originalPath);
			expect(cache.get(originalPath)!.sourceFile).not.toBe(original);
			const changed = cache.get(originalPath)!.sourceFile;

			await rename(join(dir, 'src/item.ts'), join(dir, 'src/renamed.ts'));
			await writeFile(join(dir, 'src/renamed.ts'), item(3));
			await writeFile(join(dir, 'src/index.ts'), entry(3, 'renamed'));
			await verify(3, renamedPath);
			expect(cache.has(originalPath)).toBe(false);

			await writeFile(join(dir, 'src/index.ts'), entry(4));
			await unlink(join(dir, 'src/renamed.ts'));
			await verify(4);

			await writeFile(join(dir, 'src/item.ts'), item(5));
			await writeFile(join(dir, 'src/index.ts'), entry(5, 'item'));
			await verify(5, originalPath);
			expect(cache.get(originalPath)!.sourceFile).not.toBe(changed);
			expect(cache.has(renamedPath)).toBe(false);
		} finally {
			await project.close();
		}
		expect(cache.size).toBe(0);
	});

	it('reloads a scoped TypeScript plugin when an imported plugin dependency changes', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export const version = 1;',
				'build/plugin-value.ts': 'export const banner = "first-plugin";',
				'build/plugin-extra.ts': 'export const extra = "first-extra";',
				'build/plugin.ts': [
					'import { banner } from "./plugin-value";',
					'import type { Plugin } from "esbuild";',
					'enum Mode { Enabled = "enabled" }',
					'export default function (): Plugin {',
					'  return {',
					'    name: `scoped-plugin-${Mode.Enabled}`,',
					'    setup(build) { build.initialOptions.banner = { js: `// ${banner}` }; },',
					'  };',
					'}'
				].join('\n')
			},
			tsconfig: { tsbuild: { clean: false, plugins: [ './build/plugin.ts' ] } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>(resolve => setImmediate(resolve));

		await expect(readUtf8(join(dir, 'dist/index.js'))).resolves.toContain('first-plugin');
		await writeFile(join(dir, 'build/plugin-value.ts'), 'export const banner = "second-plugin";');

		await vi.waitFor(async () => {
			await expect(readUtf8(join(dir, 'dist/index.js'))).resolves.toContain('second-plugin');
			expect(process.exitCode).toBeUndefined();
		}, { timeout: 7_500, interval: 100 });

		const infoSpy = vi.spyOn(Logger, 'info');
		await writeFile(join(dir, 'build/plugin.ts'), [
			'import { banner } from "./plugin-value";',
			'import { extra } from "./plugin-extra";',
			'import type { Plugin } from "esbuild";',
			'enum Mode { Enabled = "enabled" }',
			'export default function (): Plugin {',
			'  return {',
			'    name: `scoped-plugin-${Mode.Enabled}`,',
			'    setup(build) { build.initialOptions.banner = { js: `// ${banner}-${extra}` }; },',
			'  };',
			'}'
		].join('\n'));

		await vi.waitFor(async () => {
			await expect(readUtf8(join(dir, 'dist/index.js'))).resolves.toContain('second-plugin-first-extra');
		}, { timeout: 7_500, interval: 100 });

		await vi.waitFor(() => {
			expect(infoSpy.mock.calls.some(([ message ]) => typeof message === 'string' && message.startsWith('Watching for changes in:') && message.includes('build/plugin-extra.ts'))).toBe(true);
		}, { timeout: 7_500, interval: 100 });

		await writeFile(join(dir, 'build/plugin-extra.ts'), 'export const extra = "second-extra";');

		await vi.waitFor(async () => {
			await expect(readUtf8(join(dir, 'dist/index.js'))).resolves.toContain('second-plugin-second-extra');
			expect(process.exitCode).toBeUndefined();
		}, { timeout: 7_500, interval: 100 });
	});

	it('rebuilds when watchr reports a zero-size add for a tracked file', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>(resolve => setImmediate(resolve));

		const infoSpy = vi.spyOn(Logger, 'info');
		watchCallback?.({ type: 'add', stats: WatchrStats.synthetic(false, 0), path: join(dir, 'src/index.ts'), initial: false });

		await vi.waitFor(() => {
			const rebuildLogs = infoSpy.mock.calls.filter(([ message ]) => typeof message === 'string' && message.startsWith('Rebuilding project:'));
			expect(rebuildLogs.length).toBeGreaterThan(0);
		}, { timeout: 7_500, interval: 100 });

		infoSpy.mockRestore();
	});

	it('keeps only the latest same-path change while async hashing is in flight', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();

		await new Promise<void>(resolve => setImmediate(resolve));

		await writeFile(join(dir, 'src/index.ts'), 'export const version = 2;');
		await new Promise(resolve => setTimeout(resolve, 25));
		await writeFile(join(dir, 'src/index.ts'), 'export const version = 3;');

		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('version = 3') || output.includes('version=3')).toBe(true);
			expect(process.exitCode).toBeUndefined();
		}, { timeout: 7_500, interval: 100 });
	});

	it('rebuilds when duplicate same-file change events arrive during async hashing', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const indexPath = join(dir, 'src/index.ts');
		await writeFile(indexPath, 'export const version = 2;');
		const changedStats = await stat(indexPath);

		const originalRead = Files.read.bind(Files);
		let duplicateQueued = false;
		let releaseRead: (() => void) | undefined;
		const readBlocked = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});

		const readSpy = vi.spyOn(Files, 'read').mockImplementation(async (path) => {
			if (!duplicateQueued && path === indexPath) {
				duplicateQueued = true;
				watchCallback?.({ type: 'change', stats: eventStats(changedStats.size, changedStats.mtimeMs), path: indexPath, initial: false });
				await readBlocked;
			}

			return originalRead(path as AbsolutePath);
		});

		watchCallback?.({ type: 'change', stats: eventStats(changedStats.size, changedStats.mtimeMs), path: indexPath, initial: false });
		releaseRead?.();

		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('version = 2') || output.includes('version=2')).toBe(true);
		}, { timeout: 7_500, interval: 100 });

		readSpy.mockRestore();
	});

	it('drains watcher changes queued during async content hashing', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export { value } from "./value.js";',
				'src/value.ts': 'export const value = 1;'
			},
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();

		await new Promise<void>(resolve => setImmediate(resolve));

		await writeFile(join(dir, 'src/value.ts'), 'export const value = 2;');
		await new Promise(resolve => setTimeout(resolve, 25));
		await writeFile(join(dir, 'src/index.ts'), 'export { value } from "./value.js"; export const version = 2;');

		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('value = 2') || output.includes('value=2')).toBe(true);
			expect(output.includes('version = 2') || output.includes('version=2')).toBe(true);
			expect(process.exitCode).toBeUndefined();
		}, { timeout: 7_500, interval: 100 });
	});

	it('preserves drained changes when another change arrives before queue stability returns', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export { first } from "./first.js"; export { second } from "./second.js";',
				'src/first.ts': 'export const first = 1;',
				'src/second.ts': 'export const second = 1;'
			},
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const firstPath = join(dir, 'src/first.ts');
		const secondPath = join(dir, 'src/second.ts');
		await writeFile(firstPath, 'export const first = 2;');
		await writeFile(secondPath, 'export const second = 2;');
		const firstStats = await stat(firstPath);
		const secondStats = await stat(secondPath);
		const originalRead = Files.read.bind(Files);
		let readStarted!: () => void;
		let releaseRead!: () => void;
		const readHasStarted = new Promise<void>((resolve) => { readStarted = resolve });
		const readIsReleased = new Promise<void>((resolve) => { releaseRead = resolve });
		const readSpy = vi.spyOn(Files, 'read').mockImplementation(async (path) => {
			if (path === firstPath) {
				readStarted();
				await readIsReleased;
			}

			return originalRead(path as AbsolutePath);
		});

		watchCallback?.({ type: 'change', stats: eventStats(firstStats.size, firstStats.mtimeMs), path: firstPath, initial: false });
		await readHasStarted;
		setImmediate(() => watchCallback?.({ type: 'change', stats: eventStats(secondStats.size, secondStats.mtimeMs), path: secondPath, initial: false }));
		releaseRead();

		try {
			await vi.waitFor(async () => {
				const output = await readUtf8(join(dir, 'dist/index.js'));
				expect(output.includes('first = 2') || output.includes('first=2')).toBe(true);
				expect(output.includes('second = 2') || output.includes('second=2')).toBe(true);
				expect(process.exitCode).toBeUndefined();
			}, { timeout: 7_500, interval: 100 });
		} finally {
			readSpy.mockRestore();
		}
	});

	it('runs manifest-driven cleanup across watch rebuilds', { timeout: 20_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { compilerOptions: { declaration: false }, tsbuild: { clean: true } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();

		await new Promise<void>(resolve => setImmediate(resolve));

		// Modifying a tracked input triggers a rebuild whose build() reads the prior
		// in-memory output manifest, exercising the stale-output cleanup path.
		await writeFile(join(dir, 'src/index.ts'), 'export const version = 2;');
		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('version = 2') || output.includes('version=2')).toBe(true);
			expect(process.exitCode).toBeUndefined();
		}, { timeout: 8_500, interval: 100 });

		expect(process.exitCode).toBeUndefined();
	});

	it('coalesces rename follow-up events into a single rebuild', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export { value } from "./unused.js";',
				'src/unused.ts': 'export const value = 1;'
			},
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const infoSpy = vi.spyOn(Logger, 'info');
		const oldPath = join(dir, 'src/unused.ts');
		const newPath = join(dir, 'src/unused-renamed.ts');
		await rename(oldPath, newPath);
		const indexPath = join(dir, 'src/index.ts');
		await writeFile(indexPath, 'export { value } from "./unused-renamed.js";');

		await vi.waitFor(() => {
			const rebuildLogs = infoSpy.mock.calls.filter(([ message ]) => typeof message === 'string' && message.startsWith('Rebuilding project:'));
			expect(rebuildLogs).toHaveLength(1);
			expect(rebuildLogs[0]?.[0]).toBe('Rebuilding project: 1 file renamed detected.');
		}, { timeout: 7_500, interval: 100 });

		infoSpy.mockRestore();
	});

	it('recreates the esbuild context when an entry point is renamed', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const oldPath = join(dir, 'src/index.ts');
		const newPath = join(dir, 'src/main.ts');
		const infoSpy = vi.spyOn(Logger, 'info');
		await rename(oldPath, newPath);

		await vi.waitFor(() => {
			const rebuildLogs = infoSpy.mock.calls.filter(([ message ]) => typeof message === 'string' && message.startsWith('Rebuilding project:'));
			expect(rebuildLogs).toHaveLength(1);
			expect(rebuildLogs[0]?.[0]).toBe('Rebuilding project: 1 file renamed detected.');
		}, { timeout: 7_500, interval: 100 });

		await writeFile(newPath, 'export const version = 2;');

		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('version = 2') || output.includes('version=2')).toBe(true);
		}, { timeout: 7_500, interval: 100 });

		infoSpy.mockRestore();
	});

	it('coalesces a rapid triple-rename chain into a single rebuild', { timeout: 15_000 }, async () => {
		// noEmit mode bypasses the build-dependency gate in the watcher's rebuild closure, so every
		// rename in the chain reaches #queuePendingChange even though only the original path was a
		// known build dependency — isolating the rename-cycle coalescing logic under test.
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export { value } from "./unused.js";',
				'src/unused.ts': 'export const value = 1;'
			},
			tsconfig: { compilerOptions: { noEmit: true }, tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const pathA = join(dir, 'src/unused.ts');
		const pathB = join(dir, 'src/unused-renamed-1.ts');
		const pathC = join(dir, 'src/unused-renamed-2.ts');
		const pathD = join(dir, 'src/unused-renamed-3.ts');
		const indexPath = join(dir, 'src/index.ts');

		// Apply the full rapid rename chain and the dependent edit on disk first, so the
		// synthetic watcher events fired below aren't racing real fs completion.
		await rename(pathA, pathB);
		await rename(pathB, pathC);
		await rename(pathC, pathD);
		await writeFile(indexPath, 'export { value } from "./unused-renamed-3.js";');

		const infoSpy = vi.spyOn(Logger, 'info');

		// Fire the corresponding watcher events back-to-back, as VS Code / editors may emit them.
		watchCallback?.({ type: 'rename', stats: WatchrStats.synthetic(false, 0), from: pathA, to: pathB, initial: false });
		watchCallback?.({ type: 'rename', stats: WatchrStats.synthetic(false, 0), from: pathB, to: pathC, initial: false });
		watchCallback?.({ type: 'rename', stats: WatchrStats.synthetic(false, 0), from: pathC, to: pathD, initial: false });
		const indexStats = await stat(indexPath);
		watchCallback?.({ type: 'change', stats: eventStats(indexStats.size, indexStats.mtimeMs), path: indexPath, initial: false });

		await vi.waitFor(() => {
			const rebuildLogs = infoSpy.mock.calls.filter(([ message ]) => typeof message === 'string' && message.startsWith('Rebuilding project:'));
			expect(rebuildLogs).toHaveLength(1);
			expect(rebuildLogs[0]?.[0]).toContain('renamed detected.');
		}, { timeout: 7_500, interval: 100 });

		// No missing-module error should surface once the chain settles on the final path.
		expect(process.exitCode).toBeUndefined();

		infoSpy.mockRestore();
	});

	it('rebuilds unrelated edits during rename suppression', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export { value } from "./unused.js"; export { other } from "./other.js";',
				'src/unused.ts': 'export const value = 1;',
				'src/other.ts': 'export const other = 1;'
			},
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const infoSpy = vi.spyOn(Logger, 'info');
		const oldPath = join(dir, 'src/unused.ts');
		const newPath = join(dir, 'src/unused-renamed.ts');
		await rename(oldPath, newPath);
		await writeFile(join(dir, 'src/index.ts'), 'export { value } from "./unused-renamed.js"; export { other } from "./other.js";');

		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output).toContain('unused-renamed');
		}, { timeout: 7_500, interval: 100 });

		await writeFile(join(dir, 'src/other.ts'), 'export const other = 2;');
		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('other = 2') || output.includes('other=2')).toBe(true);
			const rebuildLogs = infoSpy.mock.calls.filter(([ message ]) => typeof message === 'string' && message.startsWith('Rebuilding project:'));
			expect(rebuildLogs).toHaveLength(2);
		}, { timeout: 7_500, interval: 100 });

		infoSpy.mockRestore();
	});

	it('does not crash when watchr emits a rename with synthetic stats', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export const version = 1;',
				'src/unused.ts': 'export const unused = 1;'
			},
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const oldPath = join(dir, 'src/unused.ts');
		const newPath = join(dir, 'src/unused-renamed.ts');
		await rename(oldPath, newPath);

		expect(() => {
			watchCallback?.({ type: 'rename', stats: WatchrStats.synthetic(false), from: oldPath, to: newPath, initial: false });
		}).not.toThrow();

		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(process.exitCode).toBeUndefined();
	});

	it('uses metadata fast path for size-changed events without hashing file contents', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const value = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		// First change seeds content state (digest + stats) for subsequent metadata fast-path checks.
		await writeFile(join(dir, 'src/index.ts'), 'export const value = 2;');
		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('value = 2') || output.includes('value=2')).toBe(true);
		}, { timeout: 7_500, interval: 100 });

		const readSpy = vi.spyOn(Files, 'read');

		await writeFile(join(dir, 'src/index.ts'), 'export const value = 123456789;');

		await vi.waitFor(async () => {
			const output = await readUtf8(join(dir, 'dist/index.js'));
			expect(output.includes('value = 123456789') || output.includes('value=123456789')).toBe(true);
		}, { timeout: 7_500, interval: 100 });

		expect(readSpy).not.toHaveBeenCalled();
		readSpy.mockRestore();
	});

	it('keeps the latest queued stats snapshot when an older size-change event is processed first', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const value = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, {}, { clearCache: false, force: false, watch: true, minify: false });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const filePath = join(dir, 'src/index.ts');
		const initialStats = await stat(filePath);
		const previousStats = { size: initialStats.size, modifiedTimeMs: initialStats.mtimeMs };
		const readSpy = vi.spyOn(Files, 'read');
		readSpy.mockClear();

		watchCallback?.({ type: 'change', stats: eventStats(previousStats.size + 1, previousStats.modifiedTimeMs + 1), path: filePath, initial: false });
		watchCallback?.({ type: 'change', stats: eventStats(previousStats.size, previousStats.modifiedTimeMs), path: filePath, initial: false });

		await vi.waitFor(() => {
			const targetedReads = readSpy.mock.calls.filter(([path]) => path === filePath);
			expect(targetedReads).toHaveLength(0);
		}, { timeout: 1_000, interval: 50 });

		readSpy.mockRestore();
	});
});
