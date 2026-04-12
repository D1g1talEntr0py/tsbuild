/**
 * Integration tests for basic build functionality.
 * Uses memfs-backed filesystem with real TypeScript compilation.
 */
import ts from 'typescript';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import type { Path } from '../../src/@types';

vi.mock('../../src/logger', () => ({
	Logger: {
		info: vi.fn(), error: vi.fn(), log: vi.fn(), clear: vi.fn(),
		warn: vi.fn(), success: vi.fn(), header: vi.fn(), separator: vi.fn(),
		step: vi.fn(), subSteps: vi.fn(),
		EntryType: { Info: 'info', Success: 'success', Done: 'done', Error: 'error', Warn: 'warn' }
	}
}));

type TestHelperType = typeof import('../scripts/test-helper').TestHelper;
type VolType = typeof import('memfs').vol;
type TypeScriptProjectType = typeof import('../../src/type-script-project').TypeScriptProject;

describe('TypeScriptProject - Basic Builds', () => {
	let TestHelper: TestHelperType;
	let vol: VolType;
	let TypeScriptProject: TypeScriptProjectType;

	beforeEach(async () => {
		vi.resetModules();
		const testHelperMod = await import('../scripts/test-helper');
		TestHelper = testHelperMod.TestHelper;
		const memfsMod = await import('memfs');
		vol = memfsMod.vol;

		await TestHelper.mockEsbuild();
		await TestHelper.mockFs();
		await TestHelper.setup();

		const tsProjectMod = await import('../../src/type-script-project');
		TypeScriptProject = tsProjectMod.TypeScriptProject;
	});

	afterEach(async () => {
		const { processManager } = await import('../../src/process-manager');
		processManager.close();
		if (TestHelper) TestHelper.teardown();
		vi.doUnmock('node:fs');
		vi.doUnmock('node:fs/promises');
		vi.doUnmock('fs');
		vi.doUnmock('fs/promises');
		vi.doUnmock('esbuild');
		process.exitCode = undefined;
	});

	const createProject = (directory: string, options: Record<string, unknown> = {}): InstanceType<typeof TypeScriptProject> => {
		return new TypeScriptProject(directory as Path, {
			...options,
			tsbuild: {
				...(options.tsbuild as Record<string, unknown>),
				plugins: [TestHelper.createEsbuildPlugin(), ...((options.tsbuild as Record<string, unknown>)?.plugins as [] || [])]
			}
		});
	};

	it('builds a simple ESM project', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { target: 'ES2022', module: ts.ModuleKind.ESNext, outDir: './dist', incremental: false },
				tsbuild: { clean: false, entryPoints: { main: './src/index.ts' } }
			},
			files: { 'src/index.ts': 'export const hello: string = "world";\nexport const add = (a: number, b: number): number => a + b;' }
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/main.js'))).toBe(true);
		const output = vol.readFileSync(join(projectPath, 'dist/main.js'), 'utf8') as string;
		expect(output).toContain('hello');
		expect(output).toContain('add');
	});

	it('builds project with multiple entry points', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { target: 'ES2022', module: ts.ModuleKind.ESNext, outDir: './dist', incremental: false },
				tsbuild: { clean: false, entryPoints: { main: './src/main.ts', utils: './src/utils.ts' } }
			},
			files: {
				'src/main.ts': 'import { helper } from "./utils";\nexport const run = (): string => helper();',
				'src/utils.ts': 'export const helper = (): string => "helping";'
			}
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/main.js'))).toBe(true);
		expect(vol.existsSync(join(projectPath, 'dist/utils.js'))).toBe(true);
	});

	it('cleans output directory when clean option is true', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { declaration: false, incremental: false },
				tsbuild: { entryPoints: { index: './src/index.ts' }, clean: true }
			},
			files: { 'src/index.ts': 'export const value = 42;' }
		});

		const distDir = join(projectPath, 'dist');
		vol.mkdirSync(distDir, { recursive: true });
		vol.writeFileSync(join(distDir, 'old-file.js'), 'old content');

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(distDir, 'old-file.js'))).toBe(false);
		expect(vol.existsSync(join(distDir, 'index.js'))).toBe(true);
	});

	it('handles cross-file imports', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: { clean: false, entryPoints: { index: './src/index.ts' }, dts: { entryPoints: ['index'] } }
			},
			files: {
				'src/index.ts': 'import { Config } from "./config.js";\nexport const app: Config = new Config();',
				'src/config.ts': 'export class Config {\n  name: string = "test";\n}'
			}
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output).toContain('Config');
	});

	it('generates and bundles declaration files', async () => {
		const projectPath = await TestHelper.createTestProject({
			files: { 'src/index.ts': 'export interface User { name: string }\nexport const getUser = (): User => ({ name: "test" });' },
			tsconfig: {
				compilerOptions: { declaration: true },
				tsbuild: { clean: false, dts: { entryPoints: ['index'] } }
			}
		});

		const project = createProject(projectPath);
		await project.build();

		const dts = vol.readFileSync(join(projectPath, 'dist/index.d.ts'), 'utf-8') as string;
		expect(dts).toContain('interface User');
		expect(dts).toContain('declare const getUser');
		expect(dts).toContain('export { getUser');
	});

	it('handles external dependencies', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { types: [], incremental: false },
				tsbuild: { clean: false, entryPoints: { index: './src/index.ts' }, external: ['lodash'] }
			},
			files: {
				'package.json': JSON.stringify({ dependencies: { lodash: '*' } }),
				'src/index.ts': 'import type { DebouncedFunc } from "lodash";\nimport { debounce } from "lodash";\nexport const fn: DebouncedFunc<() => void> = debounce(() => {}, 100);',
				'node_modules/@types/lodash/index.d.ts': 'export interface DebouncedFunc<T extends (...args: any[]) => any> { (...args: Parameters<T>): ReturnType<T> | undefined }\nexport function debounce<T extends (...args: any) => any>(func: T, wait?: number): DebouncedFunc<T>;'
			},
			packageJson: { dependencies: { lodash: '^4.17.21' } }
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output).toContain('lodash');
		expect(output).toContain('debounce');
	});

	it('supports code splitting', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: {
					clean: false, splitting: true, bundle: true,
					entryPoints: { entry1: './src/entry1.ts', entry2: './src/entry2.ts' }
				}
			},
			files: {
				'src/entry1.ts': 'import { shared } from "./shared";\nexport const e1 = (): string => shared();',
				'src/entry2.ts': 'import { shared } from "./shared";\nexport const e2 = (): string => shared();',
				'src/shared.ts': 'export const shared = (): string => "shared code";'
			}
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/entry1.js'))).toBe(true);
		expect(vol.existsSync(join(projectPath, 'dist/entry2.js'))).toBe(true);
	});

	it('minifies output when configured', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: { tsbuild: { clean: false, entryPoints: { index: './src/index.ts' }, minify: true } },
			files: {
				'src/index.ts': 'export const longFunctionName = (parameter: string): string => {\n\tconst localVariable = parameter.toUpperCase();\n\treturn localVariable;\n};'
			}
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output.length).toBeLessThan(200);
		expect(output).not.toContain('localVariable');
	});

	it('generates source maps when configured', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { sourceMap: true, incremental: false },
				tsbuild: { clean: false, entryPoints: { index: './src/index.ts' } }
			},
			files: { 'src/index.ts': 'export const test: number = 123;' }
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/index.js'))).toBe(true);
		expect(vol.existsSync(join(projectPath, 'dist/index.js.map'))).toBe(true);
		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output).toContain('//# sourceMappingURL=index.js.map');
	});

	it('handles CLI entry points with shebang', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { lib: ['ES2022', 'DOM'], incremental: false },
				tsbuild: { clean: false, entryPoints: { cli: './src/cli.ts' } }
			},
			files: { 'src/cli.ts': '#!/usr/bin/env node\nconsole.log("CLI tool");\nexport {};' }
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/cli.js'), 'utf8') as string;
		expect(output).toContain('#!/usr/bin/env node');
	});

	it('removes empty export statements from unbundled declaration files', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { target: 'ES2022', module: ts.ModuleKind.ESNext, outDir: './dist', declaration: true },
				tsbuild: { clean: false, entryPoints: { index: './src/index.ts' }, bundle: false, dts: {} }
			},
			files: { 'src/index.ts': 'export class KeyedNode<K, E> { key!: K; value!: E }' }
		});

		const project = createProject(projectPath);
		await project.build();

		const dtsOutput = vol.readFileSync(join(projectPath, 'dist/index.d.ts'), 'utf8') as string;
		expect(dtsOutput).toContain('declare class KeyedNode');
		expect(dtsOutput).toContain('export { KeyedNode }');
		expect(dtsOutput).not.toContain('export {};');
	});

	it('removes empty export statements when bundling declarations', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { target: 'ES2022', module: ts.ModuleKind.ESNext, outDir: './dist', declaration: true },
				tsbuild: { clean: false, entryPoints: { index: './src/index.ts' }, bundle: false, dts: { entryPoints: ['index'] } }
			},
			files: { 'src/index.ts': 'export class KeyedNode<K, E> { key!: K; value!: E }' }
		});

		const project = createProject(projectPath);
		await project.build();

		const dtsOutput = vol.readFileSync(join(projectPath, 'dist/index.d.ts'), 'utf8') as string;
		expect(dtsOutput).toContain('declare class KeyedNode');
		expect(dtsOutput).toMatch(/export\s+(type\s+)?{.*KeyedNode/);
		expect(dtsOutput).not.toContain('export {};');
	});

	describe('parallel processing', () => {
		it('handles concurrent declarations and transpile without race conditions', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: { target: 'ES2022', module: ts.ModuleKind.ESNext, outDir: './dist', declaration: true },
					tsbuild: { clean: false, entryPoints: { index: './src/index.ts' } }
				},
				files: { 'src/index.ts': 'export interface Config { name: string; value: number; }\nexport const config: Config = { name: "test", value: 42 };' }
			});

			const project = createProject(projectPath);
			await project.build();

			expect(vol.existsSync(join(projectPath, 'dist/index.js'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist/index.d.ts'))).toBe(true);
		});

		it('handles emitDeclarationOnly without transpile', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: { target: 'ES2022', module: ts.ModuleKind.ESNext, outDir: './dist', declaration: true, emitDeclarationOnly: true },
					tsbuild: { clean: false, entryPoints: { index: './src/index.ts' } }
				},
				files: { 'src/index.ts': 'export const value: number = 42;' }
			});

			const project = createProject(projectPath);
			await project.build();

			expect(vol.existsSync(join(projectPath, 'dist/index.d.ts'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist/index.js'))).toBe(false);
		});

		it('handles multiple entry points with parallel bundling', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: { target: 'ES2022', module: ts.ModuleKind.ESNext, outDir: './dist', declaration: true },
					tsbuild: { clean: false, entryPoints: { main: './src/main.ts', utils: './src/utils.ts', types: './src/types.ts' } }
				},
				files: {
					'src/main.ts': 'import { helper } from "./utils";\nexport const run = (): string => helper();',
					'src/utils.ts': 'export const helper = (): string => "helping";',
					'src/types.ts': 'export interface User { id: number; name: string }'
				}
			});

			const project = createProject(projectPath);
			await project.build();

			for (const entry of ['main', 'utils', 'types']) {
				expect(vol.existsSync(join(projectPath, `dist/${entry}.js`))).toBe(true);
				expect(vol.existsSync(join(projectPath, `dist/${entry}.d.ts`))).toBe(true);
			}
		});
	});

	it('handles TypeScript decorators', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { experimentalDecorators: true, lib: ['ES2022', 'DOM'], incremental: false },
				tsbuild: { clean: false, entryPoints: { index: './src/index.ts' } }
			},
			files: {
				'src/index.ts': 'function log(target: any, key: string): void { console.log(`Decorated ${key}`); }\nexport class Example { @log method(): void {} }'
			}
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output).toContain('Example');
	});
});
