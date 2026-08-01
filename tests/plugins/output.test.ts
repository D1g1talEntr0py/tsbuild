import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', async () => {
	const memfs = await import('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs = await import('memfs');
	return memfs.fs.promises;
});

import { vol, fs as memfs } from 'memfs';
import { join } from 'node:path';
import { createWriteOutputPlugin } from 'src/plugins/output';
import type { BuildResult, Metafile, OutputFile, PluginBuild } from 'esbuild';

const outputDir = '/test-output';

function buildResultWith(outputFiles: OutputFile[], outputs: Record<string, Partial<Metafile['outputs'][string]>>): BuildResult {
	const full: Metafile['outputs'] = {};
	for (const [path, meta] of Object.entries(outputs)) {
		full[path] = { bytes: 0, inputs: {}, imports: [], exports: [], ...meta };
	}

	return {
		errors: [],
		warnings: [],
		outputFiles,
		metafile: { inputs: {}, outputs: full },
	} as BuildResult;
}

function outputFile(path: string, text: string): OutputFile {
	return { path, contents: Buffer.from(text), text };
}

describe('outputPlugin', () => {
	let onEndCallback: (result: BuildResult) => Promise<void>;
	let onWritten: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vol.reset();
		vol.mkdirSync(outputDir, { recursive: true });
		onWritten = vi.fn();

		const build: Partial<PluginBuild> = {
			onEnd: vi.fn((callback) => { onEndCallback = callback }),
		};
		createWriteOutputPlugin(outputDir, onWritten).setup(build as PluginBuild);
	});

	afterEach(() => { vol.reset() });

	it('has the correct name', () => {
		expect(createWriteOutputPlugin(outputDir, onWritten).name).toBe('tsbuild:write-output');
	});

	it('registers an onEnd callback', () => {
		const build: Partial<PluginBuild> = { onEnd: vi.fn() };
		createWriteOutputPlugin(outputDir, onWritten).setup(build as PluginBuild);
		expect(build.onEnd).toHaveBeenCalledWith(expect.any(Function));
	});

	describe('shebang permissions', () => {
		it('sets executable permissions for JS entry points with shebang', async () => {
			const filePath = join(outputDir, 'cli.js');
			await onEndCallback(buildResultWith(
				[outputFile(filePath, '#!/usr/bin/env node\nconsole.log("hi");')],
				{ [filePath]: { entryPoint: 'src/cli.ts' } },
			));

			const stats = await memfs.promises.stat(filePath);
			expect(Number(stats.mode) & 0o777).toBe(0o755);
			expect(onWritten).toHaveBeenCalledWith([
				{ path: 'cli.js', size: Buffer.byteLength('#!/usr/bin/env node\nconsole.log("hi");') },
			]);
		});

		it('does not change permissions for JS entry points without shebang', async () => {
			const filePath = join(outputDir, 'lib.js');
			await onEndCallback(buildResultWith(
				[outputFile(filePath, 'console.log("hello");')],
				{ [filePath]: { entryPoint: 'src/lib.ts' } },
			));

			const stats = await memfs.promises.stat(filePath);
			expect(Number(stats.mode) & 0o777).toBe(0o666);
		});

		it('skips chunk files (no entryPoint)', async () => {
			const filePath = join(outputDir, 'ABC123.js');
			await memfs.promises.writeFile(filePath, '#!/usr/bin/env node\nchunk code');
			const beforeMode = Number((await memfs.promises.stat(filePath)).mode) & 0o777;

			await onEndCallback(buildResultWith(
				[outputFile(filePath, '#!/usr/bin/env node\nchunk code')],
				{ [filePath]: {} },
			));

			expect(Number((await memfs.promises.stat(filePath)).mode) & 0o777).toBe(beforeMode);
		});

		it('skips non-JS files', async () => {
			const filePath = join(outputDir, 'styles.css');
			await memfs.promises.writeFile(filePath, '#!/usr/bin/env node');
			const beforeMode = Number((await memfs.promises.stat(filePath)).mode) & 0o777;

			await onEndCallback(buildResultWith(
				[outputFile(filePath, '#!/usr/bin/env node')],
				{ [filePath]: { entryPoint: 'src/styles.css' } },
			));

			expect(Number((await memfs.promises.stat(filePath)).mode) & 0o777).toBe(beforeMode);
		});

		it('handles multiple output files', async () => {
			const cli = join(outputDir, 'cli.js');
			const lib = join(outputDir, 'lib.js');
			const chunk = join(outputDir, 'ABC123.js');
			const css = join(outputDir, 'app.css');

			await memfs.promises.writeFile(lib, 'const a = 1;');
			await memfs.promises.writeFile(chunk, 'chunk code');
			await memfs.promises.writeFile(css, 'p { color: blue }');

			const cliModeBefore = 0o666;
			const libMode = Number((await memfs.promises.stat(lib)).mode) & 0o777;
			const chunkMode = Number((await memfs.promises.stat(chunk)).mode) & 0o777;
			const cssMode = Number((await memfs.promises.stat(css)).mode) & 0o777;

			await onEndCallback(buildResultWith(
				[
					outputFile(cli, '#!/usr/bin/env node\n'),
					outputFile(lib, 'const a = 1;'),
					outputFile(chunk, 'chunk code'),
					outputFile(css, 'p { color: blue }'),
				],
				{
					[cli]: { entryPoint: 'src/cli.ts' },
					[lib]: { entryPoint: 'src/lib.ts' },
					[chunk]: {},
					[css]: {},
				},
			));

			expect(cliModeBefore).toBe(0o666);
			expect(Number((await memfs.promises.stat(cli)).mode) & 0o777).toBe(0o755);
			expect(Number((await memfs.promises.stat(lib)).mode) & 0o777).toBe(libMode);
			expect(Number((await memfs.promises.stat(chunk)).mode) & 0o777).toBe(chunkMode);
			expect(Number((await memfs.promises.stat(css)).mode) & 0o777).toBe(cssMode);
		});

		it('handles empty metafile', async () => {
			await onEndCallback({ errors: [], warnings: [] } as BuildResult);
			expect(onWritten).not.toHaveBeenCalled();
		});

		it('handles missing metafile', async () => {
			await onEndCallback({ errors: [], warnings: [] } as BuildResult);
			expect(onWritten).not.toHaveBeenCalled();
		});
	});

	describe('specifier rewriting', () => {
		it('adds .js to extension-less relative from/side-effect/dynamic imports', async () => {
			const filePath = join(outputDir, 'index.js');
			await onEndCallback(buildResultWith(
				[outputFile(filePath,
					'import { a } from "./dep";\n' +
					'export { b } from "../pkg/item";\n' +
					'import "./setup";\n' +
					'const m = await import("./lazy/module");\n'
				)],
				{ [filePath]: { entryPoint: 'src/index.ts', imports: [
					{ path: './dep' },
					{ path: '../pkg/item' },
					{ path: './setup' },
					{ path: './lazy/module' },
				] } },
			));

			const rewritten = await memfs.promises.readFile(filePath, 'utf8');
			expect(rewritten).toContain('from "./dep.js"');
			expect(rewritten).toContain('from "../pkg/item.js"');
			expect(rewritten).toContain('import "./setup.js"');
			expect(rewritten).toContain('import("./lazy/module.js")');
		});

		it('does not rewrite bare specifiers or already-extended relative specifiers', async () => {
			const filePath = join(outputDir, 'index.js');
			await onEndCallback(buildResultWith(
				[outputFile(filePath,
					'import { a } from "pkg";\n' +
					'import { b } from "./dep.js";\n' +
					'import { c } from "./style.css";\n' +
					'const d = await import("./chunk.mjs");\n'
				)],
				{ [filePath]: { entryPoint: 'src/index.ts', imports: [
					{ path: 'pkg' },
					{ path: './dep.js' },
					{ path: './style.css' },
					{ path: './chunk.mjs' },
				] } },
			));

			const rewritten = await memfs.promises.readFile(filePath, 'utf8');
			expect(rewritten).toContain('from "pkg"');
			expect(rewritten).toContain('from "./dep.js"');
			expect(rewritten).toContain('from "./style.css"');
			expect(rewritten).toContain('import("./chunk.mjs")');
		});

		it('rewrites chunk outputs too', async () => {
			const chunkPath = join(outputDir, 'ABC123.js');
			await onEndCallback(buildResultWith(
				[outputFile(chunkPath, 'import { x } from "./shared";\n')],
				{ [chunkPath]: { imports: [{ path: './shared' }] } },
			));

			const rewritten = await memfs.promises.readFile(chunkPath, 'utf8');
			expect(rewritten).toContain('from "./shared.js"');
		});
	});
});
