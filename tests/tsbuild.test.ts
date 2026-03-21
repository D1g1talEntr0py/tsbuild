import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const constructorMock = vi.fn();
const buildMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/type-script-project', () => ({
	TypeScriptProject: class {
		constructor(...args: unknown[]) { constructorMock(...args) }
		build = buildMock;
	}
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsbuildPath = join(__dirname, '../src/tsbuild.ts');
const tempTsbuildPath = join(__dirname, '../src/tsbuild.temp.ts');

describe('tsbuild CLI', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;
	let originalArgv: string[];
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
		originalNpmPackageVersion = process.env.npm_package_version;
		constructorMock.mockClear();
		buildMock.mockClear();
		vi.resetModules();
	});

	afterEach(async () => {
		const { processManager } = await import('../src/process-manager');
		processManager.close();
		consoleLogSpy.mockRestore();
		processExitSpy.mockRestore();
		process.argv = originalArgv;
		if (originalNpmPackageVersion === undefined) { delete process.env.npm_package_version; }
		else { process.env.npm_package_version = originalNpmPackageVersion; }
	});

	describe('--help / -h', () => {
		it.each([
			['--help'],
			['-h'],
		])('displays help message with %s', async (flag) => {
			process.argv = ['node', 'tsbuild', flag];

			// @ts-expect-error - temp module created at runtime for cache busting
			try { await import('../src/tsbuild.temp'); }
			catch (error) { expect((error as Error).message).toBe('process.exit(0)'); }

			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('tsbuild - TypeScript build tool'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: tsbuild [options]'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('-h, --help'));
			expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('-v, --version'));
			expect(processExitSpy).toHaveBeenCalledWith(0);
			expect(constructorMock).not.toHaveBeenCalled();
		});
	});

	describe('--version / -v', () => {
		it.each([
			['--version'],
			['-v'],
		])('displays version with %s', async (flag) => {
			process.argv = ['node', 'tsbuild', flag];
			const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
			process.env.npm_package_version = packageJson.version;

			// @ts-expect-error - temp module created at runtime for cache busting
			try { await import('../src/tsbuild.temp'); }
			catch (error) { expect((error as Error).message).toBe('process.exit(0)'); }

			expect(consoleLogSpy).toHaveBeenCalledWith(packageJson.version);
			expect(processExitSpy).toHaveBeenCalledWith(0);
			expect(constructorMock).not.toHaveBeenCalled();
		});
	});

	describe('project build', () => {
		it('creates TypeScriptProject with correct arguments from CLI', async () => {
			process.argv = ['node', 'tsbuild', '-p', './test-project', '-w'];

			// @ts-expect-error - temp module created at runtime for cache busting
			await import('../src/tsbuild.temp');

			expect(constructorMock).toHaveBeenCalledWith(
				expect.stringMatching(/test-project$/),
				expect.objectContaining({
					tsbuild: expect.objectContaining({ watch: { enabled: true } })
				})
			);
			expect(buildMock).toHaveBeenCalled();
		});
	});
});
