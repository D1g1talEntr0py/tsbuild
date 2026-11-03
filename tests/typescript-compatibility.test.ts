/**
 * TypeScript API compatibility tests.
 * Verifies that every TypeScript 7 native API surface tsbuild uses at runtime exists and behaves as expected
 * on the installed TypeScript version. Run these tests against any candidate TS version to validate compatibility.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { version } from 'typescript';
import { API, EmitOnly, JsxEmit, formatDiagnostics, formatDiagnosticsWithColorAndContext } from 'typescript/sync';
import {
	isClassDeclaration,
	isEmptyStatement,
	isEnumDeclaration,
	isExportAssignment,
	isExportDeclaration,
	isExportSpecifier,
	isFunctionDeclaration,
	isIdentifier,
	isImportDeclaration,
	isImportTypeNode,
	isInterfaceDeclaration,
	isLiteralTypeNode,
	isModuleBlock,
	isModuleDeclaration,
	isNamedExports,
	isNamedImports,
	isNamespaceExport,
	isNamespaceImport,
	isQualifiedName,
	isStringLiteral,
	isTypeAliasDeclaration,
	isVariableStatement,
	LanguageVariant,
	ModifierFlags,
	NodeFlags,
	ScriptTarget,
	SyntaxKind,
	type Node,
	type SourceFile
} from 'typescript/ast';
import { getCombinedModifierFlags } from 'typescript/ast/utils';
import { createScanner } from 'typescript/ast/scanner';
import { createFileSystemLayer } from 'typescript/fs';
import { toRootedDirectoryPath, toRootedFilePath } from 'typescript/path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const api = new API({ cwd: process.cwd() });
afterAll(() => api.close());

/**
 * Parses source text the same way tsbuild does: the retained handle is released while the decoded AST stays readable.
 * @param fileName - Source file name
 * @param text - Source text
 * @returns The parsed source file
 */
function parse(fileName: string, text: string): SourceFile {
	using retained = api.createSourceFile(fileName, text);

	return retained.sourceFile;
}

