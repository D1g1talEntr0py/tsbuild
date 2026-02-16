import { describe, it, expect } from 'vitest';
import { ScriptTarget } from 'typescript';
import {
	Package,
	Platform,
	BuildMessageType,
	DependencyEntryType,
	NodeType,
	FileExtension,
	format,
	newLine,
	sourceScriptExtensionExpression,
	typeScriptExtensionExpression,
	processEnvExpansionPattern,
	inlineTypePattern,
	dataUnits,
	compilerOptionOverrides,
	Encoding,
	defaultDirOptions,
	defaultSourceDirectory,
	typeMatcher,
	toEsTarget,
} from '../src/constants';

describe('Constants', () => {
	describe('Package', () => {
		it('should define BUNDLE as "bundle"', () => {
			expect(Package.BUNDLE).toBe('bundle');
		});

		it('should define EXTERNAL as "external"', () => {
			expect(Package.EXTERNAL).toBe('external');
		});
	});

	describe('Platform', () => {
		it('should define NODE as "node"', () => {
			expect(Platform.NODE).toBe('node');
		});

		it('should define BROWSER as "browser"', () => {
			expect(Platform.BROWSER).toBe('browser');
		});

		it('should define NEUTRAL as "neutral"', () => {
			expect(Platform.NEUTRAL).toBe('neutral');
		});
	});

	describe('BuildMessageType', () => {
		it('should define ERROR as "error"', () => {
			expect(BuildMessageType.ERROR).toBe('error');
		});

		it('should define WARNING as "warning"', () => {
			expect(BuildMessageType.WARNING).toBe('warning');
		});
	});

	describe('DependencyEntryType', () => {
		it('should define DEPENDENCIES as "dependencies"', () => {
			expect(DependencyEntryType.DEPENDENCIES).toBe('dependencies');
		});

		it('should define PEER_DEPENDENCIES as "peerDependencies"', () => {
			expect(DependencyEntryType.PEER_DEPENDENCIES).toBe('peerDependencies');
		});
	});

	describe('NodeType', () => {
		it('should define Program as "Program"', () => {
			expect(NodeType.Program).toBe('Program');
		});

		it('should define Identifier as "Identifier"', () => {
			expect(NodeType.Identifier).toBe('Identifier');
		});

		it('should define ImportDeclaration as "ImportDeclaration"', () => {
			expect(NodeType.ImportDeclaration).toBe('ImportDeclaration');
		});

		it('should define ExportNamedDeclaration as "ExportNamedDeclaration"', () => {
			expect(NodeType.ExportNamedDeclaration).toBe('ExportNamedDeclaration');
		});

		it('should define FunctionDeclaration as "FunctionDeclaration"', () => {
			expect(NodeType.FunctionDeclaration).toBe('FunctionDeclaration');
		});
	});

	describe('FileExtension', () => {
		it('should define JS as ".js"', () => {
			expect(FileExtension.JS).toBe('.js');
		});

		it('should define DTS as ".d.ts"', () => {
			expect(FileExtension.DTS).toBe('.d.ts');
		});

		it('should define CSS as ".css"', () => {
			expect(FileExtension.CSS).toBe('.css');
		});

		it('should define JSON as ".json"', () => {
			expect(FileExtension.JSON).toBe('.json');
		});
	});

	describe('format', () => {
		it('should be "esm"', () => {
			expect(format).toBe('esm');
		});
	});

	describe('newLine', () => {
		it('should be a line feed character', () => {
			expect(newLine).toBe('\n');
		});
	});

	describe('sourceScriptExtensionExpression', () => {
		it('should match .js files', () => {
			expect(sourceScriptExtensionExpression.test('.js')).toBe(true);
			expect(sourceScriptExtensionExpression.test('file.js')).toBe(true);
		});

		it('should match .ts files', () => {
			expect(sourceScriptExtensionExpression.test('.ts')).toBe(true);
			expect(sourceScriptExtensionExpression.test('file.ts')).toBe(true);
		});

		it('should match .jsx files', () => {
			expect(sourceScriptExtensionExpression.test('.jsx')).toBe(true);
			expect(sourceScriptExtensionExpression.test('file.jsx')).toBe(true);
		});

		it('should match .tsx files', () => {
			expect(sourceScriptExtensionExpression.test('.tsx')).toBe(true);
			expect(sourceScriptExtensionExpression.test('file.tsx')).toBe(true);
		});

		it('should not match .css files', () => {
			expect(sourceScriptExtensionExpression.test('.css')).toBe(false);
			expect(sourceScriptExtensionExpression.test('file.css')).toBe(false);
		});

		it('should not match .json files', () => {
			expect(sourceScriptExtensionExpression.test('.json')).toBe(false);
			expect(sourceScriptExtensionExpression.test('file.json')).toBe(false);
		});
	});

	describe('typeScriptExtensionExpression', () => {
		it('should match .ts files', () => {
			expect(typeScriptExtensionExpression.test('.ts')).toBe(true);
			expect(typeScriptExtensionExpression.test('file.ts')).toBe(true);
		});

		it('should match .tsx files', () => {
			expect(typeScriptExtensionExpression.test('.tsx')).toBe(true);
			expect(typeScriptExtensionExpression.test('file.tsx')).toBe(true);
		});

		it('should not match .js files', () => {
			expect(typeScriptExtensionExpression.test('.js')).toBe(false);
			expect(typeScriptExtensionExpression.test('file.js')).toBe(false);
		});

		it('should not match .jsx files', () => {
			expect(typeScriptExtensionExpression.test('.jsx')).toBe(false);
			expect(typeScriptExtensionExpression.test('file.jsx')).toBe(false);
		});
	});

	describe('dataUnits', () => {
		it('should contain correct units', () => {
			expect(dataUnits).toEqual(['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']);
		});
	});

	describe('compilerOptionOverrides', () => {
		it('should have correct overrides', () => {
			expect(compilerOptionOverrides).toEqual({
				noEmitOnError: true,
				allowJs: false,
				checkJs: false,
				declarationMap: false,
				skipLibCheck: true,
				preserveSymlinks: false,
				target: ScriptTarget.ESNext,
			});
		});
	});

	describe('Encoding', () => {
		it('should define utf8', () => {
			expect(Encoding.utf8).toBe('utf8');
		});

		it('should define base64', () => {
			expect(Encoding.base64).toBe('base64');
		});
	});

	describe('defaultDirOptions', () => {
		it('should be recursive', () => {
			expect(defaultDirOptions).toEqual({ recursive: true });
		});
	});

	describe('defaultSourceDirectory', () => {
		it('should be ./src', () => {
			expect(defaultSourceDirectory).toBe('./src');
		});
	});

	describe('typeMatcher', () => {
		it('should match "type" word boundary', () => {
			expect(typeMatcher.test('type')).toBe(true);
			expect(typeMatcher.test(' type ')).toBe(true);
			expect(typeMatcher.test('prototype')).toBe(false);
		});
	});

	describe('processEnvExpansionPattern', () => {
		it('should match process.env variable references', () => {
			processEnvExpansionPattern.lastIndex = 0;
			expect(processEnvExpansionPattern.test('${process.env.NODE_ENV}')).toBe(true);
		});

		it('should capture the variable name', () => {
			processEnvExpansionPattern.lastIndex = 0;
			const match = processEnvExpansionPattern.exec('${process.env.npm_package_version}');
			expect(match).not.toBeNull();
			expect(match![1]).toBe('npm_package_version');
		});

		it('should match multiple occurrences', () => {
			processEnvExpansionPattern.lastIndex = 0;
			const text = 'v${process.env.VERSION}-${process.env.BUILD}';
			const matches: string[] = [];
			let match;
			while ((match = processEnvExpansionPattern.exec(text)) !== null) {
				matches.push(match[1]);
			}
			expect(matches).toEqual(['VERSION', 'BUILD']);
		});

		it('should not match invalid syntax', () => {
			processEnvExpansionPattern.lastIndex = 0;
			expect(processEnvExpansionPattern.test('$process.env.NODE_ENV')).toBe(false);
			processEnvExpansionPattern.lastIndex = 0;
			expect(processEnvExpansionPattern.test('${NODE_ENV}')).toBe(false);
		});
	});

	describe('inlineTypePattern', () => {
		it('should match inline type specifiers after brace', () => {
			inlineTypePattern.lastIndex = 0;
			expect(inlineTypePattern.test('{ type ')).toBe(true);
		});

		it('should match inline type specifiers after comma', () => {
			inlineTypePattern.lastIndex = 0;
			expect(inlineTypePattern.test(', type ')).toBe(true);
		});

		it('should capture the prefix', () => {
			inlineTypePattern.lastIndex = 0;
			const match = inlineTypePattern.exec('{ type Foo');
			expect(match).not.toBeNull();
			expect(match![1]).toBe('{ ');
		});

		it('should match multiple inline type specifiers', () => {
			inlineTypePattern.lastIndex = 0;
			const text = 'import { foo, type Bar, type Baz } from "module"';
			const matches: string[] = [];
			let match;
			while ((match = inlineTypePattern.exec(text)) !== null) {
				matches.push(match[1]);
			}
			expect(matches).toEqual([', ', ', ']);
		});
	});

	describe('toEsTarget', () => {
		it('should convert ES3 and ES5 to ES6 (esbuild minimum)', () => {
			expect(toEsTarget(ScriptTarget.ES3)).toBe('ES6');
			expect(toEsTarget(ScriptTarget.ES5)).toBe('ES6');
		});

		it('should convert ES2015+ to corresponding ES target', () => {
			expect(toEsTarget(ScriptTarget.ES2015)).toBe('ES2015');
			expect(toEsTarget(ScriptTarget.ES2016)).toBe('ES2016');
			expect(toEsTarget(ScriptTarget.ES2017)).toBe('ES2017');
			expect(toEsTarget(ScriptTarget.ES2018)).toBe('ES2018');
			expect(toEsTarget(ScriptTarget.ES2019)).toBe('ES2019');
			expect(toEsTarget(ScriptTarget.ES2020)).toBe('ES2020');
			expect(toEsTarget(ScriptTarget.ES2021)).toBe('ES2021');
			expect(toEsTarget(ScriptTarget.ES2022)).toBe('ES2022');
			expect(toEsTarget(ScriptTarget.ES2023)).toBe('ES2023');
			expect(toEsTarget(ScriptTarget.ES2024)).toBe('ES2024');
		});

		it('should convert ESNext to ESNext', () => {
			expect(toEsTarget(ScriptTarget.ESNext)).toBe('ESNext');
		});

		it('should convert JSON target to ESNext', () => {
			expect(toEsTarget(ScriptTarget.JSON)).toBe('ESNext');
		});
	});
});
