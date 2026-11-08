import { describe, it, expect, afterEach, vi } from 'vitest';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TypeScriptProject } from '../../src/type-script-project';
import { Paths } from '../../src/paths';
import { processManager } from '../../src/process-manager';
import { TestHelper } from '../scripts/test-helper';

describe('TypeScriptProject - Integration Builds', () => {
	let cleanup: (() => Promise<void>) | undefined;
	const run = promisify(execFile);

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

		const project2 = new TypeScriptProject(dir, { tsbuild: { clean: true, entryPoints: { keep: Paths.relative(dir, join(dir, 'src/keep.ts')) } } });
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

		const output = await TestHelper.importOutput<{ app: { name: string } }>(join(dir, 'dist/index.js'));
		expect(output.app.name).toBe('test');
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

	it('preserves shared declaration identity across bundled entry points', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/shared.ts': `export class Shared { #private = true; }
export default Shared;
export const brand: unique symbol = Symbol('brand');
export interface Branded { readonly [brand]: true; }`,
				'src/entry1.ts': `export { Shared, default, brand } from './shared.js';
export type { Branded } from './shared.js';`,
				'src/entry2.ts': `export { Shared, default, brand } from './shared.js';
export type { Branded } from './shared.js';`
			},
			tsconfig: {
				tsbuild: {
					splitting: true, bundle: true,
					entryPoints: { entry1: './src/entry1.ts', entry2: './src/entry2.ts', shared: './src/shared.ts' }
				}
			}
		});
		cleanup = c;

		const project = new TypeScriptProject(dir);
		await project.build();
		project.close();

		const entry1 = await readFile(join(dir, 'dist/entry1.d.ts'), 'utf8');
		const entry2 = await readFile(join(dir, 'dist/entry2.d.ts'), 'utf8');
		const sharedEntry = await readFile(join(dir, 'dist/shared.d.ts'), 'utf8');
		const [ runtime1, runtime2, runtimeShared ] = await Promise.all([
			TestHelper.importOutput<{ Shared: new () => object; brand: symbol }>(join(dir, 'dist/entry1.js')),
			TestHelper.importOutput<{ Shared: new () => object; brand: symbol }>(join(dir, 'dist/entry2.js')),
			TestHelper.importOutput<{ default: new () => object; brand: symbol }>(join(dir, 'dist/shared.js'))
		]);
		expect(entry1).toContain(`from './shared.js'`);
		expect(entry2).toContain(`from './shared.js'`);
		expect(entry1).not.toContain('class Shared');
		expect(entry2).not.toContain('class Shared');
		expect(sharedEntry).toContain('class Shared');
		expect(sharedEntry).toContain('Shared as default');
		await expect(access(join(dir, 'dist/__tsbuild_shared'))).rejects.toThrow();
		expect(runtime1.Shared).toBe(runtime2.Shared);
		expect(runtime1.Shared).toBe(runtimeShared.default);
		expect(runtime1.brand).toBe(runtime2.brand);
		expect(runtime1.brand).toBe(runtimeShared.brand);

		await writeFile(join(dir, 'consumer.ts'), `import type Default1 from './dist/entry1.js';
import type { Shared as Shared1, Branded as Branded1 } from './dist/entry1.js';
import type Default2 from './dist/entry2.js';
import type { Shared as Shared2, Branded as Branded2 } from './dist/entry2.js';
import type Default3 from './dist/shared.js';
import type { Shared as Shared3, Branded as Branded3 } from './dist/shared.js';
declare const first: Shared1;
declare const firstDefault: Default1;
declare const branded: Branded1;
const second: Shared2 = first;
const secondDefault: Default2 = firstDefault;
const third: Shared3 = second;
const thirdDefault: Default3 = secondDefault;
const sameBrand: Branded2 = branded;
const sameBrandAgain: Branded3 = sameBrand;
export { second, secondDefault, third, thirdDefault, sameBrand, sameBrandAgain };`);
		try {
			await run('pnpm', [ 'exec', 'tsc', '--ignoreConfig', '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', 'false', 'consumer.ts' ], { cwd: dir });
		} catch (error) {
			if (error instanceof Error && 'stdout' in error && 'stderr' in error) { throw new Error(`${String(error.stdout)}${String(error.stderr)}`, { cause: error }) }
			throw error;
		}
	});

	it('regenerates outputs when the cached output directory is deleted', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: { 'src/index.ts': 'export const value = 1;' },
			tsconfig: { tsbuild: { clean: false } }
		});
		cleanup = c;

		const first = new TypeScriptProject(dir);
		await first.build();
		first.close();
		await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();

		await rm(join(dir, 'dist'), { recursive: true, force: true });

		const second = new TypeScriptProject(dir);
		await second.build();
		second.close();

		await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
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
		const sourceMap: { version: number; sources: string[] } = JSON.parse(await readFile(join(dir, 'dist/index.js.map'), 'utf8'));
		expect(sourceMap.version).toBe(3);
		expect(sourceMap.sources.some(source => source.endsWith('/src/index.ts'))).toBe(true);
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
		const global: Record<string, unknown> = {};
		runInNewContext(iifeOutput, global);
		expect(global['test']).toBe(123);
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
		expect(output).toMatch(/from\s*["']magic-string["']/);
	});

	it('bundles a tsconfig paths-aliased import instead of leaving it as an unresolved external specifier when noExternal is set', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				'src/utils.ts': "export const util = (): string => 'utils';",
				'src/index.ts': "import { util } from '@app/utils'; export const value: string = util();"
			},
			tsconfig: {
				compilerOptions: { declaration: false, paths: { '@app/*': ['./src/*'] } },
				tsbuild: { clean: false, noExternal: ['some-unrelated-package'] }
			}
		});
		cleanup = c;

		const project = new TypeScriptProject(dir);
		await project.build();
		project.close();

		const output = await TestHelper.importOutput<{ value: string }>(join(dir, 'dist/index.js'));
		expect(output.value).toBe('utils');
	});

	it('sets exit code 2 and reports the bundling failure exactly once for an unresolvable bundled import', async () => {
		const { dir, cleanup: c } = await TestHelper.createTempProject({
			files: {
				// Ambient declaration satisfies the type checker so the failure only surfaces at bundle time.
				'src/ambient.d.ts': "declare module 'tsbuild-test-nonexistent-package';",
				'src/index.ts': "import { missing } from 'tsbuild-test-nonexistent-package'; export { missing };"
			},
			tsconfig: {
				compilerOptions: { declaration: false },
				tsbuild: { clean: false, packages: 'bundle' }
			}
		});
		cleanup = c;

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		const project = new TypeScriptProject(dir);
		try {
			await project.build();
			project.close();

			expect(process.exitCode).toBe(2);

			const unresolvedImportReports = logSpy.mock.calls.filter(([message]) =>
				typeof message === 'string' && message.includes('tsbuild-test-nonexistent-package')).length;
			expect(unresolvedImportReports).toBe(1);
		} finally {
			logSpy.mockRestore();
		}
	});
});
