/**
 * TypeScript API compatibility tests.
 * Verifies that all TypeScript APIs used by tsbuild at runtime
 * exist and behave as expected on the installed TypeScript version.
 * Run these tests against any candidate TS version to validate compatibility.
 */
import ts, {
	sys,
	createIncrementalProgram,
	createSourceFile,
	formatDiagnostics,
	formatDiagnosticsWithColorAndContext,
	parseJsonConfigFileContent,
	readConfigFile,
	findConfigFile,
	forEachChild,
	resolveModuleName,
	canHaveModifiers,
	getCombinedModifierFlags,
	isImportDeclaration,
	isExportDeclaration,
	isInterfaceDeclaration,
	isTypeAliasDeclaration,
	isEnumDeclaration,
	isFunctionDeclaration,
	isClassDeclaration,
	isVariableStatement,
	isModuleDeclaration,
	isNamedExports,
	isIdentifier,
	isNamespaceImport,
	isQualifiedName,
	isExportAssignment,
	isImportTypeNode,
	isLiteralTypeNode,
	isModuleBlock,
	isNamespaceExport,
	isStringLiteral,
	isEmptyStatement,
	JsxEmit,
	ScriptTarget,
	SyntaxKind,
	ModifierFlags,
	NodeFlags,
} from 'typescript';
import { describe, it, expect } from 'vitest';

