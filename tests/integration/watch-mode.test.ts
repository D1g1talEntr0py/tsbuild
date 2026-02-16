import { describe, it, expect, afterEach, vi } from 'vitest';
import { TestHelper } from '../scripts/test-helper';
import type { AbsolutePath } from '../../src/@types';

vi.mock('../../src/logger', () => ({
	Logger: {
		info: vi.fn(),
		error: vi.fn(),
		log: vi.fn(),
		clear: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		header: vi.fn(),
		separator: vi.fn(),
		step: vi.fn(),
		EntryType: { Info: 'info', Success: 'success', Done: 'done', Error: 'error', Warn: 'warn' }
	}
}));

describe('TypeScriptProject - Watch Mode', () => {
	let TypeScriptProject: typeof import('../../src/type-script-project').TypeScriptProject;
	let project: TypeScriptProject | undefined;

	afterEach(async () => {
		project?.close();
		TestHelper.teardown();
	});

	it('should start watching when watch() is called', async () => {
		vi.resetModules();
		({ TypeScriptProject } = await import('../../src/type-script-project'));
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: {
					entryPoints: { index: './src/index.ts' },
					watch: { enabled: true },
				},
			},
			files: {
				'src/index.ts': 'export const version = 1;',
			},
		});

		project = new TypeScriptProject(projectPath as AbsolutePath);
		const { Logger } = await import('../../src/logger');

		await project.watch();

		expect(Logger.info).toHaveBeenCalledWith(expect.stringContaining('Watching for changes'));
	});

	it('should clean up resources when close() is called', async () => {
		vi.resetModules();
		({ TypeScriptProject } = await import('../../src/type-script-project'));
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: {
					entryPoints: { index: './src/index.ts' },
					watch: { enabled: true },
				},
			},
			files: {
				'src/index.ts': 'export const version = 1;',
			},
		});

		project = new TypeScriptProject(projectPath as AbsolutePath);
		project.watch();

		// Should not throw when closing
		expect(() => project!.close()).not.toThrow();

		// Calling close again should be safe (idempotent)
		expect(() => project!.close()).not.toThrow();
	});
});
