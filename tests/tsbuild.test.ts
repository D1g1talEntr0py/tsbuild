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
		originalExitCode = process.exitCode;
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
});
