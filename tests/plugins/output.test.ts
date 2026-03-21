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
import { outputPlugin, rewriteRelativeSpecifiers } from 'src/plugins/output';
import type { BuildResult, PluginBuild } from 'esbuild';
import { join } from 'node:path';

const outputDir = '/test-output';
const encoder = new TextEncoder();

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

	describe('file writing', () => {
		it('sets executable permissions for JS files with shebang', async () => {
			const contents = encoder.encode('#!/usr/bin/env node\nconsole.log("hi");');
			const filePath = join(outputDir, 'cli.js');
			await onEndCallback({ outputFiles: [{ path: filePath, contents }] } as BuildResult);

			const stats = await memfs.promises.stat(filePath);
			expect(Number(stats.mode) & 0o777).toBe(0o755);
		});

		it('sets regular permissions for JS files without shebang', async () => {
			const contents = encoder.encode('console.log("hello");');
			const filePath = join(outputDir, 'lib.js');
			await onEndCallback({ outputFiles: [{ path: filePath, contents }] } as BuildResult);

			const stats = await memfs.promises.stat(filePath);
			expect(Number(stats.mode) & 0o777).toBe(0o666);
		});

		it('writes non-JS files with regular permissions', async () => {
			const contents = encoder.encode('body { color: red }');
			const filePath = join(outputDir, 'styles.css');
			await onEndCallback({ outputFiles: [{ path: filePath, contents }] } as BuildResult);

			const content = await memfs.promises.readFile(filePath);
			expect(content).toEqual(Buffer.from(contents));
			const stats = await memfs.promises.stat(filePath);
			expect(Number(stats.mode) & 0o777).toBe(0o666);
		});

		it('handles multiple output files', async () => {
			const files = [
				{ path: join(outputDir, 'cli.js'), contents: encoder.encode('#!/usr/bin/env node\n') },
				{ path: join(outputDir, 'lib.js'), contents: encoder.encode('const a = 1;') },
				{ path: join(outputDir, 'app.css'), contents: encoder.encode('p { color: blue }') },
			];
			await onEndCallback({ outputFiles: files } as BuildResult);

			expect(Number((await memfs.promises.stat(files[0].path)).mode) & 0o777).toBe(0o755);
			expect(Number((await memfs.promises.stat(files[1].path)).mode) & 0o777).toBe(0o666);
			expect(Number((await memfs.promises.stat(files[2].path)).mode) & 0o777).toBe(0o666);
		});
	});

	describe('relative specifier rewriting in JS output', () => {
		it('appends .js to extension-less relative imports in JS files', async () => {
			const code = 'import { foo } from \'./utils\';\n';
			const contents = encoder.encode(code);
			const filePath = join(outputDir, 'index.js');
			await onEndCallback({ outputFiles: [{ path: filePath, contents }] } as BuildResult);

			const written = await memfs.promises.readFile(filePath, 'utf8');
			expect(written).toContain("from './utils.js'");
		});

		it('does not rewrite relative imports that already have extensions', async () => {
			const code = 'import { foo } from \'./utils.js\';\n';
			const contents = encoder.encode(code);
			const filePath = join(outputDir, 'index.js');
			await onEndCallback({ outputFiles: [{ path: filePath, contents }] } as BuildResult);

			const written = await memfs.promises.readFile(filePath, 'utf8');
			expect(written).toContain("from './utils.js'");
		});

		it('does not rewrite bare specifiers', async () => {
			const code = 'import { something } from \'lodash\';\n';
			const contents = encoder.encode(code);
			const filePath = join(outputDir, 'index.js');
			await onEndCallback({ outputFiles: [{ path: filePath, contents }] } as BuildResult);

			const written = await memfs.promises.readFile(filePath, 'utf8');
			expect(written).toContain("from 'lodash'");
		});
	});
});

describe('rewriteRelativeSpecifiers', () => {
	const matrix: [string, string, string][] = [
		['extension-less relative', "from './utils'", "from './utils.js'"],
		['extension-less parent', "from '../shared'", "from '../shared.js'"],
		['deep extension-less', "from './deep/nested/mod'", "from './deep/nested/mod.js'"],
		['already has .js', "from './utils.js'", "from './utils.js'"],
		['already has .ts', "from './utils.ts'", "from './utils.ts'"],
		['already has .mjs', "from './utils.mjs'", "from './utils.mjs'"],
		['bare specifier', "from 'lodash'", "from 'lodash'"],
		['scoped bare specifier', "from '@scope/pkg'", "from '@scope/pkg'"],
		['double quotes', 'from "./utils"', 'from "./utils.js"'],
	];

	it.each(matrix)('%s: %s → %s', (_desc, input, expected) => {
		expect(rewriteRelativeSpecifiers(input)).toBe(expected);
	});

	it('rewrites multiple occurrences in same string', () => {
		const code = "import { a } from './a';\nimport { b } from './b';";
		const result = rewriteRelativeSpecifiers(code);
		expect(result).toContain("from './a.js'");
		expect(result).toContain("from './b.js'");
	});
});
