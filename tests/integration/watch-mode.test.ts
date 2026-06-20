import { vi, describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptProject } from '../../src/type-script-project';
import { processManager } from '../../src/process-manager';
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
			tsconfig: { tsbuild: { watch: { enabled: true }, clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir);
		await project.build();
		await new Promise<void>(resolve => setImmediate(resolve));

		expect(() => project!.close()).not.toThrow();
		expect(() => project!.close()).not.toThrow();
	});

	it('triggers a rebuild when a watched source file changes', { timeout: 15_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { tsbuild: { watch: { enabled: true }, clean: false } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir);
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

	it('runs manifest-driven cleanup across watch rebuilds', { timeout: 20_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { compilerOptions: { declaration: false }, tsbuild: { watch: { enabled: true }, clean: true } }
		});
		cleanup = c;

		project = new TypeScriptProject(dir);
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
});
