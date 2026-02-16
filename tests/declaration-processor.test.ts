import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { DeclarationProcessor } from '../src/dts/declaration-processor';
import { UnsupportedSyntaxError } from '../src/errors';

const createMockSourceFile = (text: string): ts.SourceFile => {
	return ts.createSourceFile('test.d.ts', text, ts.ScriptTarget.ESNext, true);
};

describe('DeclarationProcessor', () => {
	describe('preProcess', () => {
		describe('Modifiers', () => {
			it('should remove export modifiers and add declare modifiers', () => {
				const sourceText = `
					export class MyClass {}
					export function myFunction(): void {}
					export enum MyEnum { A, B }
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('declare class MyClass {}');
				expect(result.code).toContain('declare function myFunction(): void {}');
				expect(result.code).toContain('declare enum MyEnum');
				expect(result.code).not.toContain('export class');
				expect(result.code).not.toContain('export function');
				expect(result.code).not.toContain('export enum');
			});

			it('should handle default exports', () => {
				const sourceText = `
					export default class MyClass {}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('declare class MyClass {}');
				expect(result.code).toContain('export default MyClass;');
			});

			it('should generate name for anonymous default export class', () => {
				const sourceText = `
					export default class {}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toMatch(/declare class \w+\{\}/);
				expect(result.code).toContain('export default');
			});

			it('should generate name for anonymous default export class extending another', () => {
				const sourceText = `
					export class Base {}
					export default class extends Base {}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toMatch(/declare class \w+ extends Base \{\}/);
				expect(result.code).toContain('export default');
			});

			it('should generate name for anonymous default export function', () => {
				const sourceText = `
					export default function() {}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toMatch(/declare function \w+\(\)/);
				expect(result.code).toContain('export default');
			});

			it('should handle let and var variable declarations', () => {
				const sourceText = `
					export let x = 1;
					export var y = 2;
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('declare let x = 1');
				expect(result.code).toContain('declare var y = 2');
			});

			it('should preserve interface declarations', () => {
				const sourceText = `
					export interface MyInterface {
						prop: string;
					}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('interface MyInterface');
				expect(result.code).not.toContain('declare interface');
			});

			it('should handle module declarations', () => {
				const sourceText = `
					export module MyModule {
						export class MyClass {}
					}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('declare module MyModule');
				expect(result.code).not.toContain('export module');
			});
		});

		describe('Variables', () => {
			it('should split compound variable statements', () => {
				const sourceText = `
					export const a = 1, b = 2, c = 3;
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				// Note: NodeFlags.Const outputs as "2" in the prefix logic of preProcess
				// "declare 2 b = 2;" seems to be the actual output based on previous tests
				// Let's verify if we can fix the test expectation or if the code logic is weird but consistent
				expect(result.code).toContain('declare const a = 1;');
				expect(result.code).toContain('declare const b = 2;');
				expect(result.code).toContain('declare const c = 3;');
			});

			it('should split compound variable statements without whitespace', () => {
				const sourceText = 'export const a=1,b=2;';
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('declare const a=1;');
				expect(result.code).toContain('declare const b=2;');
			});
		});

		describe('Exports', () => {
			it('should collect exported names', () => {
				const sourceText = `
					export class MyClass {}
					export interface MyInterface {}
					export type MyType = string;
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('export { MyClass, MyInterface, MyType }');
			});

			it('should remove empty export statements', () => {
				const sourceText = `
					export {};
					export class MyClass {}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				const exportMatches = result.code.match(/export\s*{/g);
				expect(exportMatches?.length).toBe(1);
			});

			it('should strip type keyword from export type statements', () => {
				const sourceText = `
					export type { Foo } from './foo';
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain("export { Foo } from './foo';");
				expect(result.code).not.toContain('export type');
			});

			it('should duplicate namespace exports for renaming', () => {
				const sourceText = `
					export namespace MyNamespace {
						export { Foo };
					}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain('export { Foo as Foo }');
			});
		});

		describe('Imports', () => {
			it('should strip type keyword from import type statements', () => {
				const sourceText = `
					import type { Foo } from './foo';
					import type Bar from './bar';
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain("import { Foo } from './foo';");
				expect(result.code).toContain("import Bar from './bar';");
			});

			it('should handle import type with no whitespace', () => {
				const sourceText = "import type{Foo}from'./foo';";
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain("import {Foo}from'./foo';");
			});

			it('should strip inline type specifiers from imports', () => {
				const sourceText = `
					import { foo, type Bar, baz } from './module';
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toContain("import { foo, Bar, baz } from './module';");
				expect(result.code).not.toContain('type Bar');
			});

			it('should handle inline import() types', () => {
				const sourceText = `
					export type MyType = import('./module').SomeType;
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).toMatch(/import \* as \w+ from ["']\.\/module["'];/);
				expect(result.code).toMatch(/type MyType = \w+\.SomeType;/);
			});

			it('should parse and remove triple-slash type references', () => {
				const sourceText = `/// <reference types="node" />
					export class MyClass {}
				`;
				const result = DeclarationProcessor.preProcess(createMockSourceFile(sourceText));

				expect(result.code).not.toContain('/// <reference');
				expect(result.typeReferences.has('node')).toBe(true);
			});
		});
	});

	describe('postProcess', () => {
		it('should remove empty statements', () => {
			const sourceText = `
				;
				class MyClass {}
				;
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).toContain('class MyClass {}');
			const semicolonCount = (result.match(/;/g) || []).length;
			expect(semicolonCount).toBeLessThan(3);
		});

		it('should fix import paths from .d.ts to .js', () => {
			const sourceText = `
				import { a } from './other.d.ts';
				import { b } from './another.d.ts';
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).toContain("import { a } from './other.js';");
			expect(result).toContain("import { b } from './another.js';");
		});

		it('should fix export paths from .d.ts to .js', () => {
			const sourceText = `
				export { b } from './another.d.ts';
				export type { c } from './types.d.ts';
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).toContain("export { b } from './another.js';");
			expect(result).toContain("export type { c } from './types.js';");
		});

		it('should not modify absolute or package imports', () => {
			const sourceText = `
				import { x } from 'typescript';
				import { y } from '@types/node';
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).toContain("import { x } from 'typescript';");
			expect(result).toContain("import { y } from '@types/node';");
		});

		it('should remove redundant re-exports in a namespace', () => {
			const sourceText = `
				declare namespace MyNamespace {
					export { MyClass as MyClass };
				}
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).not.toContain('MyClass as MyClass');
			expect(result).toContain('export { MyClass };');
		});

		it('should keep non-redundant re-exports in a namespace', () => {
			const sourceText = `
				declare namespace MyNamespace {
					export { MyClass as Renamed };
				}
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).toContain('MyClass as Renamed');
		});

		it('should handle multiple transformations together', () => {
			const sourceText = `
				;
				import { a } from './other.d.ts';
				declare namespace MyNamespace {
					export { Foo as Foo };
				}
				export { b } from './another.d.ts';
				;
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).toContain("import { a } from './other.js';");
			expect(result).toContain("export { b } from './another.js';");
			expect(result).not.toContain('Foo as Foo');
			expect(result).toContain('export { Foo };');

			const emptyStatements = result.match(/^\s*;\s*$/gm) || [];
			expect(emptyStatements.length).toBe(0);
		});

		it('should preserve user-written namespaces', () => {
			const sourceText = `
				export namespace Utils {
					export function isString(value: unknown): value is string {
						return typeof value === 'string';
					}
					export const VERSION: string = '1.0.0';
				}
			`;
			const result = DeclarationProcessor.postProcess(createMockSourceFile(sourceText));

			expect(result).toContain('namespace Utils');
			expect(result).toContain('isString');
			expect(result).toContain('VERSION');
		});
	});

	describe('UnsupportedSyntaxError', () => {
		it('should create error with node information', () => {
			const sourceText = 'export class MyClass {}';
			const sourceFile = createMockSourceFile(sourceText);
			const node = sourceFile.statements[0];
			const error = new UnsupportedSyntaxError(node);

			expect(error.message).toContain('Syntax not yet supported');
			expect(error.message).toContain('ClassDeclaration');
			expect(error).toBeInstanceOf(Error);
		});

		it('should use custom message when provided', () => {
			const sourceText = 'export class MyClass {}';
			const sourceFile = createMockSourceFile(sourceText);
			const node = sourceFile.statements[0];
			const error = new UnsupportedSyntaxError(node, 'Custom error message');

			expect(error.message).toContain('Custom error message');
			expect(error.message).toContain('ClassDeclaration');
		});

		it('should include node text in error message', () => {
			const sourceText = 'export class MyClass {}';
			const sourceFile = createMockSourceFile(sourceText);
			const node = sourceFile.statements[0];
			const error = new UnsupportedSyntaxError(node);

			expect(error.message).toContain('export class MyClass {}');
		});

		it('should truncate long node text', () => {
			const longText = 'export class VeryLongClassName '.repeat(10) + '{}';
			const sourceFile = createMockSourceFile(longText);
			const node = sourceFile.statements[0];
			const error = new UnsupportedSyntaxError(node);

			expect(error.message.length).toBeLessThan(longText.length + 100);
		});

		it('should handle nodes without getText method', () => {
			const sourceText = 'export class MyClass {}';
			const sourceFile = createMockSourceFile(sourceText);
			const node = sourceFile.statements[0];

			const nodeWithoutGetText = {
				kind: node.kind,
			};

			const error = new UnsupportedSyntaxError(nodeWithoutGetText as unknown as import('typescript').Node);

			expect(error.message).toContain('<no text>');
		});

		it('should include syntax kind name in error message', () => {
			const sourceText = 'export interface MyInterface {}';
			const sourceFile = createMockSourceFile(sourceText);
			const node = sourceFile.statements[0];
			const error = new UnsupportedSyntaxError(node);

			expect(error.message).toContain('InterfaceDeclaration');
		});
	});
});
