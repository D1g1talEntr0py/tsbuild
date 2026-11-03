import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModuleKind, ModuleResolutionKind } from 'typescript/sync';
import type { AbsolutePath } from 'src/@types';
import { discoverLocalDependencies } from 'src/plugins/plugin-dependencies';
import { TestHelper } from '../scripts/test-helper';

describe('discoverLocalDependencies', () => {
	const compilerOptions = { module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler };
	let directory: string;

	beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'tsbuild-plugin-dependencies-')) });
	afterEach(async () => { await rm(directory, { recursive: true, force: true }) });

	const write = async (file: string, content: string) => {
		const path = join(directory, file);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, content);
		return path as AbsolutePath;
	};

	it('follows local imports and re-exports, excluding node_modules and unresolved specifiers', async () => {
		await write('node_modules/package/package.json', JSON.stringify({ name: 'package', types: './index.d.ts' }));
		await write('node_modules/package/index.d.ts', 'export declare const value: number;\n');
		const entryFile = await write('plugin.ts', "import 'package';\nimport { a } from './a';\nexport * from './b';\nimport 'missing';\nexport const plugin = a;\n");
		const a = await write('a.ts', "import { b } from './b';\nexport const a = b;\n");
		const b = await write('b.ts', "export { a } from './a';\nexport const b = 1;\n");

		expect(discoverLocalDependencies(TestHelper.api, entryFile, compilerOptions)).toEqual(new Set([ entryFile, a, b ]));
	});

	it('tracks non-script dependencies without parsing them and skips unreadable entries', async () => {
		const entryFile = await write('plugin.ts', "import data from './data.json';\nexport default data;\n");
		const data = await write('data.json', '{ "value": 1 }');

		expect(discoverLocalDependencies(TestHelper.api, entryFile, { ...compilerOptions, resolveJsonModule: true })).toEqual(new Set([ entryFile, data ]));
		expect(discoverLocalDependencies(TestHelper.api, join(directory, 'missing.ts') as AbsolutePath, compilerOptions)).toEqual(new Set());
	});
});
