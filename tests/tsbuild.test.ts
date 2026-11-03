import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type MockInstance } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { TestHelper } from './scripts/test-helper';
import type { TypeScriptProject } from '../src/type-script-project';

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
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('--outputStyle'));
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

		it.each(['cli', 'tsconfig'] as const)('checks a real project without emitting when noEmit comes from %s', async (source) => {
			const { dir, cleanup: c } = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const value: number = 1;' },
				tsconfig: { compilerOptions: { noEmit: source === 'tsconfig' } }
			});
			cleanup = c;
			process.argv = ['node', 'tsbuild', '-p', dir, ...(source === 'cli' ? ['--noEmit'] : [])];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			await expect(access(join(dir, 'dist/index.js'))).rejects.toThrow();
			await expect(access(join(dir, 'dist/index.d.ts'))).rejects.toThrow();
			expect(process.exitCode).toBeUndefined();
		});
	});

	describe('flag pass-through', () => {
		let constructorSpy: MockInstance<typeof TypeScriptProject>;
		let buildSpy: MockInstance<TypeScriptProject['build']>;
		let closeSpy: MockInstance<TypeScriptProject['close']>;
		let directory: string;
		let cleanup: () => Promise<void>;

		beforeEach(async () => {
			const project = await TestHelper.createTempProject({
				files: { 'src/index.ts': 'export const x = 1;' },
				tsconfig: { tsbuild: { clean: false } }
			});
			directory = project.dir;
			cleanup = project.cleanup;

			const projectModule = await import('../src/type-script-project');
			buildSpy = vi.spyOn(projectModule.TypeScriptProject.prototype, 'build').mockImplementation(async function (this: TypeScriptProject) { return this });
			closeSpy = vi.spyOn(projectModule.TypeScriptProject.prototype, 'close');
			constructorSpy = vi.spyOn(projectModule, 'TypeScriptProject');
		});

		afterEach(async () => {
			try {
				for (const result of constructorSpy.mock.results) {
					if (result.type === 'return') { await result.value.close() }
				}
			} finally {
				constructorSpy.mockRestore();
				buildSpy.mockRestore();
				closeSpy.mockRestore();
				await cleanup();
			}
		});

		it('passes --watch flag to TypeScriptProject', async () => {
			buildSpy.mockResolvedValue(null);
			process.argv = ['node', 'tsbuild', '-p', directory, '--watch'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(constructorSpy).toHaveBeenCalledExactlyOnceWith(directory, {}, { clearCache: false, force: false, watch: true, minify: false });
			expect(process.exitCode).toBeUndefined();
		});

		it('defaults the project directory to the current working directory', async () => {
			process.argv = ['node', 'tsbuild'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(constructorSpy).toHaveBeenCalledExactlyOnceWith(process.cwd(), {}, { clearCache: false, force: false, watch: false, minify: false });
			expect(process.exitCode).toBeUndefined();
		});

		it('passes default CLI options without overriding the project configuration', async () => {
			process.argv = ['node', 'tsbuild', '-p', directory];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(buildSpy).toHaveBeenCalledExactlyOnceWith();
			expect(constructorSpy).toHaveBeenCalledExactlyOnceWith(directory, {}, { clearCache: false, force: false, watch: false, minify: false });
			expect(process.exitCode).toBeUndefined();
		});

		it('passes explicit force, watch, and minify flags to TypeScriptProject', async () => {
			buildSpy.mockResolvedValue(null);
			process.argv = ['node', 'tsbuild', '-p', directory, '--force', '--watch', '--minify'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(constructorSpy).toHaveBeenCalledExactlyOnceWith(directory, {}, { clearCache: false, force: true, watch: true, minify: true });
			expect(process.exitCode).toBeUndefined();
		});

		it('passes an explicit output style to TypeScriptProject', async () => {
			process.argv = ['node', 'tsbuild', '-p', directory, '--outputStyle', 'detailed'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(constructorSpy).toHaveBeenCalledExactlyOnceWith(directory, {}, { clearCache: false, force: false, watch: false, minify: false, outputStyle: 'detailed' });
			expect(process.exitCode).toBeUndefined();
		});

		it('passes --clearCache flag to TypeScriptProject', async () => {
			process.argv = ['node', 'tsbuild', '-p', directory, '--clearCache'];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(constructorSpy).toHaveBeenCalledExactlyOnceWith(directory, {}, { clearCache: true, force: false, watch: false, minify: false });
			expect(process.exitCode).toBeUndefined();
		});

		it.each(['--noEmit', '-n'])('configures noEmit and disposes the project for %s', async (flag) => {
			process.argv = ['node', 'tsbuild', '-p', directory, flag];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledExactlyOnceWith();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(constructorSpy).toHaveBeenCalledExactlyOnceWith(directory, { compilerOptions: { noEmit: true } }, { clearCache: false, force: false, watch: false, minify: false });
			expect(process.exitCode).toBeUndefined();
		});

		it('keeps a type-check-only watch project alive', async () => {
			buildSpy.mockResolvedValue(null);
			process.argv = ['node', 'tsbuild', '-p', directory, '--noEmit', '--watch'];

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledExactlyOnceWith();
			expect(closeSpy).not.toHaveBeenCalled();
		});

		it('drains a non-watch project after a handled build error', async () => {
			buildSpy.mockImplementation(async function (this: TypeScriptProject) {
				process.exitCode = 1;
				return this;
			});
			process.argv = ['node', 'tsbuild', '-p', directory];
			process.exitCode = undefined;

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(buildSpy).toHaveBeenCalledOnce();
			expect(closeSpy).toHaveBeenCalledOnce();
			expect(process.exitCode).toBe(1);
		});
	});
});
