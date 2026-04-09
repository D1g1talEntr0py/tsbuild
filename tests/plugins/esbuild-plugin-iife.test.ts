import { resolve, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BuildOptions, BuildResult, OutputFile, Plugin, PluginBuild, OnResolveArgs, OnLoadArgs } from 'esbuild';

vi.mock('node:fs/promises', async () => {
	const memfs = await import('memfs');
	return memfs.fs.promises;
});

const { mockEsbuild } = vi.hoisted(() => ({
	mockEsbuild: vi.fn<(options: BuildOptions) => Promise<BuildResult<{ write: false }>>>()
}));
vi.mock('esbuild', () => ({ build: mockEsbuild }));

import { vol, fs as memfs } from 'memfs';
import { iifePlugin } from 'src/plugins/iife';
import type { IifePluginInstance } from 'src/plugins/iife';

const outputDir = resolve('test-iife-output');
const iifeOutdir = join(outputDir, 'iife');
const encoder = new TextEncoder();

function makeOutputFile(path: string, code: string): OutputFile {
	const contents = encoder.encode(code);
	return { path, contents, hash: '', text: code };
}

function makeResolveArgs(overrides: Partial<OnResolveArgs> & Pick<OnResolveArgs, 'path' | 'kind'>): OnResolveArgs {
	return { importer: '', namespace: '', resolveDir: '', pluginData: undefined, with: {}, ...overrides };
}

function makeLoadArgs(overrides: Partial<OnLoadArgs> & Pick<OnLoadArgs, 'path'>): OnLoadArgs {
	return { namespace: 'iife', suffix: '', pluginData: undefined, with: {}, ...overrides };
}

/** Creates a mock esbuild.build return value with specified entry outputs */
function makeBuildResult(entries: Record<string, string>): BuildResult<{ write: false }> {
	const outputFiles: OutputFile[] = [];
	for (const [name, code] of Object.entries(entries)) {
		outputFiles.push(makeOutputFile(join(iifeOutdir, `${name}.js`), code));
	}
	return { errors: [], warnings: [], outputFiles, metafile: { inputs: {}, outputs: {} }, mangleCache: {} };
}

