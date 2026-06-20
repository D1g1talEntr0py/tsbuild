import { vi, describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '../../src/logger';
import { TypeScriptProject } from '../../src/type-script-project';
import { processManager } from '../../src/process-manager';
import { TestHelper } from '../scripts/test-helper';

// Watchr emits an 'error' event when a watched path is deleted during tmpdir cleanup.
// With no listener, Node.js EventEmitter converts this to an uncaught exception.
// We extend Watchr here to add a no-op 'error' listener. This preserves all real
// watching/rebuild behavior; it only prevents the unhandled-error escalation.
vi.mock('@d1g1tal/watchr', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@d1g1tal/watchr')>();
	class SafeWatchr extends actual.Watchr {
		constructor(...args: ConstructorParameters<typeof actual.Watchr>) {
			super(...args);
			// Suppress 'Path not found' errors emitted when the watched tmpdir is
			// deleted after close() — expected cleanup behavior in tests.
			this.on('error', () => {});
		}
	}
	return { ...actual, Watchr: SafeWatchr };
});

const rebuildMessage = 'Rebuilding project:';
const readUtf8 = (path: string): Promise<string> => readFile(path, 'utf8');
type LoggerInfoSpy = ReturnType<typeof vi.spyOn>;

const countRebuilds = (loggerSpy: LoggerInfoSpy): number => {
	return loggerSpy.mock.calls.filter((call: unknown[]) => {
		const [ message ] = call;
		return typeof message === 'string' && message.startsWith(rebuildMessage);
	}).length;
};

async function waitForRebuildCount(loggerSpy: LoggerInfoSpy, expectedCount: number, timeout: number) {
	await vi.waitFor(() => {
		expect(countRebuilds(loggerSpy)).toBeGreaterThanOrEqual(expectedCount);
		expect(process.exitCode).toBeUndefined();
	}, { timeout, interval: 100 });
}

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

	it('rebuilds when source files are added and renamed in noEmit mode', { timeout: 20_000 }, async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const version = 1;' },
			tsconfig: { compilerOptions: { noEmit: true }, tsbuild: { watch: { enabled: true }, clean: false } }
		});
		cleanup = c;
		const loggerSpy = vi.spyOn(Logger, 'info');

		project = new TypeScriptProject(dir);
		await project.build();

		await new Promise<void>(resolve => setImmediate(resolve));

		// Add a brand-new source file — exercises the #triggerRebuild "add" branch.
		await writeFile(join(dir, 'src/added.ts'), 'export const added = 1;');
		await waitForRebuildCount(loggerSpy, 1, 7_500);

		// Rename the added file — exercises the #triggerRebuild "rename" branch.
		await rename(join(dir, 'src/added.ts'), join(dir, 'src/renamed.ts'));
		await waitForRebuildCount(loggerSpy, 2, 7_500);

		// Remove it — exercises the #triggerRebuild "unlink" branch.
		await unlink(join(dir, 'src/renamed.ts'));
		await waitForRebuildCount(loggerSpy, 3, 7_500);

		// The watcher kept rebuilding through structural changes without crashing.
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
