import { vi, describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptProject } from '../../src/type-script-project';
import { processManager } from '../../src/process-manager';
import { Files } from '../../src/files';
import { TestHelper } from '../scripts/test-helper';

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