describe('iifePlugin', () => {
	let instance: IifePluginInstance;
	let onEndCallback: (result: BuildResult) => Promise<void>;

	beforeEach(() => {
		vol.reset();
		mockEsbuild.mockClear();
		mockEsbuild.mockResolvedValue(makeBuildResult({ index: '(() => {})();' }));
	});

	afterEach(() => { vol.reset() });

	function setupPlugin(
		options?: { globalName?: string },
		sourcemap?: boolean | string,
		entryPoints?: BuildOptions['entryPoints']
	): void {
		instance = iifePlugin(options);
		const build: Partial<PluginBuild> = {
			initialOptions: { outdir: outputDir, sourcemap, entryPoints: entryPoints ?? { index: './src/index.ts' } } as PluginBuild['initialOptions'],
			onEnd: vi.fn((callback) => { onEndCallback = callback }),
		};
		instance.plugin.setup(build as PluginBuild);
	}

	it('has the correct name', () => {
		expect(iifePlugin().plugin.name).toBe('esbuild:iife');
	});

	it('returns a valid Plugin object from factory', () => {
		const { plugin } = iifePlugin();
		expect(typeof plugin.name).toBe('string');
		expect(typeof plugin.setup).toBe('function');
	});

	it('accepts options and returns a valid Plugin', () => {
		const { plugin } = iifePlugin({ globalName: 'MyLib' });
		expect(plugin.name).toBe('esbuild:iife');
	});

	it('exposes an empty files array initially', () => {
		expect(iifePlugin().files).toEqual([]);
	});

	it('does not register onEnd when outdir is missing', () => {
		const { plugin } = iifePlugin();
		const build: Partial<PluginBuild> = {
			initialOptions: {} as PluginBuild['initialOptions'],
			onEnd: vi.fn(),
		};
		plugin.setup(build as PluginBuild);
		expect(build.onEnd).not.toHaveBeenCalled();
	});

	describe('IIFE build options', () => {
		it('calls esbuild.build with correct base options', async () => {
			setupPlugin();
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			expect(mockEsbuild).toHaveBeenCalledOnce();
			const opts = mockEsbuild.mock.calls[0]![0];
			expect(opts.bundle).toBe(true);
			expect(opts.format).toBe('esm');
			expect(opts.splitting).toBe(false);
			expect(opts.write).toBe(false);
			expect(opts.outdir).toBe(join(outputDir, 'iife'));
		});

		it('assigns to named namespace when globalName option is provided', async () => {
			mockEsbuild.mockResolvedValueOnce(makeBuildResult({ index: 'var x = 1;\nexport {\n  x\n};' }));
			setupPlugin({ globalName: 'MyLib' });
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			const content = await memfs.promises.readFile(join(iifeOutdir, 'index.js'), 'utf8');
			expect(content).toContain('globalThis.MyLib = { x }');
		});

		it('uses flat Object.assign when no globalName option is provided', async () => {
			mockEsbuild.mockResolvedValueOnce(makeBuildResult({ index: 'var x = 1;\nexport {\n  x\n};' }));
			setupPlugin();
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			const content = await memfs.promises.readFile(join(iifeOutdir, 'index.js'), 'utf8');
			expect(content).toContain('Object.assign(globalThis, { x })');
		});

		it('uses public name when minified output aliases export (e as Name)', async () => {
			mockEsbuild.mockResolvedValueOnce(makeBuildResult({ index: 'var e={};export{e as RequestHeader};' }));
			setupPlugin();
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var e={};')],
			} as unknown as BuildResult);

			const content = await memfs.promises.readFile(join(iifeOutdir, 'index.js'), 'utf8');
			expect(content).toContain('Object.assign(globalThis, { RequestHeader: e })');
		});

		it('does not pass globalName or footer to esbuild', async () => {
			setupPlugin({ globalName: 'MyLib' });
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			const opts = mockEsbuild.mock.calls[0]![0];
			expect(opts.globalName).toBeUndefined();
			expect(opts.footer).toBeUndefined();
		});

		it('enables external source maps when primary build has sourcemaps', async () => {
			setupPlugin(undefined, true);
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			expect(mockEsbuild.mock.calls[0]![0].sourcemap).toBe('external');
		});

		it('disables source maps when primary build has no sourcemaps', async () => {
			setupPlugin();
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			expect(mockEsbuild.mock.calls[0]![0].sourcemap).toBe(false);
		});
	});

	describe('entry point identification', () => {
		it('uses configured entry point names from object form', async () => {
			setupPlugin(undefined, undefined, { index: './src/index.ts', utils: './src/utils.ts' });
			mockEsbuild.mockResolvedValueOnce(makeBuildResult({ index: '(() => {})();' }))
			           .mockResolvedValueOnce(makeBuildResult({ utils: '(() => {})();' }));
			await onEndCallback({
				outputFiles: [
					makeOutputFile(`${outputDir}/index.js`, 'var a = 1;'),
					makeOutputFile(`${outputDir}/utils.js`, 'var b = 2;'),
					makeOutputFile(`${outputDir}/ABCDEF.js`, 'var c = 3;'),
				],
			} as unknown as BuildResult);

			expect(mockEsbuild).toHaveBeenCalledTimes(2);
			const [call0, call1] = [mockEsbuild.mock.calls[0]![0], mockEsbuild.mock.calls[1]![0]];
			expect(call0.entryPoints).toEqual({ index: `${outputDir}/index.js` });
			expect(call1.entryPoints).toEqual({ utils: `${outputDir}/utils.js` });
		});

		it('handles array entry points', async () => {
			setupPlugin(undefined, undefined, ['./src/index.ts', './src/utils.ts']);
			mockEsbuild.mockResolvedValueOnce(makeBuildResult({ index: '(() => {})();' }))
			           .mockResolvedValueOnce(makeBuildResult({ utils: '(() => {})();' }));
			await onEndCallback({
				outputFiles: [
					makeOutputFile(`${outputDir}/index.js`, 'var a = 1;'),
					makeOutputFile(`${outputDir}/utils.js`, 'var b = 2;'),
				],
			} as unknown as BuildResult);

			expect(mockEsbuild).toHaveBeenCalledTimes(2);
			const [call0, call1] = [mockEsbuild.mock.calls[0]![0], mockEsbuild.mock.calls[1]![0]];
			expect(call0.entryPoints).toEqual({ index: `${outputDir}/index.js` });
			expect(call1.entryPoints).toEqual({ utils: `${outputDir}/utils.js` });
		});

		it('does nothing when outputFiles is empty', async () => {
			setupPlugin();
			await onEndCallback({ outputFiles: [] } as unknown as BuildResult);

			expect(mockEsbuild).not.toHaveBeenCalled();
		});

		it('does nothing when no configured entry has a matching output file', async () => {
			setupPlugin(undefined, undefined, { missing: './src/missing.ts' });
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/other.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			expect(mockEsbuild).not.toHaveBeenCalled();
		});
	});

	describe('virtual loader plugin', () => {
		let virtualPlugin: Plugin;
		let onResolveCallback: (args: OnResolveArgs) => ReturnType<Parameters<PluginBuild['onResolve']>[1]>;
		let onLoadCallback: (args: OnLoadArgs) => ReturnType<Parameters<PluginBuild['onLoad']>[1]>;

		async function setupWithVirtualLoader(): Promise<void> {
			setupPlugin();
			await onEndCallback({
				outputFiles: [
					makeOutputFile(`${outputDir}/index.js`, 'import("./chunk.js")'),
					makeOutputFile(`${outputDir}/chunk.js`, 'var y = 2;'),
				],
			} as unknown as BuildResult);

			virtualPlugin = mockEsbuild.mock.calls[0]![0].plugins![0]!;
			const mockVirtualBuild: Partial<PluginBuild> = {
				onResolve: vi.fn((_, cb) => { onResolveCallback = cb }),
				onLoad: vi.fn((_, cb) => { onLoadCallback = cb }),
			};
			virtualPlugin.setup(mockVirtualBuild as PluginBuild);
		}

		it('has the correct name', async () => {
			await setupWithVirtualLoader();
			expect(virtualPlugin.name).toBe('iife:virtual-loader');
		});

		it('resolves entry points to iife namespace', async () => {
			await setupWithVirtualLoader();
			const result = onResolveCallback(makeResolveArgs({ path: `${outputDir}/index.js`, kind: 'entry-point' }));
			expect(result).toEqual({ path: `${outputDir}/index.js`, namespace: 'iife' });
		});

		it('resolves relative imports from output files', async () => {
			await setupWithVirtualLoader();
			const result = onResolveCallback(makeResolveArgs({
				path: './chunk.js', kind: 'dynamic-import', resolveDir: outputDir, importer: `${outputDir}/index.js`, namespace: 'iife'
			}));
			expect(result).toEqual({ path: `${outputDir}/chunk.js`, namespace: 'iife' });
		});

		it('marks bare specifiers as external', async () => {
			await setupWithVirtualLoader();
			const result = onResolveCallback(makeResolveArgs({
				path: 'jsdom', kind: 'dynamic-import', resolveDir: outputDir, importer: `${outputDir}/index.js`, namespace: 'iife'
			}));
			expect(result).toEqual({ external: true });
		});

		it('marks unresolved relative imports as external', async () => {
			await setupWithVirtualLoader();
			const result = onResolveCallback(makeResolveArgs({
				path: './nonexistent.js', kind: 'import-statement', resolveDir: outputDir, importer: `${outputDir}/index.js`, namespace: 'iife'
			}));
			expect(result).toEqual({ external: true });
		});

		it('loads file content from memory with resolveDir', async () => {
			await setupWithVirtualLoader();
			const result = onLoadCallback(makeLoadArgs({ path: `${outputDir}/chunk.js` }));
			expect(result).toEqual({ contents: 'var y = 2;', loader: 'js', resolveDir: outputDir });
		});

		it('returns null for unknown paths', async () => {
			await setupWithVirtualLoader();
			const result = onLoadCallback(makeLoadArgs({ path: `${outputDir}/unknown.js` }));
			expect(result).toBeNull();
		});
	});

	describe('output file writing', () => {
		it('writes only entry point files to the iife directory', async () => {
			mockEsbuild.mockResolvedValueOnce(makeBuildResult({ index: '(() => { /* entry */ })();' }))
			           .mockResolvedValueOnce(makeBuildResult({ utils: '(() => { /* utils */ })();' }));
			setupPlugin(undefined, undefined, { index: './src/index.ts', utils: './src/utils.ts' });
			await onEndCallback({
				outputFiles: [
					makeOutputFile(`${outputDir}/index.js`, 'var a = 1;'),
					makeOutputFile(`${outputDir}/utils.js`, 'var b = 2;'),
				],
			} as unknown as BuildResult);

			const files = (await memfs.promises.readdir(iifeOutdir)).sort();
			expect(files).toEqual(['index.js', 'utils.js']);
			expect(await memfs.promises.readFile(join(iifeOutdir, 'index.js'), 'utf8')).toBe('(() => { /* entry */ })();');
		});

		it('inlines chunks — per-entry builds produce no separate chunk files', async () => {
			// Per-entry builds with splitting:false inline all dynamic imports;
			// the secondary build result should only contain the entry file.
			mockEsbuild.mockResolvedValueOnce(makeBuildResult({ transportr: '(() => { /* inlined */ })();' }));
			setupPlugin(undefined, undefined, { transportr: './src/transportr.ts' });
			await onEndCallback({
				outputFiles: [
					makeOutputFile(`${outputDir}/transportr.js`, 'var a = 1;'),
					makeOutputFile(`${outputDir}/TOSJXEKD.js`, 'var chunk = 1;'),
				],
			} as unknown as BuildResult);

			const files = await memfs.promises.readdir(iifeOutdir);
			expect(files).toEqual(['transportr.js']);
		});

		it('writes source map files alongside entry points', async () => {
			const result = makeBuildResult({ index: '(() => {})();' });
			const mapPath = join(iifeOutdir, 'index.js.map');
			result.outputFiles.push(makeOutputFile(mapPath, '{"version":3}'));
			mockEsbuild.mockResolvedValueOnce(result);
			setupPlugin(undefined, true);
			await onEndCallback({
				outputFiles: [makeOutputFile(`${outputDir}/index.js`, 'var x = 1;')],
			} as unknown as BuildResult);

			const files = (await memfs.promises.readdir(iifeOutdir)).sort();
			expect(files).toEqual(['index.js', 'index.js.map']);
		});
	});
});
