import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// Mock TypeScriptProject to capture constructor arguments and avoid actual builds
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

describe('tsbuild', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let processExitSpy: ReturnType<typeof vi.spyOn>;
	let originalArgv: string[];
	let originalNpmPackageVersion: string | undefined;

	beforeAll(() => {
		// Create a temporary copy of tsbuild.ts without the shebang
		const content = readFileSync(tsbuildPath, 'utf8');
		const contentWithoutShebang = content.replace(/^#!.*\n/, '');
		writeFileSync(tempTsbuildPath, contentWithoutShebang);
	});

	afterAll(() => {
		// Clean up the temporary file
		if (existsSync(tempTsbuildPath)) {
			unlinkSync(tempTsbuildPath);
		}
	});

	beforeEach(() => {
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
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

	it('should create TypeScriptProject with correct arguments from CLI', async () => {
		// Set up mock command line arguments
		process.argv = ['node', 'tsbuild', '-p', './test-project', '-w'];

		// Dynamically import the module to run the code
		await import('../src/tsbuild.temp');

		// Verify that TypeScriptProject was constructed with correct directory and options
		expect(constructorMock).toHaveBeenCalledWith(
			expect.stringMatching(/test-project$/),
			expect.objectContaining({
				tsbuild: expect.objectContaining({ watch: { enabled: true } })
			})
		);
		expect(buildMock).toHaveBeenCalled();
	});

	it('should display help message with --help flag', async () => {
		process.argv = ['node', 'tsbuild', '--help'];

		try {
			await import('../src/tsbuild.temp');
		} catch (error) {
			expect((error as Error).message).toBe('process.exit(0)');
		}

		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('tsbuild - TypeScript build tool')
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('Usage: tsbuild [options]')
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('-h, --help')
		);
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('-v, --version')
		);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		expect(constructorMock).not.toHaveBeenCalled();
	});

	it('should display help message with -h flag', async () => {
		process.argv = ['node', 'tsbuild', '-h'];

		try {
			await import('../src/tsbuild.temp');
		} catch (error) {
			expect((error as Error).message).toBe('process.exit(0)');
		}

		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining('tsbuild - TypeScript build tool')
		);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		expect(constructorMock).not.toHaveBeenCalled();
	});

	it('should display version with --version flag', async () => {
		process.argv = ['node', 'tsbuild', '--version'];

		const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
		const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
		process.env.npm_package_version = packageJson.version;

		try {
			await import('../src/tsbuild.temp');
		} catch (error) {
			expect((error as Error).message).toBe('process.exit(0)');
		}

		expect(consoleLogSpy).toHaveBeenCalledWith(packageJson.version);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		expect(constructorMock).not.toHaveBeenCalled();
	});

	it('should display version with -v flag', async () => {
		process.argv = ['node', 'tsbuild', '-v'];

		const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
		const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
		process.env.npm_package_version = packageJson.version;

		try {
			await import('../src/tsbuild.temp');
		} catch (error) {
			expect((error as Error).message).toBe('process.exit(0)');
		}

		expect(consoleLogSpy).toHaveBeenCalledWith(packageJson.version);
		expect(processExitSpy).toHaveBeenCalledWith(0);
		expect(constructorMock).not.toHaveBeenCalled();
	});
});
