import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { outputPlugin } from '../../src/plugins/output';
import { TestHelper } from '../scripts/test-helper';
import type { BuildResult, PluginBuild } from 'esbuild';
import { vol, fs as memfs } from 'memfs';
import { join } from 'node:path';

// Mock node:fs and node:fs/promises to use memfs
vi.mock('node:fs', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs;
});

vi.mock('node:fs/promises', async () => {
	const memfs: typeof import('memfs') = await vi.importActual('memfs');
	return memfs.fs.promises;
});

describe('outputPlugin', () => {
	let mockBuild: PluginBuild;
	let onEndCallback: (result: BuildResult) => Promise<void>;
	const outputDir = join(process.cwd(), 'test-output');

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		vol.mkdirSync(outputDir, { recursive: true });

		const build: Partial<PluginBuild> = {
			onEnd: vi.fn((callback) => {
				onEndCallback = callback;
			}),
		};
		mockBuild = build as PluginBuild;

		outputPlugin().setup(mockBuild);
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	it('should have the correct name', () => {
		expect(outputPlugin().name).toBe('esbuild:output-plugin');
	});

	it('should register an onEnd callback', () => {
		expect(mockBuild.onEnd).toHaveBeenCalledWith(expect.any(Function));
	});

	describe('onEnd callback', () => {
		it('should write .js files with executable permissions if they have a shebang', async () => {
			const contents = new TextEncoder().encode('#!/usr/bin/env node\nconsole.log("hello");');
			const filePath = join(outputDir, 'script.js');
			const mockResult = {
				outputFiles: [{ path: filePath, contents }],
			};

			await onEndCallback(mockResult as BuildResult);

			const fileContent = await memfs.promises.readFile(filePath);
			const stats = await memfs.promises.stat(filePath);

			expect(fileContent).toEqual(Buffer.from(contents));
			expect(stats.mode & 0o777).toBe(0o755); // Check executable bit
		});

		it('should write .js files without executable permissions if they do not have a shebang', async () => {
			const contents = new TextEncoder().encode('console.log("hello");');
			const filePath = join(outputDir, 'lib.js');
			const mockResult = {
				outputFiles: [{ path: filePath, contents }],
			};

			await onEndCallback(mockResult as BuildResult);

			const fileContent = await memfs.promises.readFile(filePath);
			const stats = await memfs.promises.stat(filePath);

			expect(fileContent).toEqual(Buffer.from(contents));
			expect(stats.mode & 0o777).toBe(0o666); // No executable bit (memfs doesn't apply umask)
		});

		it('should write .css files', async () => {
			const contents = new TextEncoder().encode('body { color: red }');
			const filePath = join(outputDir, 'styles.css');
			const mockResult = {
				outputFiles: [{ path: filePath, contents }],
			};

			await onEndCallback(mockResult as BuildResult);

			const fileContent = await memfs.promises.readFile(filePath);
			const stats = await memfs.promises.stat(filePath);

			expect(fileContent).toEqual(Buffer.from(contents));
			expect(stats.mode & 0o777).toBe(0o666); // Regular file permissions (memfs doesn't apply umask)
		});

		it('should write other file types using contents', async () => {
			const mockContents = new Uint8Array([1, 2, 3]);
			const filePath = join(outputDir, 'data.bin');
			const mockResult = {
				outputFiles: [{ path: filePath, contents: mockContents }],
			};

			await onEndCallback(mockResult as BuildResult);

			const fileContent = await memfs.promises.readFile(filePath);
			const stats = await memfs.promises.stat(filePath);

			expect(fileContent).toEqual(Buffer.from(mockContents));
			expect(stats.mode & 0o777).toBe(0o666); // Regular file permissions (memfs doesn't apply umask)
		});

		it('should handle multiple files correctly', async () => {
			const scriptPath = join(outputDir, 'script.js');
			const libPath = join(outputDir, 'lib.js');
			const cssPath = join(outputDir, 'styles.css');
			const binPath = join(outputDir, 'asset.bin');

			const jsFileWithShebang = { path: scriptPath, contents: new TextEncoder().encode('#!/usr/bin/env node\n') };
			const jsFile = { path: libPath, contents: new TextEncoder().encode('const a = 1;') };
			const cssFile = { path: cssPath, contents: new TextEncoder().encode('p { color: blue }') };
			const otherFile = { path: binPath, contents: new Uint8Array([4, 5, 6]) };

			const mockResult = {
				outputFiles: [jsFileWithShebang, jsFile, cssFile, otherFile],
			};

			await onEndCallback(mockResult as BuildResult);

			// Verify all files were written
			const scriptContent = await memfs.promises.readFile(scriptPath);
			const scriptStats = await memfs.promises.stat(scriptPath);
			expect(scriptContent).toEqual(Buffer.from(jsFileWithShebang.contents));
			expect(scriptStats.mode & 0o777).toBe(0o755); // Executable

			const libContent = await memfs.promises.readFile(libPath);
			const libStats = await memfs.promises.stat(libPath);
			expect(libContent).toEqual(Buffer.from(jsFile.contents));
			expect(libStats.mode & 0o777).toBe(0o666); // Not executable (memfs doesn't apply umask)

			const cssContent = await memfs.promises.readFile(cssPath);
			const cssStats = await memfs.promises.stat(cssPath);
			expect(cssContent).toEqual(Buffer.from(cssFile.contents));
			expect(cssStats.mode & 0o777).toBe(0o666); // Regular file (memfs doesn't apply umask)

			const binContent = await memfs.promises.readFile(binPath);
			const binStats = await memfs.promises.stat(binPath);
			expect(binContent).toEqual(Buffer.from(otherFile.contents));
			expect(binStats.mode & 0o777).toBe(0o666); // Regular file (memfs doesn't apply umask)
		});
	});
});
