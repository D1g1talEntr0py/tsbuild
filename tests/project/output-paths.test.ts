import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fs, vol } from 'memfs';
import { OutputPathValidator } from '../../src/project/output-paths';
import { ConfigurationError } from '../../src/errors';
import { Paths } from '../../src/paths';

vi.mock('node:fs', async () => (await import('memfs')).fs);
vi.mock('node:fs/promises', async () => (await import('memfs')).fs.promises);

const directory = Paths.absolute('/project');
const configFilePath = Paths.absolute('/project/tsconfig.json');
const sourcePath = Paths.absolute('/project/src/index.ts');

function validator(outDir = '/project/dist', roots: readonly string[] = [ sourcePath ], configPath = configFilePath): OutputPathValidator {
	return new OutputPathValidator(directory, configPath, roots, Paths.absolute(outDir));
}

beforeEach(() => {
	vol.fromJSON({ '/project/tsconfig.json': '{}', '/project/package.json': '{}', '/project/src/index.ts': '', '/outside/input.ts': '', '/project/dist/keep.txt': 'keep' });
});

afterEach(() => {
	vi.restoreAllMocks();
	vol.reset();
});

describe('OutputPathValidator', () => {
	it('constructs lazily and validates without creating or cleaning outputs', async () => {
		const realpath = vi.spyOn(fs.promises, 'realpath');
		const instance = validator('/project/new/nested');
		expect(realpath).not.toHaveBeenCalled();
		const before = vol.toJSON();
		const outputDirectory = await instance.validateOutputDirectory();
		expect(outputDirectory).toBe('/project/new/nested');
		await instance.validateDeclarationPaths(outputDirectory, [ 'index', 'nested/module', 'nested/../other', '/leading' ]);
		expect(vol.toJSON()).toEqual(before);
		await expect(validator().validateOutputDirectory()).resolves.toBe('/project/dist');
		expect(vol.readFileSync('/project/dist/keep.txt', 'utf8')).toBe('keep');
	});

	it.each([ '/', '/project', '/project/src', '/project/src/..', '/project/tsconfig.json', '/project/package.json' ])('rejects protected output %s with the original error', async (outDir) => {
		await expect(validator(outDir).validateOutputDirectory()).rejects.toThrow(new ConfigurationError(`Unsafe output directory "${Paths.absolute(outDir)}". Choose a dedicated directory that is not the filesystem root, the project directory, an ancestor of the project, or a directory containing project inputs.`));
	});

	it('protects external source roots and configuration paths', async () => {
		await expect(validator('/outside', [ '/outside/input.ts' ]).validateOutputDirectory()).rejects.toThrow(ConfigurationError);
		await expect(validator('/outside', [], Paths.absolute('/outside/custom.json')).validateOutputDirectory()).rejects.toThrow(ConfigurationError);
	});

	it('does not confuse sibling path prefixes with containment', async () => {
		await expect(validator('/project/src-other').validateOutputDirectory()).resolves.toBe('/project/src-other');
	});

	it('rejects output symlink aliases to the project or source directory', async () => {
		vol.symlinkSync('/project', '/project/project-alias');
		vol.symlinkSync('/project/src', '/project/source-alias');
		await expect(validator('/project/project-alias').validateOutputDirectory()).rejects.toThrow(ConfigurationError);
		await expect(validator('/project/source-alias').validateOutputDirectory()).rejects.toThrow(ConfigurationError);
	});

	it('protects canonical source targets and missing suffixes beneath symlinked parents', async () => {
		vol.symlinkSync('/outside', '/project/input-alias');
		await expect(validator('/outside', [ '/project/input-alias/input.ts' ]).validateOutputDirectory()).rejects.toThrow(ConfigurationError);
		await expect(validator('/outside/new', [ '/project/input-alias/new/input.ts' ]).validateOutputDirectory()).rejects.toThrow(ConfigurationError);
	});

	it('allows safe output aliases and canonicalizes missing child directories', async () => {
		vol.symlinkSync('/outside', '/project/output-alias');
		await expect(validator('/project/output-alias/new').validateOutputDirectory()).resolves.toBe('/outside/new');
	});

	it.each([ '../outside', 'nested/../../outside' ])('rejects declaration traversal %s', async (entryName) => {
		const instance = validator();
		const outputDirectory = await instance.validateOutputDirectory();
		await expect(instance.validateDeclarationPaths(outputDirectory, [ entryName ])).rejects.toThrow(new ConfigurationError(`Unsafe declaration output path "${entryName}" resolves outside "/project/dist". Rename the entry point or choose a dedicated output directory.`));
	});

	it('rejects declaration symlinks to outside directories, files, and the output directory itself', async () => {
		vol.symlinkSync('/outside', '/project/dist/alias');
		vol.symlinkSync('/outside/input.ts', '/project/dist/file.d.ts');
		vol.symlinkSync('/project/dist', '/project/dist/self.d.ts');
		const instance = validator();
		const outputDirectory = await instance.validateOutputDirectory();
		for (const entryName of [ 'alias/missing/entry', 'file', 'self' ]) {
			await expect(instance.validateDeclarationPaths(outputDirectory, [ entryName ])).rejects.toThrow(ConfigurationError);
		}
	});

	it('allows declaration symlinks whose targets remain inside the output directory', async () => {
		vol.mkdirSync('/project/dist/nested');
		vol.symlinkSync('/project/dist/nested', '/project/dist/alias');
		const instance = validator();
		await expect(instance.validateDeclarationPaths(await instance.validateOutputDirectory(), [ 'alias/index' ])).resolves.toBeUndefined();
	});

	it('validates declaration entries sequentially and reports the first escape', async () => {
		const instance = validator();
		const outputDirectory = await instance.validateOutputDirectory();
		const realpath = vi.spyOn(fs.promises, 'realpath');
		await expect(instance.validateDeclarationPaths(outputDirectory, [ '../first', '../second' ])).rejects.toThrow('Unsafe declaration output path "../first"');
		expect(realpath.mock.calls.some(([ path ]) => String(path).includes('second'))).toBe(false);
	});

	it('shares protected-path promises across concurrent and repeated calls but not instances', async () => {
		const realpath = vi.spyOn(fs.promises, 'realpath');
		const instance = validator();
		await Promise.all([ instance.validateOutputDirectory(), instance.validateOutputDirectory() ]);
		await instance.validateOutputDirectory();
		for (const protectedPath of [ directory, configFilePath, '/project/package.json', sourcePath ]) {
			expect(realpath.mock.calls.filter(([ path ]) => path === protectedPath)).toHaveLength(1);
		}
		expect(realpath.mock.calls.filter(([ path ]) => path === '/project/dist')).toHaveLength(3);
		await validator().validateOutputDirectory();
		expect(realpath.mock.calls.filter(([ path ]) => path === directory)).toHaveLength(2);
	});

	it('rechecks output canonicalization after symlink retargeting', async () => {
		vol.symlinkSync('/project/dist', '/project/alias');
		const instance = validator('/project/alias');
		await expect(instance.validateOutputDirectory()).resolves.toBe('/project/dist');
		vol.unlinkSync('/project/alias');
		vol.symlinkSync('/project', '/project/alias');
		await expect(instance.validateOutputDirectory()).rejects.toThrow(ConfigurationError);
	});

	it('retains rejected protected-path promises while recanonicalizing output', async () => {
		const error = Object.assign(new Error('denied'), { code: 'EACCES' });
		const realpath = vi.spyOn(fs.promises, 'realpath').mockResolvedValueOnce('/project/dist').mockRejectedValueOnce(error);
		const instance = validator();
		await expect(instance.validateOutputDirectory()).rejects.toBe(error);
		await expect(instance.validateOutputDirectory()).rejects.toBe(error);
		expect(realpath.mock.calls.filter(([ path ]) => path === directory)).toHaveLength(1);
		expect(realpath.mock.calls.filter(([ path ]) => path === '/project/dist')).toHaveLength(2);
	});

	it('does not cache output canonicalization errors or initialize protected paths after them', async () => {
		const error = Object.assign(new Error('denied'), { code: 'EACCES' });
		const realpath = vi.spyOn(fs.promises, 'realpath').mockRejectedValueOnce(error);
		const instance = validator();
		await expect(instance.validateOutputDirectory()).rejects.toBe(error);
		expect(realpath).toHaveBeenCalledTimes(1);
		await expect(instance.validateOutputDirectory()).resolves.toBe('/project/dist');
	});
});