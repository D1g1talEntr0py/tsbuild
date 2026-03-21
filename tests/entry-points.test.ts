import { describe, it, expect } from 'vitest';
import { inferEntryPoints, outputToSourcePath, resolveConditionalExport, subpathToEntryName } from 'src/entry-points';
import type { PackageJson } from 'src/entry-points';

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
