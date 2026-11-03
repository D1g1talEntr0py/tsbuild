import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { vol } from 'memfs';
import { inferEntryPoints, normalizeEntryPoints, outputToSourcePath, resolveConditionalExport, resolveEntryPoints, subpathToEntryName } from 'src/entry-points';
import { Files } from 'src/files';
import { Paths } from 'src/paths';
import { ConfigurationError } from 'src/errors';
import type { PackageJson } from 'src/entry-points';
import type { RelativePath } from '../src/@types';

vi.mock('node:fs', async () => (await import('memfs')).fs);
vi.mock('node:fs/promises', async () => (await import('memfs')).fs.promises);

const relativePath = (path: string): RelativePath => path as RelativePath;

describe('resolveEntryPoints', () => {
	const directory = Paths.absolute('/project');

	beforeEach(() => {
		vol.fromJSON({ '/project/src/index.ts': '', '/project/src/index.js': '', '/project/src/data.json': '', '/project/src/nested/child.ts': '', '/project/other.ts': '' });
	});

	afterEach(() => { vol.reset() });

	it('resolves relative and absolute files in configured key order', async () => {
		const entries = { custom: './src/index.ts', other: '/project/other.ts' };
		const result = await resolveEntryPoints(directory, entries);
		expect(result).toEqual({ custom: '/project/src/index.ts', other: '/project/other.ts' });
		expect(Object.keys(result)).toEqual([ 'custom', 'other' ]);
		expect(entries.custom).toBe('./src/index.ts');
	});

	it('expands files with deterministic precedence for colliding stems', async () => {
		vi.spyOn(Files, 'readDirectory').mockResolvedValueOnce([ 'index.ts', 'index.js', 'data.json' ]);
		expect(await resolveEntryPoints(directory, { ignored: './src' })).toEqual({ data: '/project/src/data.json', index: '/project/src/index.ts' });
	});

	it.each([ './src/index.ts', './src' ])('checks the configured path %s only once', async (entryPoint) => {
		const fsp = await import('node:fs/promises');
		const lstatSpy = vi.spyOn(fsp, 'lstat');

		try {
			await resolveEntryPoints(directory, { entry: entryPoint });
			expect(lstatSpy.mock.calls.filter(([path]) => path === Paths.absolute(directory, entryPoint))).toHaveLength(1);
		} finally {
			lstatSpy.mockRestore();
		}
	});

	it('checks a missing configured path only once', async () => {
		const fsp = await import('node:fs/promises');
		const lstatSpy = vi.spyOn(fsp, 'lstat');

		try {
			await expect(resolveEntryPoints(directory, { entry: './missing.ts' })).rejects.toThrow(ConfigurationError);
			expect(lstatSpy).toHaveBeenCalledExactlyOnceWith('/project/missing.ts');
		} finally {
			lstatSpy.mockRestore();
		}
	});

	it.each([ '/project/src/index.ts', '/project/src', '/project/missing' ])('rejects symbolic links to %s', async (target) => {
		vol.symlinkSync(target, '/project/link');
		await expect(resolveEntryPoints(directory, { entry: './link' })).rejects.toThrow(ConfigurationError);
	});

	it('propagates filesystem errors from configured paths', async () => {
		const fsp = await import('node:fs/promises');
		const error = Object.assign(new Error('EACCES'), { code: 'EACCES' });
		const lstatSpy = vi.spyOn(fsp, 'lstat').mockRejectedValueOnce(error);

		try {
			await expect(resolveEntryPoints(directory, { entry: './src/index.ts' })).rejects.toBe(error);
		} finally {
			lstatSpy.mockRestore();
		}
	});

	it('overwrites collisions in configured iteration order without moving the key', async () => {
		const result = await resolveEntryPoints(directory, { expanded: './src', index: './other.ts' });
		expect(result).toEqual({ data: '/project/src/data.json', index: '/project/other.ts', 'nested/child': '/project/src/nested/child.ts' });
		expect(Object.keys(result)).toEqual([ 'data', 'index', 'nested/child' ]);
		expect(await resolveEntryPoints(directory, { index: './other.ts', expanded: './src' })).toEqual({ index: '/project/src/index.ts', data: '/project/src/data.json', 'nested/child': '/project/src/nested/child.ts' });
	});

	it('expands nested directories recursively with names that preserve the directory structure', async () => {
		vol.fromJSON({ '/project/lib/index.ts': '', '/project/lib/internal/helper.ts': '', '/project/lib/internal/deep/util.ts': '', '/project/lib/internal/deep/util.js': '' });
		const result = await resolveEntryPoints(directory, { lib: './lib' });

		expect(result).toEqual({ index: '/project/lib/index.ts', 'internal/deep/util': '/project/lib/internal/deep/util.ts', 'internal/helper': '/project/lib/internal/helper.ts' });
		expect(Object.keys(result)).toEqual([ 'index', 'internal/deep/util', 'internal/helper' ]);
	});

	it('does not follow symbolic links inside expanded directories', async () => {
		vol.fromJSON({ '/project/lib/index.ts': '', '/outside/secret.ts': '' });
		vol.symlinkSync('/outside', '/project/lib/linked-directory');
		vol.symlinkSync('/outside/secret.ts', '/project/lib/linked-file.ts');

		expect(await resolveEntryPoints(directory, { lib: './lib' })).toEqual({ index: '/project/lib/index.ts' });
	});

	it('rejects asynchronously with the first missing configured path', async () => {
		const result = resolveEntryPoints(directory, { first: './missing.ts', second: './also-missing.ts' });
		expect(result).toBeInstanceOf(Promise);
		await expect(result).rejects.toThrow(new ConfigurationError('Entry point does not exist: ./missing.ts. Add explicit entryPoints to your tsconfig.json tsbuild configuration.'));
	});

	it('returns empty maps for empty configuration or directories', async () => {
		vol.mkdirSync('/project/empty');
		expect(await resolveEntryPoints(directory, {})).toEqual({});
		expect(await resolveEntryPoints(directory, { empty: './empty' })).toEqual({});
	});
});

