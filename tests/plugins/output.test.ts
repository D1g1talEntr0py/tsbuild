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
import { outputPlugin } from 'src/plugins/output';
import type { BuildResult, Metafile, PluginBuild } from 'esbuild';
import { join } from 'node:path';

const outputDir = '/test-output';

function metafileWith(outputs: Record<string, Partial<Metafile['outputs'][string]>>): { metafile: Metafile } {
	const full: Metafile['outputs'] = {};
	for (const [path, meta] of Object.entries(outputs)) {
		full[path] = { bytes: 0, inputs: {}, imports: [], exports: [], ...meta };
	}
	return { metafile: { inputs: {}, outputs: full } };
}

describe('outputPlugin', () => {
	let onEndCallback: (result: BuildResult) => Promise<void>;

	beforeEach(() => {
		vol.reset();
		vol.mkdirSync(outputDir, { recursive: true });

		const build: Partial<PluginBuild> = {
			onEnd: vi.fn((callback) => { onEndCallback = callback }),
		};
		outputPlugin().setup(build as PluginBuild);
	});

	afterEach(() => { vol.reset() });

	it('has the correct name', () => {
		expect(outputPlugin().name).toBe('esbuild:output-plugin');
	});

	it('registers an onEnd callback', () => {
		const build: Partial<PluginBuild> = { onEnd: vi.fn() };
		outputPlugin().setup(build as PluginBuild);
		expect(build.onEnd).toHaveBeenCalledWith(expect.any(Function));
	});

	describe('shebang permissions', () => {
		it('sets executable permissions for JS entry points with shebang', async () => {
			const filePath = join(outputDir, 'cli.js');
			await memfs.promises.writeFile(filePath, '#!/usr/bin/env node\nconsole.log("hi");');
			await onEndCallback(metafileWith({ [filePath]: { entryPoint: 'src/cli.ts' } }) as BuildResult);

			const stats = await memfs.promises.stat(filePath);
			expect(Number(stats.mode) & 0o777).toBe(0o755);
		});

		it('does not change permissions for JS entry points without shebang', async () => {
			const filePath = join(outputDir, 'lib.js');
			await memfs.promises.writeFile(filePath, 'console.log("hello");');
			const beforeMode = Number((await memfs.promises.stat(filePath)).mode) & 0o777;
			await onEndCallback(metafileWith({ [filePath]: { entryPoint: 'src/lib.ts' } }) as BuildResult);

			const stats = await memfs.promises.stat(filePath);
			expect(Number(stats.mode) & 0o777).toBe(beforeMode);
		});

		it('skips chunk files (no entryPoint)', async () => {
			const filePath = join(outputDir, 'ABC123.js');
			await memfs.promises.writeFile(filePath, '#!/usr/bin/env node\nchunk code');
			const beforeMode = Number((await memfs.promises.stat(filePath)).mode) & 0o777;
			await onEndCallback(metafileWith({ [filePath]: {} }) as BuildResult);

			expect(Number((await memfs.promises.stat(filePath)).mode) & 0o777).toBe(beforeMode);
		});

		it('skips non-JS files', async () => {
			const filePath = join(outputDir, 'styles.css');
			await memfs.promises.writeFile(filePath, '#!/usr/bin/env node');
			const beforeMode = Number((await memfs.promises.stat(filePath)).mode) & 0o777;
			await onEndCallback(metafileWith({ [filePath]: { entryPoint: 'src/styles.css' } }) as BuildResult);

			expect(Number((await memfs.promises.stat(filePath)).mode) & 0o777).toBe(beforeMode);
		});

		it('handles multiple output files', async () => {
			const cli = join(outputDir, 'cli.js');
			const lib = join(outputDir, 'lib.js');
			const chunk = join(outputDir, 'ABC123.js');
			const css = join(outputDir, 'app.css');

			await memfs.promises.writeFile(cli, '#!/usr/bin/env node\n');
			await memfs.promises.writeFile(lib, 'const a = 1;');
			await memfs.promises.writeFile(chunk, 'chunk code');
			await memfs.promises.writeFile(css, 'p { color: blue }');

			const libMode = Number((await memfs.promises.stat(lib)).mode) & 0o777;
			const chunkMode = Number((await memfs.promises.stat(chunk)).mode) & 0o777;
			const cssMode = Number((await memfs.promises.stat(css)).mode) & 0o777;

			await onEndCallback(metafileWith({
				[cli]: { entryPoint: 'src/cli.ts' },
				[lib]: { entryPoint: 'src/lib.ts' },
				[chunk]: {},
				[css]: {},
			}) as BuildResult);

			expect(Number((await memfs.promises.stat(cli)).mode) & 0o777).toBe(0o755);
			expect(Number((await memfs.promises.stat(lib)).mode) & 0o777).toBe(libMode);
			expect(Number((await memfs.promises.stat(chunk)).mode) & 0o777).toBe(chunkMode);
			expect(Number((await memfs.promises.stat(css)).mode) & 0o777).toBe(cssMode);
		});

		it('handles empty metafile', async () => {
			await onEndCallback(metafileWith({}) as BuildResult);
		});

		it('handles missing metafile', async () => {
			await onEndCallback({} as BuildResult);
		});
	});
});
