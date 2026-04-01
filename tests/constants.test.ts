import { describe, it, expect } from 'vitest';
import { ScriptTarget, JsxEmit } from 'typescript';
import {
	dataUnits, compilerOptionOverrides, Package, Platform, BuildMessageType,
	DependencyEntryType, sourceScriptExtensionExpression, typeScriptExtensionExpression,
	processEnvExpansionPattern, inlineTypePattern, Encoding, defaultDirOptions,
	defaultCleanOptions, defaultSourceDirectory, defaultOutDirectory, defaultEntryPoint,
	defaultEntryFile, cacheDirectory, buildInfoFile, dtsCacheFile, dtsCacheVersion,
	format, newLine, typeMatcher, FileExtension, toEsTarget, toJsxRenderingMode
} from 'src/constants';

describe('constants', () => {
	describe('toEsTarget', () => {
		const targetMatrix: [ScriptTarget, string][] = [
			[ScriptTarget.ES3, 'ES6'],
			[ScriptTarget.ES5, 'ES6'],
			[ScriptTarget.ES2015, 'ES2015'],
			[ScriptTarget.ES2016, 'ES2016'],
			[ScriptTarget.ES2017, 'ES2017'],
			[ScriptTarget.ES2018, 'ES2018'],
			[ScriptTarget.ES2019, 'ES2019'],
			[ScriptTarget.ES2020, 'ES2020'],
			[ScriptTarget.ES2021, 'ES2021'],
			[ScriptTarget.ES2022, 'ES2022'],
			[ScriptTarget.ES2023, 'ES2023'],
			// ES2024+ may not exist in older TypeScript versions
			...(ScriptTarget.ES2024 !== undefined ? [[ScriptTarget.ES2024, 'ES2024'] as [ScriptTarget, string]] : []),
			...(ScriptTarget.ES2025 !== undefined ? [[ScriptTarget.ES2025, 'ES2025'] as [ScriptTarget, string]] : []),
			[ScriptTarget.ESNext, 'ESNext'],
			[ScriptTarget.JSON, 'ESNext'],
		];

		it.each(targetMatrix)('maps ScriptTarget %i to %s', (target, expected) => {
			expect(toEsTarget(target)).toBe(expected);
		});
	});

	describe('toJsxRenderingMode', () => {
		const jsxMatrix: [JsxEmit, string | undefined][] = [
			[JsxEmit.Preserve, 'preserve'],
			[JsxEmit.React, 'react'],
			[JsxEmit.ReactNative, 'react-native'],
			[JsxEmit.ReactJSX, 'react-jsx'],
			[JsxEmit.ReactJSXDev, 'react-jsxdev'],
			[JsxEmit.None, undefined],
		];

		it.each(jsxMatrix)('maps JsxEmit %i to %s', (jsxEmit, expected) => {
			expect(toJsxRenderingMode(jsxEmit)).toBe(expected);
		});

		it('returns undefined when jsxEmit is undefined', () => {
			expect(toJsxRenderingMode(undefined)).toBeUndefined();
		});
	});

	describe('sourceScriptExtensionExpression', () => {
		const matchMatrix: [string, boolean][] = [
			['file.ts', true],
			['file.tsx', true],
			['file.js', true],
			['file.jsx', true],
			['file.d.ts', false],
			['file.css', false],
			['file.json', false],
			['file.d.tsx', false],
		];

		it.each(matchMatrix)('%s → %s', (input, expected) => {
			expect(sourceScriptExtensionExpression.test(input)).toBe(expected);
		});
	});

	describe('typeScriptExtensionExpression', () => {
		const matchMatrix: [string, boolean][] = [
			['file.ts', true],
			['file.tsx', true],
			['file.js', false],
			['file.d.ts', true],
			['file.css', false],
		];

		it.each(matchMatrix)('%s → %s', (input, expected) => {
			expect(typeScriptExtensionExpression.test(input)).toBe(expected);
		});
	});

	describe('processEnvExpansionPattern', () => {
		it('matches ${process.env.VAR} pattern', () => {
			const match = '${process.env.npm_package_version}'.match(processEnvExpansionPattern);
			expect(match).not.toBeNull();
		});

		it('captures variable name', () => {
			const result = processEnvExpansionPattern.exec('${process.env.MY_VAR}');
			expect(result?.[1]).toBe('MY_VAR');
		});

		it('does not match invalid patterns', () => {
			expect(processEnvExpansionPattern.test('${env.VAR}')).toBe(false);
		});
	});

	describe('inlineTypePattern', () => {
		it('matches inline type specifiers', () => {
			const input = '{ type Foo, Bar }';
			expect(inlineTypePattern.test(input)).toBe(true);
		});

		it('matches after comma', () => {
			const input = ', type Baz';
			expect(inlineTypePattern.test(input)).toBe(true);
		});
	});

	describe('typeMatcher', () => {
		it('matches word "type"', () => {
			expect(typeMatcher.test('import type { Foo }')).toBe(true);
		});

		it('does not match "type" within words', () => {
			expect(typeMatcher.test('prototype')).toBe(false);
		});
	});

	describe('static values', () => {
		it('exports correct package constants', () => {
			expect(Package.BUNDLE).toBe('bundle');
			expect(Package.EXTERNAL).toBe('external');
		});

		it('exports correct platform constants', () => {
			expect(Platform.NODE).toBe('node');
			expect(Platform.BROWSER).toBe('browser');
			expect(Platform.NEUTRAL).toBe('neutral');
		});

		it('exports correct build message types', () => {
			expect(BuildMessageType.ERROR).toBe('error');
			expect(BuildMessageType.WARNING).toBe('warning');
		});

		it('exports correct dependency entry types', () => {
			expect(DependencyEntryType.DEPENDENCIES).toBe('dependencies');
			expect(DependencyEntryType.PEER_DEPENDENCIES).toBe('peerDependencies');
		});

		it('exports correct file extensions', () => {
			expect(FileExtension.JS).toBe('.js');
			expect(FileExtension.DTS).toBe('.d.ts');
			expect(FileExtension.CSS).toBe('.css');
			expect(FileExtension.JSON).toBe('.json');
		});

		it('exports correct encoding values', () => {
			expect(Encoding.utf8).toBe('utf8');
			expect(Encoding.base64).toBe('base64');
		});

		it('exports correct default values', () => {
			expect(defaultDirOptions).toEqual({ recursive: true });
			expect(defaultCleanOptions).toEqual({ recursive: true, force: true });
			expect(defaultOutDirectory).toBe('dist');
			expect(defaultEntryPoint).toBe('index');
			expect(defaultSourceDirectory).toBe('./src');
			expect(defaultEntryFile).toBe('src/index.ts');
			expect(cacheDirectory).toBe('.tsbuild');
			expect(buildInfoFile).toBe('tsconfig.tsbuildinfo');
			expect(dtsCacheFile).toBe('dts_cache.v8.br');
			expect(dtsCacheVersion).toBe(2);
			expect(format).toBe('esm');
			expect(newLine).toBe('\n');
		});

		it('exports dataUnits array', () => {
			expect(dataUnits).toEqual(['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']);
		});

		it('exports compilerOptionOverrides with required properties', () => {
			expect(compilerOptionOverrides.noEmitOnError).toBe(true);
			expect(compilerOptionOverrides.allowJs).toBe(false);
			expect(compilerOptionOverrides.checkJs).toBe(false);
			expect(compilerOptionOverrides.declarationMap).toBe(false);
			expect(compilerOptionOverrides.skipLibCheck).toBe(true);
			expect(compilerOptionOverrides.preserveSymlinks).toBe(false);
			expect(compilerOptionOverrides.target).toBe(ScriptTarget.ESNext);
		});
	});
});
