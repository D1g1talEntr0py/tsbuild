import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { join } from 'node:path';
import { TestHelper } from './scripts/test-helper';
import { Logger } from 'src/logger';
import type { AbsolutePath } from 'src/@types';
import type { bundleDeclarations as BundleDeclarationsFn } from 'src/dts';
import type { DtsBundleOptions } from 'src/dts/@types';

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
	const cwd = process.cwd() as AbsolutePath;
	const outDir = join(cwd, 'dist') as AbsolutePath;

	const makeOptions = (overrides: Record<string, unknown> = {}) => ({
		currentDirectory: cwd,
		resolve: false,
		external: [] as (string | RegExp)[],
		noExternal: [] as (string | RegExp)[],
		compilerOptions: { outDir },
		...overrides,
	}) as unknown as DtsBundleOptions;

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		({ bundleDeclarations } = await import('src/dts'));
	});

	afterEach(() => { TestHelper.teardownMemfs() });

	describe('basic bundling', () => {
		it('bundles a single entry point', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'export declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(1);

			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { a };');
		});

		it('bundles multiple entry points in parallel', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'export declare const a: number;'],
					[join(cwd, 'src/utils.d.ts'), 'export declare const b: string;'],
				]),
				entryPoints: {
					index: join(cwd, 'src/index.d.ts') as AbsolutePath,
					utils: join(cwd, 'src/utils.d.ts') as AbsolutePath,
				},
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(2);
			expect(result.map(r => r.path)).toContain('dist/index.d.ts');
			expect(result.map(r => r.path)).toContain('dist/utils.d.ts');
		});

		it('resolves cross-file imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { foo } from "./foo";\nexport { foo };'],
					[join(cwd, 'src/foo.d.ts'), 'export declare const foo: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { foo };');
		});
	});

	describe('identifier conflict renaming', () => {
		it('renames conflicting identifiers from different modules', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { User } from "./types";\nimport { User as LibUser } from "lib";\nexport { User, LibUser };'],
					[join(cwd, 'src/types.d.ts'), 'export interface User { name: string; }'],
					[join(cwd, 'node_modules/lib/index.d.ts'), 'export interface User { id: number; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
				noExternal: ['lib'] as (string | RegExp)[],
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('interface User');
			expect(content).toContain('User$1');
		});

		it('does not rename when no conflicts', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { User } from "./types";\nimport { Config } from "./utils";\nexport { User, Config };'],
					[join(cwd, 'src/types.d.ts'), 'export interface User { name: string; }'],
					[join(cwd, 'src/utils.d.ts'), 'export interface Config { apiUrl: string; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toContain('User$1');
			expect(content).not.toContain('Config$1');
		});

		it('avoids rename collisions with existing declarations', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { Foo } from "./a";\nimport { Foo as FooB } from "./b";\nimport { Foo$1 } from "./c";\nexport { Foo, FooB, Foo$1 };'],
					[join(cwd, 'src/a.d.ts'), 'export interface Foo { a: string; }'],
					[join(cwd, 'src/b.d.ts'), 'export interface Foo { b: number; }'],
					[join(cwd, 'src/c.d.ts'), 'export interface Foo$1 { c: boolean; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('interface Foo$2');
			expect(content).toContain('interface Foo {');
			expect(content).toContain('interface Foo$1');
		});

		it('preserves whitespace when renaming (regression: node.pos → node.getStart())', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { Options as A } from "./a";\nimport { Options as B } from "./b";\nexport { A, B };'],
					[join(cwd, 'src/a.d.ts'), 'export type Options = { value: string; };'],
					[join(cwd, 'src/b.d.ts'), 'export type Options = { count: number; };'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('type Options$1');
			expect(content).not.toContain('typeOptions$1');
		});

		it('does not reinsert renamed identifiers in removed export clauses (regression)', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { PublishOptions } from "./events";\nimport { Json } from "./json";\nexport { PublishOptions, Json };'],
					[join(cwd, 'src/events.d.ts'), 'import { Json } from "./json";\ndeclare type Json = string | number;\ndeclare type PublishOptions = { name: string; data?: Json; };\nexport { PublishOptions, Json };'],
					[join(cwd, 'src/json.d.ts'), 'declare type Json = string | number | boolean | null | object;\nexport { Json };'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toMatch(/\}Json/);
			expect(content).toContain('type Json$1');
		});
	});

	describe('external modules', () => {
		it('preserves external imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { useState } from "react";\nexport declare const a: typeof useState;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				external: [/^react/] as (string | RegExp)[],
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('import { useState } from "react";');
		});

		it('preserves side-effect imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), "import './styles.css';\nexport declare const foo: string;"],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain("import './styles.css';");
		});

		it('preserves external side-effect imports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), "import 'some-side-effect-module';\nexport declare const foo: string;"],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain("import 'some-side-effect-module';");
		});
	});

	describe('references', () => {
		it('preserves triple-slash references', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), '/// <reference path="./other.d.ts" />\n/// <reference types="node" />\nexport declare const a: number;'],
					[join(cwd, 'src/other.d.ts'), 'declare const other: string;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('/// <reference types="node" />');
			expect(content).toMatch(/\/\/\/ <reference path=".*other\.d\.ts" \/>/);
		});
	});

	describe('complex type references', () => {
		it('handles namespaces and implements clauses', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), `import { UI, Theme } from './namespaces';
declare const widget: UI.Widget;
type ThemeType = typeof Theme;
declare class MyButton implements UI.Widget { render(): void; }
export { widget, ThemeType, MyButton };`],
					[join(cwd, 'src/namespaces.d.ts'), `export declare namespace UI {
    interface Widget { render(): void; }
    class Button implements Widget { render(): void; }
}
export declare const Theme: { color: string; };`],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('namespace UI');
			expect(content).toContain('interface Widget');
			expect(content).toContain('implements UI.Widget');
		});
	});

	describe('entry point resolution', () => {
		it('throws BundleError when entry point is missing', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), ''],
				]),
				entryPoints: { index: join(cwd, 'src/missing.d.ts') as AbsolutePath },
			});

			await expect(bundleDeclarations(options)).rejects.toThrow(/Entry point declaration file not found/);
		});

		it('handles explicit rootDir in sourceToDeclarationPath', async () => {
			const rootDir = join(cwd, 'src') as AbsolutePath;
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(outDir, 'index.d.ts'), 'export declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.ts') as AbsolutePath },
				compilerOptions: { outDir, rootDir },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('export { a };');
		});

		it('prefers shortest relative path for stale cache scenario', async () => {
			const stale = join(outDir, 'src/index.d.ts') as AbsolutePath;
			const correct = join(outDir, 'index.d.ts') as AbsolutePath;

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[stale, 'export declare const version: "stale";'],
					[correct, 'export declare const version: "correct";'],
				]),
				entryPoints: { index: join(cwd, 'src/index.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('"correct"');
			expect(content).not.toContain('"stale"');
		});
	});

	describe('export handling', () => {
		it('strips empty named exports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'export {};\nexport declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toContain('export {};');
			expect(content).toContain('export { a };');
		});

		it('strips default exports', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'declare const _default: number;\nexport default _default;\nexport declare const a: number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toContain('export default');
			expect(content).toContain('export { a };');
		});
	});

	describe('circular dependencies', () => {
		it('emits a warning and still produces output', async () => {
			const warnSpy = vi.spyOn(Logger, 'warn');

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { a } from "./a";\nexport { a };'],
					[join(cwd, 'src/a.d.ts'), 'import { b } from "./b";\nexport declare const a: number;'],
					[join(cwd, 'src/b.d.ts'), 'import { a } from "./a";\nexport declare const b: string;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
			});

			await bundleDeclarations(options);

			expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Circular dependency detected/));
			warnSpy.mockRestore();

			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('declare const a: number');
		});
	});

	describe('namespace alias flattening', () => {
		it('flattens bundled namespace alias qualified names from inline import() types', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'type BeforeErrorHook = (error: import("./http-error").HttpError) => import("./http-error").HttpError | void;\nexport type { BeforeErrorHook };'],
					[join(cwd, 'src/http-error.d.ts'), 'export declare class HttpError extends Error { status: number; }'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toMatch(/___http_error\./);
			expect(content).toContain('HttpError');
			expect(content).toContain('BeforeErrorHook');
			expect(content).not.toMatch(/import \* as ___http_error/);
		});
	});

	describe('path-mapped directories', () => {
		it('bundles types from path-mapped directories', async () => {
			const fs = await import('node:fs');
			fs.mkdirSync(join(cwd, 'src/@types'), { recursive: true });
			fs.writeFileSync(join(cwd, 'src/@types/index.ts'), 'export type CustomType = string;');

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), "import type { CustomType } from './@types';\nexport declare const value: CustomType;\nexport type { CustomType };"],
					[join(cwd, 'src/@types/index.d.ts'), 'export type CustomType = string | number;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				compilerOptions: { outDir, paths: { '@types': ['./src/@types'] } },
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).not.toContain("from './@types'");
			expect(content).toContain('type CustomType');
		});
	});

	describe('external node_modules resolution', () => {
		it('stores externally resolved files separately and cleans up', async () => {
			const fs = await import('node:fs');
			const libDir = join(cwd, 'node_modules/ext-lib');
			fs.mkdirSync(libDir, { recursive: true });
			fs.writeFileSync(join(libDir, 'index.d.ts'), 'export declare const extFn: () => void;');

			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { extFn } from "ext-lib";\nexport declare const wrapper: typeof extFn;'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
			});

			const result = await bundleDeclarations(options);
			expect(result).toHaveLength(1);

			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('import { extFn } from "ext-lib"');
		});
	});

	describe('multiple conflicts across modules', () => {
		it('handles three modules with same identifier', async () => {
			const options = makeOptions({
				declarationFiles: TestHelper.createDeclarationFilesMap([
					[join(cwd, 'src/index.d.ts'), 'import { Status } from "./types";\nimport { Status as S1 } from "lib1";\nimport { Status as S2 } from "lib2";\nexport { Status, S1, S2 };'],
					[join(cwd, 'src/types.d.ts'), 'export type Status = "ok";'],
					[join(cwd, 'node_modules/lib1/index.d.ts'), 'export type Status = "pending";'],
					[join(cwd, 'node_modules/lib2/index.d.ts'), 'export type Status = "error";'],
				]),
				entryPoints: { index: join(cwd, 'src/index.d.ts') as AbsolutePath },
				resolve: true,
				noExternal: ['lib1', 'lib2'] as (string | RegExp)[],
			});

			await bundleDeclarations(options);
			const content = TestHelper.readFile(join(outDir, 'index.d.ts'));
			expect(content).toContain('type Status');
			expect(content).toContain('Status$1');
			expect(content).toContain('Status$2');
		});
	});
});
