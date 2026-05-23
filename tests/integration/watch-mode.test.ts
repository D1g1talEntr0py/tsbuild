import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestHelper } from '../scripts/test-helper';
import type { AbsolutePath } from '../../src/@types';

vi.mock('../../src/logger', () => ({
	Logger: {
		info: vi.fn(), error: vi.fn(), log: vi.fn(), clear: vi.fn(),
		warn: vi.fn(), success: vi.fn(), header: vi.fn(), separator: vi.fn(),
		step: vi.fn(), subSteps: vi.fn(),
		EntryType: { Info: 'info', Success: 'success', Done: 'done', Error: 'error', Warn: 'warn' }
	}
}));

vi.mock('@d1g1tal/watchr', () => ({
	Watchr: class {
		static FileEvent = { add: 'add', unlink: 'unlink', change: 'change', rename: 'rename' };
		isClosed(): boolean { return false; }
		close(): void {}
	}
}));

describe('TypeScriptProject - Watch Mode', () => {
	let TypeScriptProject: typeof import('../../src/type-script-project').TypeScriptProject;
	let project: InstanceType<typeof TypeScriptProject> | undefined;

	afterEach(async () => {
		project?.close();
		TestHelper.teardown();
		vi.doUnmock('node:fs');
		vi.doUnmock('node:fs/promises');
		vi.doUnmock('fs');
		vi.doUnmock('fs/promises');
		vi.doUnmock('esbuild');
		process.exitCode = undefined;
	});

	it('starts watching when watch is enabled', async () => {
		vi.resetModules();
		await TestHelper.mockFs();
		await TestHelper.mockEsbuild();
		await TestHelper.setup();
		({ TypeScriptProject } = await import('../../src/type-script-project'));
		const { Logger } = await import('../../src/logger');

		const projectPath = TestHelper.createTestProject({
			tsconfig: {
				tsbuild: { entryPoints: { index: './src/index.ts' }, watch: { enabled: true } }
			},
			files: { 'src/index.ts': 'export const version = 1;' }
		});

		project = new TypeScriptProject(projectPath as AbsolutePath);
		await project.build();
		// build() schedules watch() via setImmediate — flush it before asserting
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(Logger.info).toHaveBeenCalledWith(expect.stringContaining('Watching for changes'));
	});

	it('cleans up resources when close is called', async () => {
		vi.resetModules();
		await TestHelper.mockFs();
		await TestHelper.mockEsbuild();
		await TestHelper.setup();
		({ TypeScriptProject } = await import('../../src/type-script-project'));

		const projectPath = TestHelper.createTestProject({
			tsconfig: {
				tsbuild: { entryPoints: { index: './src/index.ts' }, watch: { enabled: true } }
			},
			files: { 'src/index.ts': 'export const version = 1;' }
		});

		project = new TypeScriptProject(projectPath as AbsolutePath);
		await project.build();
		await new Promise<void>(resolve => setImmediate(resolve));

		expect(() => project!.close()).not.toThrow();
		expect(() => project!.close()).not.toThrow(); // Idempotent
	});
});
