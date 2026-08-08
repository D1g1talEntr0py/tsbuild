import { vi, describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile, stat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptProject } from '../../src/type-script-project';
import { processManager } from '../../src/process-manager';
import { Files } from '../../src/files';
import { Logger } from '../../src/logger';
import { TestHelper } from '../scripts/test-helper';
import type { AbsolutePath } from '../../src/@types';

// When a watched path is removed (tmpdir cleanup after close(), or a rebuild's directory
// re-scan racing teardown), watchr surfaces a "Path not found" condition two ways: as an
// 'error' event, and as a rejection from its async watchPath() re-scan. Neither is a real
// failure in tests. SafeWatchr handles both: a no-op 'error' listener for the event form,
// and a guarded wrapper around the instance's watchPath() for the rejection form. watchPath
// is TS-private, so it is wrapped at runtime; all real watching/rebuild behavior is preserved.
vi.mock('@d1g1tal/watchr', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@d1g1tal/watchr')>();
	class SafeWatchr extends actual.Watchr {
		constructor(...args: ConstructorParameters<typeof actual.Watchr>) {
			super(...args);
			this.on('error', () => {});
			watchCallback = args[2] as ((event: string, stats: { size: number; modifiedTimeMs: number }, path: string, nextPath?: string) => void) | undefined;

			const self = this as unknown as { watchPath: (...args: unknown[]) => Promise<unknown> };
			const watchPath = self.watchPath.bind(self);
			self.watchPath = async (...args: unknown[]): Promise<unknown> => {
				try {
					return await watchPath(...args);
				} catch (error) {
					// Path removed mid-watch (tmpdir cleanup) — expected teardown race in tests.
					if (error instanceof Error && error.message.includes('Path not found')) { return }
					throw error;
				}
			};
		}
	}
	return { ...actual, Watchr: SafeWatchr };
});

const readUtf8 = (path: string): Promise<string> => readFile(path, 'utf8');
let watchCallback: ((event: string, stats: { size: number; modifiedTimeMs: number }, path: string, nextPath?: string) => void) | undefined;

describe('TypeScriptProject - Watch Mode', () => {
	let cleanup: (() => Promise<void>) | undefined;
	let project: TypeScriptProject | undefined;

	afterEach(async () => {
		project?.close();
		project = undefined;
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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
		await project.build();
		await new Promise<void>(resolve => setImmediate(resolve));

		expect(() => project!.close()).not.toThrow();
		expect(() => project!.close()).not.toThrow();
	});

	it('triggers a rebuild when a watched source file changes', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
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

	it('rebuilds when watchr reports a zero-size add for a tracked file', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
		await project.build();
		await new Promise<void>(resolve => setImmediate(resolve));

		const infoSpy = vi.spyOn(Logger, 'info');
		watchCallback?.('add', { size: 0, modifiedTimeMs: 0 }, join(dir, 'src/index.ts'));

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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
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
				watchCallback?.('change', { size: changedStats.size, modifiedTimeMs: changedStats.mtimeMs }, indexPath);
				await readBlocked;
			}

			return originalRead(path as AbsolutePath);
		});

		watchCallback?.('change', { size: changedStats.size, modifiedTimeMs: changedStats.mtimeMs }, indexPath);
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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
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

	it('runs manifest-driven cleanup across watch rebuilds', { timeout: 20_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { compilerOptions: { declaration: false }, tsbuild: { clean: true } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true, renameTimeout: 1_000 } } });
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

	it('does not crash when watchr emits a rename without stats', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/index.ts': 'export const version = 1;',
				'src/unused.ts': 'export const unused = 1;'
			},
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const oldPath = join(dir, 'src/unused.ts');
		const newPath = join(dir, 'src/unused-renamed.ts');
		await rename(oldPath, newPath);

		expect(() => {
			watchCallback?.('rename', undefined as unknown as { size: number; modifiedTimeMs: number }, oldPath, newPath);
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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
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

		project = new TypeScriptProject(dir, { tsbuild: { watch: { enabled: true } } });
		await project.build();
		await new Promise<void>((resolve) => setImmediate(resolve));

		const filePath = join(dir, 'src/index.ts');
		const initialStats = await stat(filePath);
		const previousStats = { size: initialStats.size, modifiedTimeMs: initialStats.mtimeMs };
		const readSpy = vi.spyOn(Files, 'read');
		readSpy.mockClear();

		watchCallback?.('change', { size: previousStats.size + 1, modifiedTimeMs: previousStats.modifiedTimeMs + 1 }, filePath);
		watchCallback?.('change', previousStats, filePath);

		await vi.waitFor(() => {
			const targetedReads = readSpy.mock.calls.filter(([path]) => path === filePath);
			expect(targetedReads).toHaveLength(0);
		}, { timeout: 1_000, interval: 50 });

		readSpy.mockRestore();
	});
});
