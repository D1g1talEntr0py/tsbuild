import { describe, it, expect } from 'vitest';
import { inferEntryPoints, outputToSourcePath, resolveConditionalExport, subpathToEntryName } from '../src/entry-points';
import type { PackageJson, PackageJsonConditionalExport } from '../src/entry-points';

describe('entry-points', () => {
	describe('outputToSourcePath', () => {
		it('should convert a .js output path to a .ts source path', () => {
			expect(outputToSourcePath('./dist/index.js', 'dist', 'src')).toBe('./src/index.ts');
		});

		it('should convert a .mjs output path to a .ts source path', () => {
			expect(outputToSourcePath('./dist/utils.mjs', 'dist', 'src')).toBe('./src/utils.ts');
		});

		it('should convert a .jsx output path to a .tsx source path', () => {
			expect(outputToSourcePath('./dist/app.jsx', 'dist', 'src')).toBe('./src/app.tsx');
		});

		it('should convert a .d.ts output path to a .ts source path', () => {
			expect(outputToSourcePath('./dist/types.d.ts', 'dist', 'src')).toBe('./src/types.ts');
		});

		it('should convert a .d.mts output path to a .ts source path', () => {
			expect(outputToSourcePath('./dist/types.d.mts', 'dist', 'src')).toBe('./src/types.ts');
		});

		it('should handle nested output paths', () => {
			expect(outputToSourcePath('./dist/utils/helpers.js', 'dist', 'src')).toBe('./src/utils/helpers.ts');
		});

		it('should return undefined for non-matching outDir prefix', () => {
			expect(outputToSourcePath('./build/index.js', 'dist', 'src')).toBeUndefined();
		});

		it('should return undefined for unknown file extensions', () => {
			expect(outputToSourcePath('./dist/data.json', 'dist', 'src')).toBeUndefined();
		});

		it('should handle outDir with leading ./', () => {
			expect(outputToSourcePath('./dist/index.js', './dist', 'src')).toBe('./src/index.ts');
		});

		it('should handle outDir with trailing /', () => {
			expect(outputToSourcePath('./dist/index.js', 'dist/', 'src')).toBe('./src/index.ts');
		});

		it('should handle output paths without leading ./', () => {
			expect(outputToSourcePath('dist/index.js', 'dist', 'src')).toBe('./src/index.ts');
		});

		it('should use . as source directory', () => {
			expect(outputToSourcePath('./dist/index.js', 'dist', '.')).toBe('././index.ts');
		});
	});

	describe('resolveConditionalExport', () => {
		it('should return string values directly', () => {
			expect(resolveConditionalExport('./dist/index.js')).toBe('./dist/index.js');
		});

		it('should prefer the import condition', () => {
			const conditional: PackageJsonConditionalExport = {
				import: './dist/index.mjs',
				require: './dist/index.cjs',
				default: './dist/index.js',
			};
			expect(resolveConditionalExport(conditional)).toBe('./dist/index.mjs');
		});

		it('should fall back to default when import is missing', () => {
			const conditional: PackageJsonConditionalExport = {
				require: './dist/index.cjs',
				default: './dist/index.js',
			};
			expect(resolveConditionalExport(conditional)).toBe('./dist/index.js');
		});

		it('should return undefined when no supported conditions exist', () => {
			const conditional: PackageJsonConditionalExport = {
				require: './dist/index.cjs',
				node: './dist/index.node.js',
			};
			expect(resolveConditionalExport(conditional)).toBeUndefined();
		});

		it('should return undefined for empty conditional object', () => {
			expect(resolveConditionalExport({})).toBeUndefined();
		});
	});

	describe('subpathToEntryName', () => {
		it('should return package name for root export "."', () => {
			expect(subpathToEntryName('.', 'my-pkg')).toBe('my-pkg');
		});

		it('should return "index" for root export when no package name', () => {
			expect(subpathToEntryName('.')).toBe('index');
		});

		it('should strip ./ prefix and return the name', () => {
			expect(subpathToEntryName('./foo')).toBe('foo');
		});

		it('should return the last path segment for nested subpaths', () => {
			expect(subpathToEntryName('./utils/bar')).toBe('bar');
		});

		it('should handle deeply nested subpaths', () => {
			expect(subpathToEntryName('./a/b/c/deep')).toBe('deep');
		});

		it('should handle subpath without ./ prefix', () => {
			expect(subpathToEntryName('foo')).toBe('foo');
		});
	});

	describe('inferEntryPoints', () => {
		it('should infer from simple string exports', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: './dist/index.js',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ 'my-pkg': './src/index.ts' });
		});

		it('should use "index" as name when no package name for string exports', () => {
			const pkg: PackageJson = {
				exports: './dist/index.js',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ index: './src/index.ts' });
		});

		it('should infer from subpath exports with conditional values', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: {
					'.': { import: './dist/index.js', default: './dist/index.cjs' },
					'./utils': { import: './dist/utils.js' },
				},
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({
				'my-pkg': './src/index.ts',
				utils: './src/utils.ts',
			});
		});

		it('should infer from subpath exports with string values', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: {
					'.': './dist/index.js',
					'./helpers': './dist/helpers.js',
				},
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({
				'my-pkg': './src/index.ts',
				helpers: './src/helpers.ts',
			});
		});

		it('should skip wildcard subpath patterns', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: {
					'.': './dist/index.js',
					'./*': './dist/*.js',
					'./utils/*': './dist/utils/*.js',
				},
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ 'my-pkg': './src/index.ts' });
		});

		it('should infer from string bin field', () => {
			const pkg: PackageJson = {
				name: 'my-cli',
				bin: './dist/cli.js',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ 'my-cli': './src/cli.ts' });
		});

		it('should infer from object bin field', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				bin: {
					'my-cli': './dist/cli.js',
					'my-tool': './dist/tool.js',
				},
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({
				'my-cli': './src/cli.ts',
				'my-tool': './src/tool.ts',
			});
		});

		it('should use "cli" as name for string bin when no package name', () => {
			const pkg: PackageJson = {
				bin: './dist/cli.js',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ cli: './src/cli.ts' });
		});

		it('should not override exports entries with bin entries', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: { '.': './dist/index.js' },
				bin: { 'my-pkg': './dist/bin.js' },
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			// exports provides "my-pkg", bin should not override it
			expect(result).toEqual({ 'my-pkg': './src/index.ts' });
		});

		it('should combine exports and bin entries', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: { '.': './dist/index.js' },
				bin: { cli: './dist/cli.js' },
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({
				'my-pkg': './src/index.ts',
				cli: './src/cli.ts',
			});
		});

		it('should fall back to main field', () => {
			const pkg: PackageJson = {
				main: './dist/index.js',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ index: './src/index.ts' });
		});

		it('should fall back to module field', () => {
			const pkg: PackageJson = {
				module: './dist/index.mjs',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ index: './src/index.ts' });
		});

		it('should prefer module over main', () => {
			const pkg: PackageJson = {
				main: './dist/main.js',
				module: './dist/module.js',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ index: './src/module.ts' });
		});

		it('should not use main/module fallback when exports provides entries', () => {
			const pkg: PackageJson = {
				exports: { '.': './dist/index.js' },
				main: './dist/main.js',
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ index: './src/index.ts' });
		});

		it('should return undefined when no fields are present', () => {
			const pkg: PackageJson = { name: 'empty-pkg' };
			expect(inferEntryPoints(pkg, 'dist', 'src')).toBeUndefined();
		});

		it('should return undefined when output paths cannot be reverse-mapped', () => {
			const pkg: PackageJson = {
				exports: { '.': './build/index.js' },
			};
			// outDir is 'dist' but exports points to 'build' — no match
			expect(inferEntryPoints(pkg, 'dist', 'src')).toBeUndefined();
		});

		it('should default sourceDir to src', () => {
			const pkg: PackageJson = {
				exports: './dist/index.js',
				name: 'my-pkg',
			};
			const result = inferEntryPoints(pkg, 'dist');
			expect(result).toEqual({ 'my-pkg': './src/index.ts' });
		});

		it('should skip conditional export entries that resolve to undefined', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: {
					'.': { require: './dist/index.cjs' }, // no import or default
					'./utils': { import: './dist/utils.js' },
				},
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ utils: './src/utils.ts' });
		});

		it('should handle .mjs exports', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: { '.': { import: './dist/index.mjs' } },
			};
			const result = inferEntryPoints(pkg, 'dist', 'src');
			expect(result).toEqual({ 'my-pkg': './src/index.ts' });
		});

		it('should skip string exports that cannot be reverse-mapped', () => {
			const pkg: PackageJson = {
				name: 'my-pkg',
				exports: './build/index.js', // outDir is 'dist', not 'build'
			};
			expect(inferEntryPoints(pkg, 'dist', 'src')).toBeUndefined();
		});

		it('should skip bin entries that cannot be reverse-mapped', () => {
			const pkg: PackageJson = {
				name: 'my-cli',
				bin: { cli: './build/cli.js' }, // outDir is 'dist', not 'build'
			};
			expect(inferEntryPoints(pkg, 'dist', 'src')).toBeUndefined();
		});

		it('should skip main/module that cannot be reverse-mapped', () => {
			const pkg: PackageJson = {
				main: './build/index.js', // outDir is 'dist', not 'build'
			};
			expect(inferEntryPoints(pkg, 'dist', 'src')).toBeUndefined();
		});
	});
});
