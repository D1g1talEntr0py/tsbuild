import { vi, describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
			this.on('error', () => {});
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