describe('TypeScript API Compatibility', () => {
	it('is TypeScript 7.1 or newer', () => {
		const [ major, minor ] = version.split('.').map(Number);
		expect(major > 7 || (major === 7 && minor >= 1)).toBe(true);
	});

	describe('configuration APIs', () => {
		let dir: string;

		beforeAll(async () => {
			dir = await mkdtemp(join(tmpdir(), 'tsbuild-compat-'));
			await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: [ 'index.ts' ] }));
			await writeFile(join(dir, 'index.ts'), 'export const x = 1;\n');
		});

		afterAll(() => rm(dir, { recursive: true, force: true }));

		it('readConfigFile returns the parsed config', () => {
			const result = api.readConfigFile(join(dir, 'tsconfig.json')) as { config?: { compilerOptions?: { strict?: boolean } } };
			expect(result.config?.compilerOptions?.strict).toBe(true);
		});

		it('parseJsonConfigFileContent parses config relative to the config file', () => {
			const { options, fileNames, errors } = api.parseJsonConfigFileContent({ compilerOptions: { strict: true }, files: [ 'index.ts' ] }, { configFileName: join(dir, 'tsconfig.json') });
			expect(errors).toHaveLength(0);
			expect(options.strict).toBe(true);
			expect(fileNames).toEqual([ join(dir, 'index.ts') ]);
		});
	});

	describe('snapshots and programs', () => {
		let dir: string;

		beforeAll(async () => {
			dir = await mkdtemp(join(tmpdir(), 'tsbuild-compat-'));
			await writeFile(join(dir, 'index.ts'), 'export const x: number = "oops";\n');
		});

		afterAll(() => rm(dir, { recursive: true, force: true }));

		it('type-checks, emits declarations to memory and updates incrementally', async () => {
			const file = join(dir, 'index.ts');
			const compilerOptions = { declaration: true, strict: true, skipLibCheck: true, types: [], outDir: toRootedDirectoryPath(join(dir, 'dist'), undefined), rootDir: toRootedDirectoryPath(dir, undefined) };
			using first = api.createSnapshot({ createPrograms: [ { rootFiles: [ file ], compilerOptions } ] });
			const program = first.operation.createdPrograms[0];

			const [ semantic, sourceFileNames, { outputFiles } ] = api.batch(program.getSemanticDiagnostics.gen(), program.getSourceFileNames.gen(), program.emitToString.gen(EmitOnly.OnlyDts));
			expect(semantic.map(({ code }) => code)).toContain(2322);
			expect(sourceFileNames).toContain(file);
			expect([ ...outputFiles.keys() ].some((path) => path.endsWith('index.d.ts'))).toBe(true);

			await writeFile(file, 'export const x: number = 1;\n');
			using second = first.update({ fileNotifications: { changed: [ file ] }, ensurePrograms: [ program.id ] });
			const updated = second.getProgram(program.id);
			expect(updated).toBeDefined();
			expect(updated!.getSemanticDiagnostics()).toHaveLength(0);
			expect(updated!.getSyntacticDiagnostics()).toHaveLength(0);
			expect(updated!.getProgramDiagnostics).toBeTypeOf('function');
			expect(updated!.getGlobalDiagnostics).toBeTypeOf('function');
			expect(updated!.getDeclarationDiagnostics()).toHaveLength(0);
			expect(updated!.getSourceFile(file)).toBeDefined();
		});
	});

	describe('module resolution', () => {
		it('resolves against an in-memory file system layer', () => {
			using snapshot = api.createSnapshot({ fileSystem: createFileSystemLayer([ [ '/virtual/types.d.ts', '' ] ]) });
			using resolver = api.createModuleResolver({ configFilePath: toRootedFilePath('/virtual/tsconfig.json', undefined) });
			const [ result ] = api.batch(resolver.resolveModuleName.gen('./types', toRootedDirectoryPath('/virtual', undefined), undefined, { snapshot }));
			expect(result.resolvedModule?.resolvedFileName).toBe('/virtual/types.d.ts');
		});
	});

	describe('diagnostics', () => {
		const host = { getNewLine: () => '\n', getCurrentDirectory: () => '/', getCanonicalFileName: (f: string) => f };

		it('formatDiagnostics formats an empty array', () => {
			expect(formatDiagnostics([], host)).toBe('');
		});

		it('formatDiagnosticsWithColorAndContext formats an empty array', () => {
			expect(formatDiagnosticsWithColorAndContext([], host)).toBe('');
		});
	});

	describe('AST creation and traversal', () => {
		const source = 'import { Foo } from "./foo";\nexport interface Bar { name: string; }\nexport { Foo };\n';

		it('createSourceFile returns a SourceFile with statements', () => {
			const sf = parse('/test.ts', source);
			expect(sf.statements.length).toBe(3);
			expect(sf.fileName).toBe('/test.ts');
		});

		it('forEachChild and getChildren traverse nodes', () => {
			const sf = parse('/test.ts', source);
			let count = 0;
			sf.forEachChild(() => { count++ });
			expect(count).toBeGreaterThanOrEqual(sf.statements.length);
			expect(sf.statements[0].getChildren().length).toBeGreaterThan(0);
		});

		it('createScanner tokenizes source text', () => {
			const scanner = createScanner(true, LanguageVariant.Standard, 'import "x";');
			expect(scanner.scan()).toBe(SyntaxKind.ImportKeyword);
			expect(scanner.scan()).toBe(SyntaxKind.StringLiteral);
			expect(scanner.scan()).toBe(SyntaxKind.SemicolonToken);
			expect(scanner.scan()).toBe(SyntaxKind.EndOfFile);
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
		const sf = parse('guards.ts', source);
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
			const qualifiedSource = parse('q.d.ts', 'declare const x: A.B;');
			let foundQualified = false;
			const visit = (node: Node): void => {
				if (isQualifiedName(node)) foundQualified = true;
				node.forEachChild(visit);
			};
			qualifiedSource.forEachChild(visit);
			expect(foundQualified).toBe(true);
		});

		it('isImportTypeNode', () => {
			expect(isImportTypeNode).toBeTypeOf('function');
			const importTypeSource = parse('it.d.ts', 'type X = import("./foo").Bar;');
			let found = false;
			const visit = (node: Node): void => {
				if (isImportTypeNode(node)) found = true;
				node.forEachChild(visit);
			};
			importTypeSource.forEachChild(visit);
			expect(found).toBe(true);
		});

		it('isLiteralTypeNode', () => {
			expect(isLiteralTypeNode).toBeTypeOf('function');
			const litSource = parse('lit.d.ts', 'type X = "hello";');
			let found = false;
			const visit = (node: Node): void => {
				if (isLiteralTypeNode(node)) found = true;
				node.forEachChild(visit);
			};
			litSource.forEachChild(visit);
			expect(found).toBe(true);
		});

		it('isModuleBlock', () => {
			expect(isModuleBlock).toBeTypeOf('function');
			const modSource = parse('mod.d.ts', 'declare module "foo" { export const x: number; }');
			let found = false;
			const visit = (node: Node): void => {
				if (isModuleBlock(node)) found = true;
				node.forEachChild(visit);
			};
			modSource.forEachChild(visit);
			expect(found).toBe(true);
		});

		it('isNamespaceExport', () => {
			expect(isNamespaceExport).toBeTypeOf('function');
			const nsExportSource = parse('nse.ts', 'export * as ns from "./foo";');
			let found = false;
			const visit = (node: Node): void => {
				if (isNamespaceExport(node)) found = true;
				node.forEachChild(visit);
			};
			nsExportSource.forEachChild(visit);
			expect(found).toBe(true);
		});

		it('isStringLiteral', () => {
			expect(isStringLiteral).toBeTypeOf('function');
			const slSource = parse('sl.ts', 'import "./foo";');
			const importDecl = slSource.statements[0];
			if (isImportDeclaration(importDecl)) {
				expect(isStringLiteral(importDecl.moduleSpecifier)).toBe(true);
			}
		});

		it('isEmptyStatement', () => {
			expect(isEmptyStatement).toBeTypeOf('function');
			const emptySource = parse('empty.ts', ';');
			expect(isEmptyStatement(emptySource.statements[0])).toBe(true);
		});
	});

	describe('additional guards', () => {
		const sf = parse('/more.ts', 'import { A } from "./a";\nexport { A as B };');

		it('isNamedImports', () => {
			const decl = sf.statements[0];
			expect(isImportDeclaration(decl) && decl.importClause?.namedBindings !== undefined && isNamedImports(decl.importClause.namedBindings)).toBe(true);
		});

		it('isExportSpecifier', () => {
			const decl = sf.statements[1];
			expect(isExportDeclaration(decl) && decl.exportClause !== undefined && isNamedExports(decl.exportClause) && isExportSpecifier(decl.exportClause.elements[0])).toBe(true);
		});
	});

	describe('modifier utilities', () => {
		it('getCombinedModifierFlags returns export flags', () => {
			const classDecl = parse('/mod.ts', 'export default class Foo {}').statements.find(isClassDeclaration)!;
			const flags = getCombinedModifierFlags(classDecl);
			expect(flags & ModifierFlags.Export).toBeTruthy();
			expect(flags & ModifierFlags.ExportDefault).toBe(ModifierFlags.ExportDefault);
		});
	});

	describe('enums', () => {
		it('ScriptTarget has required values', () => {
			expect(ScriptTarget.ESNext).toBeDefined();
			expect(ScriptTarget.JSON).toBeDefined();
			expect(ScriptTarget.ES2015).toBeDefined();
		});

		it('JsxEmit has required values', () => {
			for (const kind of [ JsxEmit.None, JsxEmit.Preserve, JsxEmit.React, JsxEmit.ReactJSX, JsxEmit.ReactJSXDev, JsxEmit.ReactNative ]) {
				expect(kind).toBeTypeOf('number');
			}
		});

		it('SyntaxKind has required punctuation bounds', () => {
			expect(SyntaxKind.FirstPunctuation).toBeLessThan(SyntaxKind.LastPunctuation);
		});

		it('NodeFlags has required values', () => {
			expect(NodeFlags.Const).toBeDefined();
			expect(NodeFlags.Let).toBeDefined();
		});
	});

	describe('compiler options', () => {
		it('recognizes options used by compilerOptionOverrides and read from user config', () => {
			const { errors } = api.parseJsonConfigFileContent({
				compilerOptions: {
					noEmitOnError: true, allowJs: false, checkJs: false, declarationMap: false, skipLibCheck: true, preserveSymlinks: false, target: 'ESNext',
					declaration: true, incremental: true, outDir: 'dist', noEmit: false, sourceMap: false, emitDeclarationOnly: false, strict: true,
					useDefineForClassFields: true, noImplicitOverride: true, paths: {}, rootDir: './src', types: [ 'node' ]
				},
				files: []
			}, { configDirectory: process.cwd() });
			expect(errors.filter(({ code }) => code === 5023)).toHaveLength(0);
		});
	});
});
