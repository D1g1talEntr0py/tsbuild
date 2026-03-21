import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { DeclarationProcessor } from 'src/dts/declaration-processor';
import { UnsupportedSyntaxError } from 'src/errors';

const parse = (text: string): ts.SourceFile => ts.createSourceFile('test.d.ts', text, ts.ScriptTarget.ESNext, true);

describe('DeclarationProcessor', () => {
	describe('preProcess', () => {
		describe('modifier rewriting', () => {
			it('removes export and adds declare for classes', () => {
				const result = DeclarationProcessor.preProcess(parse('export class MyClass {}'));
				expect(result.code).toContain('declare class MyClass {}');
				expect(result.code).not.toContain('export class');
			});

			it('removes export and adds declare for functions', () => {
				const result = DeclarationProcessor.preProcess(parse('export function myFn(): void;'));
				expect(result.code).toContain('declare function myFn(): void');
				expect(result.code).not.toContain('export function');
			});

			it('removes export and adds declare for enums', () => {
				const result = DeclarationProcessor.preProcess(parse('export enum MyEnum { A, B }'));
				expect(result.code).toContain('declare enum MyEnum');
				expect(result.code).not.toContain('export enum');
			});

			it('handles export default class', () => {
				const result = DeclarationProcessor.preProcess(parse('export default class MyClass {}'));
				expect(result.code).toContain('declare class MyClass {}');
				expect(result.code).toContain('export default MyClass;');
			});

			it('generates name for anonymous default export class', () => {
				const result = DeclarationProcessor.preProcess(parse('export default class {}'));
				expect(result.code).toMatch(/declare class \w+\{\}/);
				expect(result.code).toContain('export default');
			});

			it('generates name for anonymous default export class with extends', () => {
				const result = DeclarationProcessor.preProcess(parse('export class Base {}\nexport default class extends Base {}'));
				expect(result.code).toMatch(/declare class \w+ extends Base \{\}/);
			});

			it('generates name for anonymous default export function', () => {
				const result = DeclarationProcessor.preProcess(parse('export default function() {}'));
				expect(result.code).toMatch(/declare function \w+\(\)/);
				expect(result.code).toContain('export default');
			});

			it('handles let and var variable declarations', () => {
				const result = DeclarationProcessor.preProcess(parse('export let x = 1;\nexport var y = 2;'));
				expect(result.code).toContain('declare let x = 1');
				expect(result.code).toContain('declare var y = 2');
			});

			it('preserves interface declarations', () => {
				const result = DeclarationProcessor.preProcess(parse('export interface MyInterface { prop: string; }'));
				expect(result.code).toContain('interface MyInterface');
				expect(result.code).not.toContain('declare interface');
			});

			it('handles module declarations', () => {
				const result = DeclarationProcessor.preProcess(parse('export module MyModule { export class MyClass {} }'));
				expect(result.code).toContain('declare module MyModule');
				expect(result.code).not.toContain('export module');
			});
		});

		describe('variable splitting', () => {
			it('splits compound variable statements', () => {
				const result = DeclarationProcessor.preProcess(parse('export const a = 1, b = 2, c = 3;'));
				expect(result.code).toContain('declare const a = 1;');
				expect(result.code).toContain('declare const b = 2;');
				expect(result.code).toContain('declare const c = 3;');
			});

			it('splits compound variables without whitespace', () => {
				const result = DeclarationProcessor.preProcess(parse('export const a=1,b=2;'));
				expect(result.code).toContain('declare const a=1;');
				expect(result.code).toContain('declare const b=2;');
			});
		});

		describe('exports', () => {
			it('collects exported names into consolidated export statement', () => {
				const result = DeclarationProcessor.preProcess(parse(`
					export class MyClass {}
					export interface MyInterface {}
					export type MyType = string;
				`));
				expect(result.code).toContain('export { MyClass, MyInterface, MyType }');
			});

			it('removes empty export statements', () => {
				const result = DeclarationProcessor.preProcess(parse('export {};\nexport class MyClass {}'));
				const matches = result.code.match(/export\s*{/g);
				expect(matches?.length).toBe(1);
			});

			it('strips type keyword from export type statements', () => {
				const result = DeclarationProcessor.preProcess(parse("export type { Foo } from './foo';"));
				expect(result.code).toContain("export { Foo } from './foo';");
				expect(result.code).not.toContain('export type');
			});

			it('duplicates namespace exports for renaming', () => {
				const result = DeclarationProcessor.preProcess(parse('export namespace MyNS { export { Foo }; }'));
				expect(result.code).toContain('export { Foo as Foo }');
			});
		});

		describe('imports', () => {
			it('strips type keyword from import type statements', () => {
				const result = DeclarationProcessor.preProcess(parse("import type { Foo } from './foo';\nimport type Bar from './bar';"));
				expect(result.code).toContain("import { Foo } from './foo';");
				expect(result.code).toContain("import Bar from './bar';");
			});

			it('handles import type with no whitespace', () => {
				const result = DeclarationProcessor.preProcess(parse("import type{Foo}from'./foo';"));
				expect(result.code).toContain("import {Foo}from'./foo';");
			});

			it('strips inline type specifiers from imports', () => {
				const result = DeclarationProcessor.preProcess(parse("import { foo, type Bar, baz } from './module';"));
				expect(result.code).toContain("import { foo, Bar, baz } from './module';");
				expect(result.code).not.toContain('type Bar');
			});

			it('handles inline import() types', () => {
				const result = DeclarationProcessor.preProcess(parse("export type MyType = import('./module').SomeType;"));
				expect(result.code).toMatch(/import \* as \w+ from ["']\.\/module["'];/);
				expect(result.code).toMatch(/type MyType = \w+\.SomeType;/);
			});

			it('parses and removes triple-slash type references', () => {
				const result = DeclarationProcessor.preProcess(parse('/// <reference types="node" />\nexport class MyClass {}'));
				expect(result.code).not.toContain('/// <reference');
				expect(result.typeReferences.has('node')).toBe(true);
			});
		});

		describe('whitespace handling', () => {
			it('does not eat into next token when removing export at end of line', () => {
				const result = DeclarationProcessor.preProcess(parse('export\nclass MyClass {}'));
				expect(result.code).toContain('declare class MyClass {}');
				expect(result.code).not.toContain('declare lass');
			});

			it('handles export default modifier removal with trailing whitespace', () => {
				const result = DeclarationProcessor.preProcess(parse('export default class Foo {}'));
				expect(result.code).toContain('declare class Foo {}');
				expect(result.code).not.toMatch(/^export default class/m);
			});

			it('handles export modifier with multiple spaces', () => {
				const result = DeclarationProcessor.preProcess(parse('export   function myFn(): void;'));
				expect(result.code).toContain('declare function myFn(): void');
				expect(result.code).not.toMatch(/^export\s+function/m);
			});
		});

		describe('function overloads', () => {
			it('handles adjacent function overload declarations', () => {
				const input = 'export function foo(a: string): string;\nexport function foo(a: number): number;\nexport function foo(a: string | number): string | number;';
				const result = DeclarationProcessor.preProcess(parse(input));
				expect(result.code).toContain('declare function foo(a: string): string;');
				expect(result.code).toContain('declare function foo(a: number): number;');
				expect(result.code).toContain('export { foo }');
			});
		});
	});

	describe('postProcess', () => {
		it('removes empty statements', () => {
			const result = DeclarationProcessor.postProcess(parse(';\nclass MyClass {}\n;'));
			expect(result).toContain('class MyClass {}');
			const emptyStatements = result.match(/^\s*;\s*$/gm) || [];
			expect(emptyStatements).toHaveLength(0);
		});

		it('fixes import paths from .d.ts to .js', () => {
			const result = DeclarationProcessor.postProcess(parse("import { a } from './other.d.ts';\nimport { b } from './another.d.ts';"));
			expect(result).toContain("import { a } from './other.js';");
			expect(result).toContain("import { b } from './another.js';");
		});

		it('fixes export paths from .d.ts to .js', () => {
			const result = DeclarationProcessor.postProcess(parse("export { b } from './another.d.ts';\nexport type { c } from './types.d.ts';"));
			expect(result).toContain("export { b } from './another.js';");
			expect(result).toContain("export type { c } from './types.js';");
		});

		it('does not modify package imports', () => {
			const result = DeclarationProcessor.postProcess(parse("import { x } from 'typescript';\nimport { y } from '@types/node';"));
			expect(result).toContain("import { x } from 'typescript';");
			expect(result).toContain("import { y } from '@types/node';");
		});

		it('removes redundant re-exports in namespaces', () => {
			const result = DeclarationProcessor.postProcess(parse('declare namespace NS { export { MyClass as MyClass }; }'));
			expect(result).not.toContain('MyClass as MyClass');
			expect(result).toContain('export { MyClass };');
		});

		it('keeps non-redundant re-exports in namespaces', () => {
			const result = DeclarationProcessor.postProcess(parse('declare namespace NS { export { MyClass as Renamed }; }'));
			expect(result).toContain('MyClass as Renamed');
		});

		it('handles multiple transformations together', () => {
			const source = `
				;
				import { a } from './other.d.ts';
				declare namespace NS {
					export { Foo as Foo };
				}
				export { b } from './another.d.ts';
				;
			`;
			const result = DeclarationProcessor.postProcess(parse(source));
			expect(result).toContain("import { a } from './other.js';");
			expect(result).toContain("export { b } from './another.js';");
			expect(result).not.toContain('Foo as Foo');
			expect(result).toContain('export { Foo };');
			expect(result.match(/^\s*;\s*$/gm) || []).toHaveLength(0);
		});

		it('preserves user-written namespaces', () => {
			const result = DeclarationProcessor.postProcess(parse(`
				export namespace Utils {
					export function isString(value: unknown): value is string;
					export const VERSION: string;
				}
			`));
			expect(result).toContain('namespace Utils');
			expect(result).toContain('isString');
			expect(result).toContain('VERSION');
		});
	});
});

describe('UnsupportedSyntaxError', () => {
	it('includes syntax kind name', () => {
		const sf = parse('export interface MyInterface {}');
		const error = new UnsupportedSyntaxError(sf.statements[0]);
		expect(error.message).toContain('InterfaceDeclaration');
	});

	it('includes node text in error message', () => {
		const sf = parse('export class MyClass {}');
		const error = new UnsupportedSyntaxError(sf.statements[0]);
		expect(error.message).toContain('export class MyClass {}');
	});

	it('uses custom message when provided', () => {
		const sf = parse('export class MyClass {}');
		const error = new UnsupportedSyntaxError(sf.statements[0], 'Custom error message');
		expect(error.message).toContain('Custom error message');
		expect(error.message).toContain('ClassDeclaration');
	});

	it('truncates long node text', () => {
		const longText = 'export class VeryLongClassName '.repeat(10) + '{}';
		const sf = parse(longText);
		const error = new UnsupportedSyntaxError(sf.statements[0]);
		expect(error.message.length).toBeLessThan(longText.length + 100);
	});

	it('handles nodes without getText method', () => {
		const error = new UnsupportedSyntaxError({ kind: ts.SyntaxKind.ClassDeclaration } as ts.Node);
		expect(error.message).toContain('<no text>');
	});
});
