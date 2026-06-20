import { describe, it, expect, afterEach } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptProject } from '../../src/type-script-project';
import { processManager } from '../../src/process-manager';
import { TestHelper } from '../scripts/test-helper';

describe('TypeScriptProject - Integration Builds', () => {
	let cleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		processManager.close();
		await cleanup?.();
		cleanup = undefined;
		process.exitCode = undefined;
	});

	it('removes stale outputs from prior builds via manifest on incremental rebuild', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/keep.ts': 'export const k = 1;',
				'src/remove.ts': 'export const r = 2;'
			},
			tsconfig: { tsbuild: { entryPoints: { keep: './src/keep.ts', remove: './src/remove.ts' }, clean: true } }
		});
		cleanup = c;

		const project1 = new TypeScriptProject(dir);
		await project1.build();
		project1.close();

		await expect(access(join(dir, 'dist/keep.js'))).resolves.toBeUndefined();
		await expect(access(join(dir, 'dist/remove.js'))).resolves.toBeUndefined();

		const project2 = new TypeScriptProject(dir, { tsbuild: { clean: true, entryPoints: { keep: './src/keep.ts' } } });
		await project2.build();
		project2.close();

		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			try {
				await access(join(dir, 'dist/remove.js'));
				await new Promise<void>(resolve => setImmediate(resolve));
			} catch { break; }
		}

		await expect(access(join(dir, 'dist/keep.js'))).resolves.toBeUndefined();
		await expect(access(join(dir, 'dist/remove.js'))).rejects.toThrow();
	});

	it('bundles cross-file imports', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/config.ts': 'export class Config { name: string = "test"; }',
				'src/index.ts': 'import { Config } from "./config.js"; export const app: Config = new Config();'
			},
			tsconfig: { tsbuild: { clean: false, entryPoints: { index: './src/index.ts' } } }
		});
		cleanup = c;

		const project = new TypeScriptProject(dir);
		await project.build();
		project.close();

		const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
		expect(output).toContain('Config');
	});

	it('supports code splitting with multiple entry points', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/shared.ts': 'export const shared = (): string => "shared code";',
				'src/entry1.ts': 'import { shared } from "./shared"; export const e1 = (): string => shared();',
				'src/entry2.ts': 'import { shared } from "./shared"; export const e2 = (): string => shared();'
			},
			tsconfig: {
				tsbuild: {
					clean: false, splitting: true, bundle: true,
					entryPoints: { entry1: './src/entry1.ts', entry2: './src/entry2.ts' }
				}
			}
		});
		cleanup = c;

		const project = new TypeScriptProject(dir);
		await project.build();
		project.close();

		await expect(access(join(dir, 'dist/entry1.js'))).resolves.toBeUndefined();
		await expect(access(join(dir, 'dist/entry2.js'))).resolves.toBeUndefined();
	});

	it('generates external source maps when sourceMap is enabled', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const test: number = 123;' },
			tsconfig: {
				compilerOptions: { sourceMap: true },
				tsbuild: { clean: false }
			}
		});
		cleanup = c;

		const project = new TypeScriptProject(dir);
		await project.build();
		project.close();

		await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
		await expect(access(join(dir, 'dist/index.js.map'))).resolves.toBeUndefined();
		const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
		expect(output).toContain('sourceMappingURL');
	});

	it('generates IIFE output alongside ESM when iife is enabled', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const test: number = 123;' },
			tsconfig: {
				compilerOptions: { declaration: false },
				tsbuild: { clean: false, iife: true }
			}
		});
		cleanup = c;

		const project = new TypeScriptProject(dir);
		await project.build();
		project.close();

		await expect(access(join(dir, 'dist/iife/index.js'))).resolves.toBeUndefined();
		const iifeOutput = await readFile(join(dir, 'dist/iife/index.js'), 'utf8');
		expect(iifeOutput).toContain('test');
	});

	it('marks external packages as external rather than bundling them', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': "import MagicString from 'magic-string'; export const ms = new MagicString('');" },
			tsconfig: {
				compilerOptions: { declaration: false },
				tsbuild: { clean: false }
			},
			packageJson: {
				name: 'test-project',
				version: '1.0.0',
				type: 'module',
				dependencies: { 'magic-string': '*' }
			}
		});
		cleanup = c;

		const project = new TypeScriptProject(dir);
		await project.build();
		project.close();

		const output = await readFile(join(dir, 'dist/index.js'), 'utf8');
		expect(output).toContain('magic-string');
		expect(output.length).toBeLessThan(5000);
	});
});