describe('TypeScript API Compatibility', () => {
	describe('sys', () => {
		it('exposes getCurrentDirectory', () => {
			expect(sys.getCurrentDirectory).toBeTypeOf('function');
			expect(sys.getCurrentDirectory()).toBeTypeOf('string');
		});

		it('exposes fileExists', () => {
			expect(sys.fileExists).toBeTypeOf('function');
		});

		it('exposes readFile', () => {
			expect(sys.readFile).toBeTypeOf('function');
		});

		it('exposes newLine', () => {
			expect(sys.newLine).toBeTypeOf('string');
		});
	});

	describe('configuration APIs', () => {
		it('readConfigFile returns config or error', () => {
			expect(readConfigFile).toBeTypeOf('function');
			const result = readConfigFile('nonexistent.json', sys.readFile);
			expect(result).toHaveProperty('config');
		});

		it('findConfigFile resolves tsconfig', () => {
			expect(findConfigFile).toBeTypeOf('function');
		});

		it('parseJsonConfigFileContent parses config', () => {
			expect(parseJsonConfigFileContent).toBeTypeOf('function');
			const config = { compilerOptions: { target: 'ES2022', outDir: 'dist' } };
			const result = parseJsonConfigFileContent(config, sys, process.cwd());
			expect(result).toHaveProperty('options');
			expect(result).toHaveProperty('fileNames');
			expect(result).toHaveProperty('errors');
		});
	});

	describe('program creation', () => {
		it('createIncrementalProgram returns a builder program', () => {
			expect(createIncrementalProgram).toBeTypeOf('function');
			const program = createIncrementalProgram({ rootNames: [], options: { noEmit: true, skipLibCheck: true } });
			expect(program.emit).toBeTypeOf('function');
			expect(program.getProgram).toBeTypeOf('function');
			expect(program.getSemanticDiagnostics).toBeTypeOf('function');
		});

		it('builder program exposes getProgram with source files', () => {
			const program = createIncrementalProgram({ rootNames: [], options: { noEmit: true, skipLibCheck: true } });
			const inner = program.getProgram();
			expect(inner.getSourceFiles).toBeTypeOf('function');
			expect(inner.getRootFileNames).toBeTypeOf('function');
		});
	});

	describe('diagnostics', () => {
		it('formatDiagnostics formats an empty array', () => {
			expect(formatDiagnostics).toBeTypeOf('function');
			const host = { getNewLine: () => '\n', getCurrentDirectory: () => '.', getCanonicalFileName: (f: string) => f };
			expect(formatDiagnostics([], host)).toBe('');
		});

		it('formatDiagnosticsWithColorAndContext formats an empty array', () => {
			expect(formatDiagnosticsWithColorAndContext).toBeTypeOf('function');
			const host = { getNewLine: () => '\n', getCurrentDirectory: () => '.', getCanonicalFileName: (f: string) => f };
			expect(formatDiagnosticsWithColorAndContext([], host)).toBe('');
		});
	});

	describe('AST creation and traversal', () => {
		const source = `
import { Foo } from './foo';
export interface Bar { name: string; }
export type Baz = string;
export enum Status { Active, Inactive }
export function greet(): void {}
export class Widget {}
export const value: number = 42;
export declare module MyModule { export const x: number; }
export { Foo };
export default Widget;
`;

		it('createSourceFile returns a SourceFile with statements', () => {
			expect(createSourceFile).toBeTypeOf('function');
			const sf = createSourceFile('test.ts', source, ScriptTarget.ESNext, true);
			expect(sf.statements).toBeDefined();
			expect(sf.statements.length).toBeGreaterThan(0);
			expect(sf.fileName).toBe('test.ts');
		});

		it('forEachChild visits all top-level nodes', () => {
			expect(forEachChild).toBeTypeOf('function');
			const sf = createSourceFile('test.ts', source, ScriptTarget.ESNext, true);
			let count = 0;
			forEachChild(sf, () => { count++ });
			// forEachChild visits statements + EndOfFileToken
			expect(count).toBeGreaterThanOrEqual(sf.statements.length);
		});
	});

	describe('AST type guards', () => {
		const source = `
import { Foo } from './foo';
import type { Bar } from './bar';
import * as ns from './ns';
export interface IFoo { x: number; }
export type TFoo = string;
export enum EFoo { A }
export function fFoo(): void {}
export class CFoo {}
export const vFoo: number = 1;
export declare module MFoo {}
export { Foo };
export default CFoo;
`;
		const sf = createSourceFile('guards.ts', source, ScriptTarget.ESNext, true);
		const statements = Array.from(sf.statements);

		it('isImportDeclaration', () => {
			expect(isImportDeclaration).toBeTypeOf('function');
			expect(isImportDeclaration(statements[0])).toBe(true);
		});

		it('isNamespaceImport', () => {
			expect(isNamespaceImport).toBeTypeOf('function');
			const nsImport = statements[2];
			if (isImportDeclaration(nsImport) && nsImport.importClause?.namedBindings) {
				expect(isNamespaceImport(nsImport.importClause.namedBindings)).toBe(true);
			}
		});

		it('isInterfaceDeclaration', () => {
			expect(isInterfaceDeclaration).toBeTypeOf('function');
			expect(statements.some(isInterfaceDeclaration)).toBe(true);
		});

		it('isTypeAliasDeclaration', () => {
			expect(isTypeAliasDeclaration).toBeTypeOf('function');
			expect(statements.some(isTypeAliasDeclaration)).toBe(true);
		});

		it('isEnumDeclaration', () => {
			expect(isEnumDeclaration).toBeTypeOf('function');
			expect(statements.some(isEnumDeclaration)).toBe(true);
		});

		it('isFunctionDeclaration', () => {
			expect(isFunctionDeclaration).toBeTypeOf('function');
			expect(statements.some(isFunctionDeclaration)).toBe(true);
		});

		it('isClassDeclaration', () => {
			expect(isClassDeclaration).toBeTypeOf('function');
			expect(statements.some(isClassDeclaration)).toBe(true);
		});

		it('isVariableStatement', () => {
			expect(isVariableStatement).toBeTypeOf('function');
			expect(statements.some(isVariableStatement)).toBe(true);
		});

		it('isModuleDeclaration', () => {
			expect(isModuleDeclaration).toBeTypeOf('function');
			expect(statements.some(isModuleDeclaration)).toBe(true);
		});

		it('isExportDeclaration', () => {
			expect(isExportDeclaration).toBeTypeOf('function');
			expect(statements.some(isExportDeclaration)).toBe(true);
		});

		it('isExportAssignment', () => {
			expect(isExportAssignment).toBeTypeOf('function');
			expect(statements.some(isExportAssignment)).toBe(true);
		});

		it('isNamedExports on an export declaration', () => {
			expect(isNamedExports).toBeTypeOf('function');
			const exportDecl = statements.find(isExportDeclaration);
			expect(exportDecl).toBeDefined();
			expect(isNamedExports(exportDecl!.exportClause!)).toBe(true);
		});

		it('isIdentifier on a declaration name', () => {
			expect(isIdentifier).toBeTypeOf('function');
			const iface = statements.find(isInterfaceDeclaration);
			expect(iface).toBeDefined();
			expect(isIdentifier(iface!.name)).toBe(true);
		});

		it('isQualifiedName', () => {
			expect(isQualifiedName).toBeTypeOf('function');
			const qualifiedSource = createSourceFile('q.d.ts', 'declare const x: A.B;', ScriptTarget.ESNext, true);
			let foundQualified = false;
			const visit = (node: ts.Node): void => {
				if (isQualifiedName(node)) foundQualified = true;
				forEachChild(node, visit);
			};
			forEachChild(qualifiedSource, visit);
			expect(foundQualified).toBe(true);
		});

		it('isImportTypeNode', () => {
			expect(isImportTypeNode).toBeTypeOf('function');
			const importTypeSource = createSourceFile('it.d.ts', 'type X = import("./foo").Bar;', ScriptTarget.ESNext, true);
			let found = false;
			const visit = (node: ts.Node): void => {
				if (isImportTypeNode(node)) found = true;
				forEachChild(node, visit);
			};
			forEachChild(importTypeSource, visit);
			expect(found).toBe(true);
		});

		it('isLiteralTypeNode', () => {
			expect(isLiteralTypeNode).toBeTypeOf('function');
			const litSource = createSourceFile('lit.d.ts', 'type X = "hello";', ScriptTarget.ESNext, true);
			let found = false;
			const visit = (node: ts.Node): void => {
				if (isLiteralTypeNode(node)) found = true;
				forEachChild(node, visit);
			};
			forEachChild(litSource, visit);
			expect(found).toBe(true);
		});

		it('isModuleBlock', () => {
			expect(isModuleBlock).toBeTypeOf('function');
			const modSource = createSourceFile('mod.d.ts', 'declare module "foo" { export const x: number; }', ScriptTarget.ESNext, true);
			let found = false;
			const visit = (node: ts.Node): void => {
				if (isModuleBlock(node)) found = true;
				forEachChild(node, visit);
			};
			forEachChild(modSource, visit);
			expect(found).toBe(true);
		});

		it('isNamespaceExport', () => {
			expect(isNamespaceExport).toBeTypeOf('function');
			const nsExportSource = createSourceFile('nse.ts', 'export * as ns from "./foo";', ScriptTarget.ESNext, true);
			let found = false;
			const visit = (node: ts.Node): void => {
				if (isNamespaceExport(node)) found = true;
				forEachChild(node, visit);
			};
			forEachChild(nsExportSource, visit);
			expect(found).toBe(true);
		});

		it('isStringLiteral', () => {
			expect(isStringLiteral).toBeTypeOf('function');
			const slSource = createSourceFile('sl.ts', 'import "./foo";', ScriptTarget.ESNext, true);
			const importDecl = slSource.statements[0];
			if (isImportDeclaration(importDecl)) {
				expect(isStringLiteral(importDecl.moduleSpecifier)).toBe(true);
			}
		});

		it('isEmptyStatement', () => {
			expect(isEmptyStatement).toBeTypeOf('function');
			const emptySource = createSourceFile('empty.ts', ';', ScriptTarget.ESNext, true);
			expect(isEmptyStatement(emptySource.statements[0])).toBe(true);
		});
	});

	describe('modifier utilities', () => {
		it('canHaveModifiers checks node support', () => {
			expect(canHaveModifiers).toBeTypeOf('function');
			const sf = createSourceFile('mod.ts', 'export class Foo {}', ScriptTarget.ESNext, true);
			const classDecl = sf.statements.find(isClassDeclaration)!;
			expect(canHaveModifiers(classDecl)).toBe(true);
		});

		it('getCombinedModifierFlags returns flags', () => {
			expect(getCombinedModifierFlags).toBeTypeOf('function');
			const sf = createSourceFile('mod.ts', 'export class Foo {}', ScriptTarget.ESNext, true);
			const classDecl = sf.statements.find(isClassDeclaration)!;
			const flags = getCombinedModifierFlags(classDecl);
			expect(flags & ModifierFlags.Export).toBeTruthy();
		});
	});

	describe('module resolution', () => {
		it('resolveModuleName returns a result', () => {
			expect(resolveModuleName).toBeTypeOf('function');
			const host = { fileExists: sys.fileExists, readFile: sys.readFile };
			const result = resolveModuleName('./nonexistent', '/test.ts', {}, host);
			expect(result).toHaveProperty('resolvedModule');
		});
	});

	describe('enums', () => {
		it('ScriptTarget has required values', () => {
			expect(ScriptTarget.ES2015).toBeDefined();
			expect(ScriptTarget.ES2020).toBeDefined();
			expect(ScriptTarget.ES2022).toBeDefined();
			expect(ScriptTarget.ESNext).toBeDefined();
		});

		it('JsxEmit has required values', () => {
			expect(JsxEmit.Preserve).toBeDefined();
			expect(JsxEmit.React).toBeDefined();
			expect(JsxEmit.ReactJSX).toBeDefined();
			expect(JsxEmit.ReactJSXDev).toBeDefined();
			expect(JsxEmit.ReactNative).toBeDefined();
		});

		it('SyntaxKind has required values', () => {
			expect(SyntaxKind.ImportDeclaration).toBeDefined();
			expect(SyntaxKind.ExportDeclaration).toBeDefined();
			expect(SyntaxKind.ExportKeyword).toBeDefined();
			expect(SyntaxKind.DeclareKeyword).toBeDefined();
			expect(SyntaxKind.DefaultKeyword).toBeDefined();
		});

		it('ModifierFlags has required values', () => {
			expect(ModifierFlags.Export).toBeDefined();
			expect(ModifierFlags.Default).toBeDefined();
			expect(ModifierFlags.Ambient).toBeDefined();
		});

		it('NodeFlags has required values', () => {
			expect(NodeFlags.Const).toBeDefined();
		});
	});

	describe('compiler options', () => {
		it('recognizes all options used by compilerOptionOverrides', () => {
			const config = {
				compilerOptions: {
					noEmitOnError: true,
					allowJs: false,
					checkJs: false,
					declarationMap: false,
					skipLibCheck: true,
					preserveSymlinks: false,
					target: 'ESNext',
				},
			};
			const result = parseJsonConfigFileContent(config, sys, process.cwd());
			const unknownOptionErrors = result.errors.filter((d) => d.code === 5023);
			expect(unknownOptionErrors).toHaveLength(0);
		});

		it('recognizes options tsbuild reads from user config', () => {
			const config = {
				compilerOptions: {
					declaration: true,
					incremental: true,
					outDir: 'dist',
					noEmit: false,
					sourceMap: false,
					emitDeclarationOnly: false,
					alwaysStrict: true,
					strict: true,
					useDefineForClassFields: true,
					noImplicitOverride: true,
					paths: {},
					rootDir: './src',
					types: ['node'],
				},
			};
			const result = parseJsonConfigFileContent(config, sys, process.cwd());
			const unknownOptionErrors = result.errors.filter((d) => d.code === 5023);
			expect(unknownOptionErrors).toHaveLength(0);
		});
	});
});
