import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { TestHelper } from './scripts/test-helper';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsbuildPath = join(__dirname, '../src/tsbuild.ts');
const tempTsbuildPath = join(__dirname, '../src/tsbuild.temp.ts');

describe('tsbuild CLI', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;
	let originalArgv: string[];
	let originalExitCode: number | undefined;
	let originalNpmPackageVersion: string | undefined;

	beforeAll(() => {
		const content = readFileSync(tsbuildPath, 'utf8');
		writeFileSync(tempTsbuildPath, content.replace(/^#!.*\n/, ''));
	});

	afterAll(() => {
		if (existsSync(tempTsbuildPath)) { unlinkSync(tempTsbuildPath) }
	});

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		originalArgv = process.argv;
		originalExitCode = process.exitCode as number | undefined;
		originalNpmPackageVersion = process.env['npm_package_version'];
		vi.resetModules();
	});

	afterEach(async () => {
		const { processManager } = await import('../src/process-manager');
		processManager.close();
		consoleLogSpy.mockRestore();
		processExitSpy.mockRestore();
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
		if (originalNpmPackageVersion === undefined) { delete process.env['npm_package_version']; }
		else { process.env['npm_package_version'] = originalNpmPackageVersion; }
	});

	describe('--help / -h', () => {
		it.each([
			['--help'],
			['-h'],
		])('displays help message with %s', async (flag) => {
			process.argv = ['node', 'tsbuild', flag];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('tsbuild - TypeScript build tool'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: tsbuild [options]'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('-h, --help'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('-v, --version'));
			expect(process.exitCode).toBe(0);
			expect(processExitSpy).not.toHaveBeenCalled();
		});
	});

	describe('--version / -v', () => {
		it.each([
			['--version'],
			['-v'],
		])('displays version with %s', async (flag) => {
			process.argv = ['node', 'tsbuild', flag];
			process.exitCode = undefined;
			const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
			process.env['npm_package_version'] = packageJson.version;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(consoleLogSpy).toHaveBeenCalledWith(packageJson.version);
			expect(process.exitCode).toBe(0);
			expect(processExitSpy).not.toHaveBeenCalled();
		});
	});

	describe('project build', () => {
		let cleanup: (() => Promise<void>) | undefined;

		afterEach(async () => {
			await cleanup?.();
			cleanup = undefined;
		});

		it('builds a real project via CLI', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			process.argv = ['node', 'tsbuild', '-p', dir];
			process.exitCode = undefined;
			consoleLogSpy.mockRestore(); // Allow Logger output through

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
			expect(process.exitCode).toBeUndefined();
		});

		it('passes --force flag to TypeScriptProject', async () => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { clean: false } }
			});
			cleanup = c;

			// First build to prime the cache
			process.argv = ['node', 'tsbuild', '-p', dir];
			process.exitCode = undefined;
			consoleLogSpy.mockRestore();
			// @ts-expect-error
			await import('../src/tsbuild.temp');
			vi.resetModules();
			consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

			// Second build with --force should also succeed
			process.argv = ['node', 'tsbuild', '-p', dir, '--force'];
			process.exitCode = undefined;
			consoleLogSpy.mockRestore();
			// @ts-expect-error
			await import('../src/tsbuild.temp');

			await expect(access(join(dir, 'dist/index.js'))).resolves.toBeUndefined();
			expect(process.exitCode).toBeUndefined();
		});
	});

	describe('flag pass-through', () => {
		afterEach(() => {
			vi.doUnmock('../src/type-script-project');
		});

		it('passes --watch flag to TypeScriptProject', async () => {
			const buildSpy = vi.fn().mockResolvedValue(undefined);
			const closeSpy = vi.fn().mockResolvedValue(undefined);
			let capturedDirectory: unknown;
			let capturedOptions: unknown;
			let capturedCliOptions: unknown;

			vi.doMock('../src/type-script-project', () => ({
				TypeScriptProject: class implements AsyncDisposable {
					constructor(directory: unknown, options: unknown, cliOptions: unknown) {
						capturedDirectory = directory;
						capturedOptions = options;
						capturedCliOptions = cliOptions;
					}
					isWatchMode = true;
					build = buildSpy;
					close = closeSpy;
					[Symbol.asyncDispose](): Promise<void> { return this.close() }
				}
			}));

			process.argv = ['node', 'tsbuild', '-p', '/tmp/tsbuild-watch-test', '--watch'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(capturedDirectory).toBe('/tmp/tsbuild-watch-test');
			expect(capturedOptions).toMatchObject({ compilerOptions: {} });
			expect(capturedCliOptions).toEqual({ clearCache: false, force: false, watch: true, minify: false });
		});

		it('defaults the project directory to the current working directory', async () => {
			const buildSpy = vi.fn().mockResolvedValue(undefined);
			const closeSpy = vi.fn().mockResolvedValue(undefined);
			let capturedDirectory: unknown;

			vi.doMock('../src/type-script-project', () => ({
				TypeScriptProject: class implements AsyncDisposable {
					constructor(directory: unknown) {
						capturedDirectory = directory;
						}
					isWatchMode = false;
					build = buildSpy;
					close = closeSpy;
					[Symbol.asyncDispose](): Promise<void> { return this.close() }
				}
			}));

			process.argv = ['node', 'tsbuild'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(capturedDirectory).toBe(process.cwd());
		});

		it('preserves configured boolean values when flags are omitted', async () => {
			const buildSpy = vi.fn().mockResolvedValue(undefined);
			const closeSpy = vi.fn().mockResolvedValue(undefined);
			let capturedOptions: unknown;
			let capturedCliOptions: unknown;

			vi.doMock('../src/type-script-project', () => ({
				TypeScriptProject: class implements AsyncDisposable {
					constructor(_directory: unknown, options: unknown, cliOptions: unknown) {
						capturedOptions = options;
						capturedCliOptions = cliOptions;
					}
					isWatchMode = false;
					build = buildSpy;
					close = closeSpy;
					[Symbol.asyncDispose](): Promise<void> { return this.close() }
				}
			}));

			process.argv = ['node', 'tsbuild', '-p', '/tmp/tsbuild-config-test'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(capturedOptions).toMatchObject({ compilerOptions: {} });
			expect(capturedOptions).not.toHaveProperty('tsbuild');
			expect(capturedCliOptions).toEqual({ clearCache: false, force: false, watch: false, minify: false });
		});

		it('passes explicit force, watch, and minify flags to TypeScriptProject', async () => {
			const buildSpy = vi.fn().mockResolvedValue(undefined);
			const closeSpy = vi.fn().mockResolvedValue(undefined);
			let capturedOptions: unknown;
			let capturedCliOptions: unknown;

			vi.doMock('../src/type-script-project', () => ({
				TypeScriptProject: class implements AsyncDisposable {
					constructor(_directory: unknown, options: unknown, cliOptions: unknown) {
						capturedOptions = options;
						capturedCliOptions = cliOptions;
					}
					isWatchMode = true;
					build = buildSpy;
					close = closeSpy;
					[Symbol.asyncDispose](): Promise<void> { return this.close() }
				}
			}));

			process.argv = ['node', 'tsbuild', '-p', '/tmp/tsbuild-explicit-flags-test', '--force', '--watch', '--minify'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(capturedOptions).toMatchObject({ compilerOptions: {} });
			expect(capturedCliOptions).toEqual({ clearCache: false, force: true, watch: true, minify: true });
		});

		it('passes --clearCache flag to TypeScriptProject', async () => {
			const buildSpy = vi.fn().mockResolvedValue(undefined);
			const closeSpy = vi.fn().mockResolvedValue(undefined);
			let capturedCliOptions: unknown;

			vi.doMock('../src/type-script-project', () => ({
				TypeScriptProject: class implements AsyncDisposable {
					constructor(_directory: unknown, _options: unknown, cliOptions: unknown) {
						capturedCliOptions = cliOptions;
					}
					isWatchMode = false;
					build = buildSpy;
					close = closeSpy;
					[Symbol.asyncDispose](): Promise<void> { return this.close() }
				}
			}));

			process.argv = ['node', 'tsbuild', '-p', '/tmp/tsbuild-clear-cache-test', '--clearCache'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(capturedCliOptions).toEqual({ clearCache: true, force: false, watch: false, minify: false });
		});

		it('drains a non-watch project after a handled build error', async () => {
			const closeSpy = vi.fn().mockResolvedValue(undefined);
			const buildSpy = vi.fn().mockImplementation(() => { process.exitCode = 1 });

			vi.doMock('../src/type-script-project', () => ({
				TypeScriptProject: class implements AsyncDisposable {
					isWatchMode = false;
					build = buildSpy;
					close = closeSpy;
					[Symbol.asyncDispose](): Promise<void> { return this.close() }
				}
			}));

			process.argv = ['node', 'tsbuild', '-p', '/tmp/tsbuild-error-test'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(process.exitCode).toBe(1);
		});
	});
});