describe('outputToSourcePath', () => {
	const conversionMatrix: [string, string, string, string | undefined][] = [
		['./dist/index.js',   'dist', 'src', './src/index.ts'],
		['./dist/cli.js',     'dist', 'src', './src/cli.ts'],
		['./dist/index.jsx',  'dist', 'src', './src/index.tsx'],
		['./dist/index.d.ts', 'dist', 'src', './src/index.ts'],
		['dist/utils.js',     'dist', 'src', './src/utils.ts'],
		['./build/index.js',  'build', 'lib', './lib/index.ts'],
		['./dist/sub/deep.js', 'dist', 'src', './src/sub/deep.ts'],
	];

	it.each(conversionMatrix)('converts %s → %s', (outputPath, outDir, sourceDir, expected) => {
		expect(outputToSourcePath(outputPath, outDir, sourceDir)).toBe(expected);
	});

	it('returns undefined for non-matching outDir', () => {
		expect(outputToSourcePath('./other/index.js', 'dist', 'src')).toBeUndefined();
	});

	it('returns undefined for unsupported extension', () => {
		expect(outputToSourcePath('./dist/styles.css', 'dist', 'src')).toBeUndefined();
	});

	it('handles outDir with leading ./', () => {
		expect(outputToSourcePath('./dist/index.js', './dist', 'src')).toBe('./src/index.ts');
	});

	it('handles outDir with trailing /', () => {
		expect(outputToSourcePath('./dist/index.js', 'dist/', 'src')).toBe('./src/index.ts');
	});
});

describe('resolveConditionalExport', () => {
	it('returns string directly', () => {
		expect(resolveConditionalExport('./dist/index.js')).toBe('./dist/index.js');
	});

	it('resolves import condition first', () => {
		expect(resolveConditionalExport({
			import: './dist/index.mjs',
			require: './dist/index.cjs',
			default: './dist/index.js',
		})).toBe('./dist/index.mjs');
	});

	it('falls back to node condition', () => {
		expect(resolveConditionalExport({
			node: './dist/index.node.js',
			default: './dist/index.js',
		})).toBe('./dist/index.node.js');
	});

	it('falls back to module condition', () => {
		expect(resolveConditionalExport({
			module: './dist/index.mjs',
			default: './dist/index.js',
		})).toBe('./dist/index.mjs');
	});

	it('falls back to default condition', () => {
		expect(resolveConditionalExport({
			default: './dist/index.js',
		})).toBe('./dist/index.js');
	});

	it('resolves nested conditions recursively', () => {
		expect(resolveConditionalExport({
			node: { import: './dist/index.mjs', require: './dist/index.cjs' },
		})).toBe('./dist/index.mjs');
	});

	it('returns undefined when no condition matches', () => {
		expect(resolveConditionalExport({
			require: './dist/index.cjs',
		})).toBeUndefined();
	});

	it('skips undefined values', () => {
		expect(resolveConditionalExport({
			import: undefined,
			default: './dist/index.js',
		})).toBe('./dist/index.js');
	});

	it('resolves the first usable array target', () => {
		expect(resolveConditionalExport([null, './dist/index.js'])).toBe('./dist/index.js');
	});
});

