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

describe('TypeScriptProject - Watch Mode', () => {
	let TypeScriptProject: typeof import('../../src/type-script-project').TypeScriptProject;
	let project: InstanceType<typeof TypeScriptProject> | undefined;

	afterEach(async () => {
		project?.close();
		TestHelper.teardown();
	});

	it('starts watching when watch is enabled', async () => {
		vi.resetModules();
		({ TypeScriptProject } = await import('../../src/type-script-project'));
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: { entryPoints: { index: './src/index.ts' }, watch: { enabled: true } }
			},
			files: { 'src/index.ts': 'export const version = 1;' }
		});

		project = new TypeScriptProject(projectPath as AbsolutePath);
		const { Logger } = await import('../../src/logger');

		await project.watch();
		expect(Logger.info).toHaveBeenCalledWith(expect.stringContaining('Watching for changes'));
	});

	it('cleans up resources when close is called', async () => {
		vi.resetModules();
		({ TypeScriptProject } = await import('../../src/type-script-project'));
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: { entryPoints: { index: './src/index.ts' }, watch: { enabled: true } }
			},
			files: { 'src/index.ts': 'export const version = 1;' }
		});

		project = new TypeScriptProject(projectPath as AbsolutePath);
		project.watch();

		expect(() => project!.close()).not.toThrow();
		expect(() => project!.close()).not.toThrow(); // Idempotent
	});
});
