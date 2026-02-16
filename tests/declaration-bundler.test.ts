import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import { TestHelper } from './scripts/test-helper';
import type { AbsolutePath } from '../src/@types';
import type { bundleDeclarations as BundleDeclarationsFn } from '../src/dts';

// Mock node:fs and node:fs/promises
vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

describe('bundleDeclarations', () => {
	let bundleDeclarations: typeof BundleDeclarationsFn;

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		// Dynamic import to avoid module resolution issues with mocked fs
		const module = await import('../src/dts');
		bundleDeclarations = module.bundleDeclarations;
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	it('should rename conflicting identifiers from bundled node_modules', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'src/index.d.ts'), 'import { User } from "./types";\nimport { User as LibUser } from "lib";\nexport { User, LibUser };'],
				[join(cwd, 'src/types.d.ts'), 'export interface User { name: string; }'],
				[join(cwd, 'node_modules/lib/index.d.ts'), 'export interface User { id: number; }']
			]),
			entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			resolve: true,
			external: [] as (string | RegExp)[],
			noExternal: ['lib'] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));

		expect(dtsContent).toContain('interface User');
		expect(dtsContent).toContain('User$1');
		expect(dtsContent).toContain('name: string');
		expect(dtsContent).toContain('id: number');
	});

	it('should handle multiple conflicts across modules', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'src/index.d.ts'), 'import { Status } from "./types";\nimport { Status as Status1 } from "lib1";\nimport { Status as Status2 } from "lib2";\nexport { Status, Status1, Status2 };'],
				[join(cwd, 'src/types.d.ts'), 'export type Status = "ok";'],
				[join(cwd, 'node_modules/lib1/index.d.ts'), 'export type Status = "pending";'],
				[join(cwd, 'node_modules/lib2/index.d.ts'), 'export type Status = "error";']
			]),
			entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			resolve: true,
			external: [] as (string | RegExp)[],
			noExternal: ['lib1', 'lib2'] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));

		expect(dtsContent).toContain('type Status');
		expect(dtsContent).toContain('Status$1');
		expect(dtsContent).toContain('Status$2');
	});

	it('should not rename when there are no conflicts', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'src/index.d.ts'), 'import { User } from "./types";\nimport { Config } from "./utils";\nexport { User, Config };'],
				[join(cwd, 'src/types.d.ts'), 'export interface User { name: string; }'],
				[join(cwd, 'src/utils.d.ts'), 'export interface Config { apiUrl: string; }']
			]),
			entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));

		expect(dtsContent).toContain('interface User');
		expect(dtsContent).toContain('interface Config');
		expect(dtsContent).not.toContain('User$1');
		expect(dtsContent).not.toContain('Config$1');
	});

	it('should handle complex type references', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'src/index.d.ts'), `import { UI, Theme } from './namespaces';
declare const widget: UI.Widget;
type ThemeType = typeof Theme;
declare class MyButton implements UI.Widget {
    render(): void;
}
export { widget, ThemeType, MyButton };`],
				[join(cwd, 'src/namespaces.d.ts'), `export declare namespace UI {
    interface Widget { render(): void; }
    class Button implements Widget { render(): void; }
}
export declare const Theme: { color: string; };`]
			]),
			entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));

		expect(dtsContent).toContain('namespace UI');
		expect(dtsContent).toContain('interface Widget');
		expect(dtsContent).toContain('class Button');
		expect(dtsContent).toContain('widget: UI.Widget');
		expect(dtsContent).toContain('implements UI.Widget');
	});

	it('should throw BundleError when entry point is missing', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/missing.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'src/index.d.ts'), ''],
				[join(cwd, 'src/other.d.ts'), ''],
				[join(cwd, 'src/missing.d.ts.bak'), '']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await expect(bundleDeclarations(options)).rejects.toThrow(/Entry point declaration file not found/);
	});

	it('should preserve triple-slash references', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, '/// <reference path="./other.d.ts" />\n/// <reference types="node" />\nexport declare const a: number;'],
				[join(cwd, 'src/other.d.ts'), 'declare const other: string;']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));

		expect(dtsContent).toContain('/// <reference types="node" />');
		expect(dtsContent).toMatch(/\/\/\/ <reference path=".*other\.d\.ts" \/>/);
	});

	it('should preserve side-effect imports for non-code files', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, "import './styles.css';\nexport declare const foo: string;"]
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain("import './styles.css';");
	});

	it('should preserve external side-effect imports', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, "import 'some-side-effect-module';\nexport declare const foo: string;"]
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain("import 'some-side-effect-module';");
	});

	it('should handle explicit rootDir in sourceToDeclarationPath', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const rootDir = join(cwd, 'src') as AbsolutePath;
		const outEntryPoint = join(outDir, 'index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[outEntryPoint, 'export declare const a: number;']
			]),
			entryPoints: { index: join(cwd, 'src/index.ts') as AbsolutePath },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir, rootDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain('export { a };');
	});

	it('should handle regex patterns in external option', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, 'import { useState } from "react";\nexport declare const a: typeof useState;']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [/^react/] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain('import { useState } from "react";');
	});

	it('should handle paths configuration in resolveModule', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;
		const fs = await import('node:fs');

		fs.mkdirSync(join(cwd, 'src'), { recursive: true });
		fs.writeFileSync(join(cwd, 'src/foo.ts'), 'export const foo = 1;');

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, 'import { foo } from "@alias/foo";\nexport { foo };'],
				[join(cwd, 'src/foo.d.ts'), 'export declare const foo: number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: true,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: {
				outDir,
				paths: { '@alias/*': ['./src/*'] }
			}
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain('export { foo };');
	});

	it('should strip empty named exports', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, 'export {};\nexport declare const a: number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).not.toContain('export {};');
		expect(dtsContent).toContain('export { a };');
	});

	it('should strip default exports', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, 'declare const _default: number;\nexport default _default;\nexport declare const a: number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).not.toContain('export default');
		expect(dtsContent).toContain('export { a };');
	});

	it('should handle re-exports of imported symbols', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, 'import { foo } from "./foo";\nexport { foo };'],
				[join(cwd, 'src/foo.d.ts'), 'export declare const foo: number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain('export { foo };');
	});

	it('should return source path when no declaration match found', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'other.d.ts'), 'export declare const a: number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		await expect(bundleDeclarations(options)).rejects.toThrow(/Entry point declaration file not found/);
	});

	it('should handle resolveModule host.readFile returning undefined', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, 'import { foo } from "./missing";\nexport declare const bar: number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: true,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		const ts = await import('typescript');
		const originalFileExists = ts.sys.fileExists;
		const originalReadFile = ts.sys.readFile;

		ts.sys.fileExists = (path) => {
			if (path.includes('missing')) return true;
			return originalFileExists(path);
		};

		ts.sys.readFile = (path, encoding) => {
			if (path.includes('missing')) return undefined;
			return originalReadFile(path, encoding);
		};

		try {
			await bundleDeclarations(options);
		} finally {
			ts.sys.fileExists = originalFileExists;
			ts.sys.readFile = originalReadFile;
		}

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain('import { foo } from "./missing";');
	});

	it('should handle resolveModule host.getDirectories', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, 'import { foo } from "pkg";\nexport declare const bar: number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: true,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: {
				outDir,
				moduleResolution: 99
			}
		};

		await bundleDeclarations(options);

		const dtsContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		expect(dtsContent).toContain('import { foo } from "pkg";');
	});

	it('should bundle types from path-mapped directories', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;
		const entryPoint = join(cwd, 'src/index.d.ts') as AbsolutePath;
		const fs = await import('node:fs');

		fs.mkdirSync(join(cwd, 'src/@types'), { recursive: true });
		fs.writeFileSync(join(cwd, 'src/@types/index.ts'), 'export type CustomType = string;');

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[entryPoint, "import type { CustomType } from './@types';\nexport declare const value: CustomType;\nexport type { CustomType };"],
				[join(cwd, 'src/@types/index.d.ts'), 'export type CustomType = string | number;']
			]),
			entryPoints: { index: entryPoint },
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: {
				outDir,
				paths: { '@types': ['./src/@types'] }
			}
		};

		await bundleDeclarations(options);

		const dts = TestHelper.readFile(join(outDir, 'index.d.ts'));

		expect(dts).not.toContain("from './@types'");
		expect(dts).not.toContain('import type');
		expect(dts).toContain('type CustomType');
		expect(dts).toContain('string | number');
	});

	it('should bundle multiple entry points in parallel', async () => {
		const cwd = process.cwd() as AbsolutePath;
		const outDir = join(cwd, 'dist') as AbsolutePath;

		const options = {
			currentDirectory: cwd,
			declarationFiles: TestHelper.createDeclarationFilesMap([
				[join(cwd, 'src/index.d.ts'), 'export declare const a: number;'],
				[join(cwd, 'src/utils.d.ts'), 'export declare const b: string;']
			]),
			entryPoints: {
				index: join(cwd, 'src/index.d.ts') as AbsolutePath,
				utils: join(cwd, 'src/utils.d.ts') as AbsolutePath
			},
			resolve: false,
			external: [] as (string | RegExp)[],
			noExternal: [] as (string | RegExp)[],
			compilerOptions: { outDir }
		};

		const result = await bundleDeclarations(options);

		expect(result).toHaveLength(2);
		expect(result.map(r => r.path)).toContain('dist/index.d.ts');
		expect(result.map(r => r.path)).toContain('dist/utils.d.ts');

		const indexContent = TestHelper.readFile(join(outDir, 'index.d.ts'));
		const utilsContent = TestHelper.readFile(join(outDir, 'utils.d.ts'));

		expect(indexContent).toContain('export { a };');
		expect(utilsContent).toContain('export { b };');
	});
});