describe('subpathToEntryName', () => {
	const nameMatrix: [string, string | undefined, string][] = [
		['.',        'my-package',    'my-package'],
		['.',        '@scope/pkg',    'pkg'],
		['.',        undefined,       'index'],
		['./utils',  undefined,       'utils'],
		['./lib/helper', undefined,   'helper'],
		['./foo',    'my-package',    'foo'],
	];

	it.each(nameMatrix)('subpath %s with name %s → %s', (subpath, packageName, expected) => {
		expect(subpathToEntryName(subpath, packageName)).toBe(expected);
	});
});

describe('normalizeEntryPoints', () => {
	it('uses source filename stems for array entries', () => {
		expect(normalizeEntryPoints([relativePath('./src/index.ts'), relativePath('./src/cli.ts')])).toEqual({
			index: './src/index.ts',
			cli: './src/cli.ts'
		});
	});

	it('preserves object entry point names', () => {
		expect(normalizeEntryPoints({ main: relativePath('./src/index.ts') })).toEqual({ main: './src/index.ts' });
	});

	it('rejects duplicate source filename stems', () => {
		expect(() => normalizeEntryPoints([relativePath('./src/first/index.ts'), relativePath('./src/second/index.ts')])).toThrow('Duplicate entry point stem: index');
	});
});

describe('inferEntryPoints', () => {
	it('infers from string exports', () => {
		const pkg: PackageJson = { exports: './dist/index.js' };
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/index.ts' });
	});

	it('infers from object exports with root subpath', () => {
		const pkg: PackageJson = {
			name: 'my-pkg',
			exports: { '.': './dist/index.js' },
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/index.ts' });
	});

	it('infers from object exports with multiple subpaths', () => {
		const pkg: PackageJson = {
			name: 'my-pkg',
			exports: {
				'.': './dist/index.js',
				'./utils': './dist/utils.js',
			},
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({
			index: './src/index.ts',
			utils: './src/utils.ts',
		});
	});

	it('infers from conditional exports', () => {
		const pkg: PackageJson = {
			exports: { '.': { import: './dist/index.js', default: './dist/index.cjs' } },
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/index.ts' });
	});

	it('infers from root conditional exports', () => {
		const pkg: PackageJson = {
			exports: { import: './dist/index.js', require: './dist/index.cjs' },
		};
		expect(inferEntryPoints(pkg, 'dist')).toEqual({ index: './src/index.ts' });
	});

	it('skips wildcard subpath patterns', () => {
		const pkg: PackageJson = {
			exports: { '.': './dist/index.js', './*': './dist/*.js' },
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/index.ts' });
	});

	it('infers from bin string', () => {
		const pkg: PackageJson = {
			name: 'cli-tool',
			bin: './dist/cli.js',
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ 'cli-tool': './src/cli.ts' });
	});

	it('infers from bin object', () => {
		const pkg: PackageJson = {
			bin: { mycli: './dist/cli.js', myother: './dist/other.js' },
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({
			mycli: './src/cli.ts',
			myother: './src/other.ts',
		});
	});

	it('uses package name for bin string when no name', () => {
		const pkg: PackageJson = { bin: './dist/cli.js' };
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ cli: './src/cli.ts' });
	});

	it('does not duplicate entries from bin when exports already has them', () => {
		const pkg: PackageJson = {
			exports: { '.': './dist/index.js' },
			bin: { index: './dist/index.js' },
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/index.ts' });
	});

	it('infers from main when no exports or bin', () => {
		const pkg: PackageJson = { main: './dist/index.js' };
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/index.ts' });
	});

	it('infers from module when no exports, bin, or main', () => {
		const pkg: PackageJson = { module: './dist/index.js' };
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/index.ts' });
	});

	it('prefers module over main', () => {
		const pkg: PackageJson = {
			main: './dist/main.js',
			module: './dist/module.js',
		};
		const result = inferEntryPoints(pkg, 'dist');
		expect(result).toEqual({ index: './src/module.ts' });
	});

	it('returns undefined for empty package', () => {
		expect(inferEntryPoints({}, 'dist')).toBeUndefined();
	});

	it('returns undefined when no paths can be resolved', () => {
		const pkg: PackageJson = { exports: { '.': './lib/index.js' } };
		expect(inferEntryPoints(pkg, 'dist')).toBeUndefined();
	});

	it('uses custom sourceDir', () => {
		const pkg: PackageJson = { exports: './dist/index.js' };
		const result = inferEntryPoints(pkg, 'dist', 'lib');
		expect(result).toEqual({ index: './lib/index.ts' });
	});

	it('handles exports with no resolvable condition', () => {
		const pkg: PackageJson = {
			exports: { '.': { require: './dist/index.cjs' } },
		};
		expect(inferEntryPoints(pkg, 'dist')).toBeUndefined();
	});
});
