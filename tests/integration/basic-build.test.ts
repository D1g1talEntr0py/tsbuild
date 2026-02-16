/**
 * Integration tests for basic build functionality
 * Uses memfs to test build behavior
 */
import ts from 'typescript';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { defaultDirOptions } from '../../src/constants';
import type { Path } from '../../src/@types';

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

// Define types for dynamically imported modules
type TestHelperType = typeof import('../scripts/test-helper').TestHelper;
type VolType = typeof import('memfs').vol;
type TypeScriptProjectType = typeof import('../../src/type-script-project').TypeScriptProject;

describe('TypeScriptProject - Basic Builds', () => {
	let TestHelper: TestHelperType;
	let vol: VolType;
	let TypeScriptProject: TypeScriptProjectType;

	beforeEach(async () => {
		vi.resetModules();
		// Re-import modules after reset to ensure they use the mocked fs and fresh memfs
		const testHelperMod = await import('../scripts/test-helper');
		TestHelper = testHelperMod.TestHelper;

		const memfsMod = await import('memfs');
		vol = memfsMod.vol;

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
	});

	// Helper to create project instance with plugin
	const createProject = (directory: string, options: Record<string, unknown> = {}): InstanceType<typeof TypeScriptProject> => {
		const resolvedOptions = {
			...options,
			tsbuild: {
				...(options.tsbuild as Record<string, unknown>),
				plugins: [TestHelper.createEsbuildPlugin(), ...((options.tsbuild as Record<string, unknown>)?.plugins as [] || [])]
			}
		};
		return new TypeScriptProject(directory as Path, resolvedOptions);
	};	it('should build a simple ESM project', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					target: 'ES2022',
					module: ts.ModuleKind.ESNext,
					outDir: './dist',
				},
				tsbuild: {
					clean: false,
					entryPoints: { main: './src/index.ts' },
				},
			},
			files: {
				'src/index.ts': 'export const hello: string = "world";\nexport const add = (a: number, b: number): number => a + b;',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		// Verify output was created
		expect(vol.existsSync(join(projectPath, 'dist/main.js'))).toBe(true);

		const output = vol.readFileSync(join(projectPath, 'dist/main.js'), 'utf8') as string;
		expect(output).toContain('hello');
		expect(output).toContain('world');
		expect(output).toContain('add');
	});

	it('should build project with multiple entry points', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					target: 'ES2022',
					module: ts.ModuleKind.ESNext,
					outDir: './dist',
				},
				tsbuild: {
					clean: false,
					entryPoints: {
						main: './src/main.ts',
						utils: './src/utils.ts',
					},
				},
			},
			files: {
				'src/main.ts': 'import { helper } from "./utils";\nexport const run = (): string => helper();',
				'src/utils.ts': 'export const helper = (): string => "helping";',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/main.js'))).toBe(true);
		expect(vol.existsSync(join(projectPath, 'dist/utils.js'))).toBe(true);

		const mainOutput = vol.readFileSync(join(projectPath, 'dist/main.js'), 'utf8') as string;
		expect(mainOutput).toContain('run');

		const utilsOutput = vol.readFileSync(join(projectPath, 'dist/utils.js'), 'utf8') as string;
		expect(utilsOutput).toContain('helper');
	});

	it('should clean output directory when clean option is true', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: { declaration: false },
				tsbuild: { entryPoints: { index: './src/index.ts' }, clean: true }
			},
			files: {
				'src/index.ts': 'export const value = 42;'
			}
		});

		// Create an old file in dist that should be removed by clean
		const distDir = join(projectPath, 'dist');
		vol.mkdirSync(distDir, { recursive: true });
		vol.writeFileSync(join(distDir, 'old-file.js'), 'old content');
		expect(vol.existsSync(join(distDir, 'old-file.js'))).toBe(true);

		// Build the project
		const project = createProject(projectPath);
		await project.build();

		// Verify the old file was cleaned
		expect(vol.existsSync(join(distDir, 'old-file.js'))).toBe(false);
		// Verify the new build output exists
		expect(vol.existsSync(join(distDir, 'index.js'))).toBe(true);
	});

	it('should handle imports from other files', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: {
					clean: false,
					entryPoints: { index: './src/index.ts' },
					dts: { entryPoints: ['index'] },
				},
			},
			files: {
				'src/index.ts': 'import { Config } from "./config.js";\nexport const app: Config = new Config();',
				'src/config.ts': 'export class Config {\n  name: string = "test";\n}',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/index.js'))).toBe(true);
		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output).toContain('Config');
		expect(output).toContain('app');
	});

	it('should generate declaration files when dts is configured', async () => {
		const projectPath = await TestHelper.createTestProject({
			files: {
				'src/index.ts': 'export interface User { name: string }\nexport const getUser = (): User => ({ name: "test" });',
			},
			tsconfig: {
				compilerOptions: {
					declaration: true,
				},
				tsbuild: {
					clean: false,
					dts: {
						entryPoints: ['index'],
					},
				},
			},
		});

		const project = createProject(projectPath);
		await project.build();

		const dts = vol.readFileSync(join(projectPath, 'dist/index.d.ts'), 'utf-8') as string;
		expect(dts).toContain('interface User');
		expect(dts).toContain('declare const getUser');
		expect(dts).toContain('export { getUser };');
	});

	it('should handle external dependencies', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					types: [],
				},
				tsbuild: {
					clean: false,
					entryPoints: { index: './src/index.ts' },
					external: ['lodash'],
				},
			},
			files: {
				'package.json': JSON.stringify({ dependencies: { lodash: '*' } }),
				'src/index.ts': 'import type { DebouncedFunc } from "lodash";\nimport { debounce } from "lodash";\nexport const fn: DebouncedFunc<() => void> = debounce(() => {}, 100);',
				'node_modules/@types/lodash/index.d.ts': 'export interface DebouncedFunc<T extends (...args: any[]) => any> { (...args: Parameters<T>): ReturnType<T> | undefined }\nexport function debounce<T extends (...args: any) => any>(func: T, wait?: number): DebouncedFunc<T>;',
			},
			packageJson: {
				dependencies: {
					lodash: '^4.17.21',
				},
			},
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		// Should import from lodash, not bundle it
		expect(output).toContain('lodash');
		expect(output).toContain('debounce');
	});

	it('should support code splitting', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: {
					clean: false,
					entryPoints: {
						entry1: './src/entry1.ts',
						entry2: './src/entry2.ts',
					},
					splitting: true,
					bundle: true,
				},
			},
			files: {
				'src/entry1.ts': 'import { shared } from "./shared";\nexport const e1 = (): string => shared();',
				'src/entry2.ts': 'import { shared } from "./shared";\nexport const e2 = (): string => shared();',
				'src/shared.ts': 'export const shared = (): string => "shared code";',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/entry1.js'))).toBe(true);
		expect(vol.existsSync(join(projectPath, 'dist/entry2.js'))).toBe(true);

		// With splitting, there should be a shared chunk
		// (exact filename depends on esbuild's chunking strategy)
	});

	it('should minify output when configured', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				tsbuild: {
					clean: false,
					entryPoints: { index: './src/index.ts' },
					minify: true,
				},
			},
			files: {
				'src/index.ts': `
					export const longFunctionName = (parameter: string): string => {
						const localVariable = parameter.toUpperCase();
						return localVariable;
					};
				`,
			},
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		// Minified output should be compact
		expect(output.length).toBeLessThan(200); // Original is much longer
		expect(output).not.toContain('localVariable'); // Should be renamed
	});

	it('should handle TypeScript decorators', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					experimentalDecorators: true,
					lib: ['ES2022', 'DOM'], // Need DOM for console
				},
				tsbuild: {
					clean: false,
					entryPoints: { index: './src/index.ts' },
				},
			},
			files: {
				'src/index.ts': `
					function log(target: any, key: string): void {
						console.log(\`Decorated \${key}\`);
					}
					export class Example {
						@log
						method(): void {}
					}
				`,
			},
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output).toContain('Example');
		expect(output).toContain('method');
	});

	it('should generate source maps when configured', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					sourceMap: true,
				},
				tsbuild: {
					clean: false,
					entryPoints: { index: './src/index.ts' },
				},
			},
			files: {
				'src/index.ts': 'export const test: number = 123;',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		expect(vol.existsSync(join(projectPath, 'dist/index.js'))).toBe(true);
		expect(vol.existsSync(join(projectPath, 'dist/index.js.map'))).toBe(true);

		const output = vol.readFileSync(join(projectPath, 'dist/index.js'), 'utf8') as string;
		expect(output).toContain('//# sourceMappingURL=index.js.map');
	});

	it('should handle CLI entry points with shebang', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					lib: ['ES2022', 'DOM'], // Need DOM for console
				},
				tsbuild: {
					clean: false,
					entryPoints: { cli: './src/cli.ts' },
				},
			},
			files: {
				'src/cli.ts': '#!/usr/bin/env node\nconsole.log("CLI tool");\nexport {};',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		const output = vol.readFileSync(join(projectPath, 'dist/cli.js'), 'utf8') as string;
		expect(output).toContain('#!/usr/bin/env node');
		expect(output).toContain('CLI tool');
	});

	it('should remove empty export statements from declaration files', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					target: 'ES2022',
					module: ts.ModuleKind.ESNext,
					outDir: './dist',
					declaration: true,
				},
				tsbuild: {
					clean: false,
					entryPoints: { index: './src/index.ts' },
					bundle: false, // Don't bundle JS
					dts: {}, // Generate .d.ts but don't bundle (mirrors source structure)
				},
			},
			files: {
				'src/index.ts': 'export class KeyedNode<K, E> { key!: K; value!: E }',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		// Check the declaration file output is written (shows pre-processor ran)
		// When dts is configured but no entryPoints, it just emits declarations
		const dtsOutput = vol.readFileSync(join(projectPath, 'dist/index.d.ts'), 'utf8') as string;

		// Should have the class declaration
		expect(dtsOutput).toContain('declare class KeyedNode');
		// Should have export statement
		expect(dtsOutput).toContain('export { KeyedNode }');
		// Should NOT have empty export
		expect(dtsOutput).not.toContain('export {};');
		// Should only have ONE export statement
		const exportMatches = dtsOutput.match(/export\s+{/g);
		expect(exportMatches).toHaveLength(1);
	});

	it('should remove empty export statements when bundling declarations', async () => {
		const projectPath = await TestHelper.createTestProject({
			tsconfig: {
				compilerOptions: {
					target: 'ES2022',
					module: ts.ModuleKind.ESNext,
					outDir: './dist',
					declaration: true,
				},
				tsbuild: {
					clean: false,
					entryPoints: { index: './src/index.ts' },
					bundle: false, // Don't bundle JS
					dts: { entryPoints: ['index'] }, // But bundle DTS
				},
			},
			files: {
				'src/index.ts': 'export class KeyedNode<K, E> { key!: K; value!: E }',
			},
		});

		const project = createProject(projectPath);
		await project.build();

		// Check the bundled declaration file
		const dtsOutput = vol.readFileSync(join(projectPath, 'dist/index.d.ts'), 'utf8') as string;

		// Should have the declarations
		expect(dtsOutput).toContain('declare class KeyedNode');
		// Should have export statements
		expect(dtsOutput).toMatch(/export\s+(type\s+)?{.*KeyedNode/);
		// Should NOT have empty export
		expect(dtsOutput).not.toContain('export {};');
	});

	describe('parallel processing', () => {
		it('should handle concurrent processDeclarations() and transpile() without race conditions', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: {
						target: 'ES2022',
						module: ts.ModuleKind.ESNext,
						outDir: './dist',
						declaration: true,
					},
					tsbuild: {						clean: false,						entryPoints: { index: './src/index.ts' },
					},
				},
				files: {
					'src/index.ts': `
						export interface Config {
							name: string;
							value: number;
						}
						export const config: Config = { name: 'test', value: 42 };
					`,
				},
			});

			const project = createProject(projectPath);
			await project.build();

			// Verify both outputs were created without corruption
			expect(vol.existsSync(join(projectPath, 'dist', 'index.js'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist', 'index.d.ts'))).toBe(true);

			// Verify content is correct (wasn't corrupted by race)
			const jsOutput = vol.readFileSync(join(projectPath, 'dist', 'index.js'), 'utf8') as string;
			expect(jsOutput).toContain('config');

			const dtsOutput = vol.readFileSync(join(projectPath, 'dist', 'index.d.ts'), 'utf8') as string;
			expect(dtsOutput).toContain('Config');
		});

		it('should handle emitDeclarationOnly without transpile race', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: {
						target: 'ES2022',
						module: ts.ModuleKind.ESNext,
						outDir: './dist',
						declaration: true,
						emitDeclarationOnly: true,
					},
					tsbuild: {						clean: false,						entryPoints: { index: './src/index.ts' },
					},
				},
				files: {
					'src/index.ts': 'export const value: number = 42;',
				},
			});

			const project = createProject(projectPath);
			await project.build();

			// Only declaration file should exist
			expect(vol.existsSync(join(projectPath, 'dist', 'index.d.ts'))).toBe(true);

			// No JS file should be created (emitDeclarationOnly)
			expect(vol.existsSync(join(projectPath, 'dist', 'index.js'))).toBe(false);
		});

		it('should handle multiple entry points with parallel bundling without corruption', async () => {
			const projectPath = await TestHelper.createTestProject({
				tsconfig: {
					compilerOptions: {
						target: 'ES2022',
						module: ts.ModuleKind.ESNext,
						outDir: './dist',
						declaration: true,
					},
					tsbuild: {						clean: false,						entryPoints: {
							main: './src/main.ts',
							utils: './src/utils.ts',
							types: './src/types.ts',
						},
					},
				},
				files: {
					'src/main.ts': 'import { helper } from "./utils";\nexport const run = (): string => helper();',
					'src/utils.ts': 'export const helper = (): string => "helping";',
					'src/types.ts': 'export interface User { id: number; name: string }',
				},
			});

			const project = createProject(projectPath);
			await project.build();

			// All outputs should exist
			expect(vol.existsSync(join(projectPath, 'dist', 'main.js'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist', 'utils.js'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist', 'types.js'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist', 'main.d.ts'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist', 'utils.d.ts'))).toBe(true);
			expect(vol.existsSync(join(projectPath, 'dist', 'types.d.ts'))).toBe(true);
		});
	});
});
