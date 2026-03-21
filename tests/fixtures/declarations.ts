/** Shared declaration file content for bundler/processor tests */

/** Simple type declarations */
export const simpleInterface = `export interface User {
	name: string;
	age: number;
}`;

export const simpleClass = `export declare class Service {
	start(): void;
	stop(): void;
}`;

export const simpleEnum = `export declare enum Status {
	Active = 0,
	Inactive = 1
}`;

export const simpleTypeAlias = `export type Result<T> = { success: true; data: T } | { success: false; error: string };`;

export const simpleFunction = `export declare function parse(input: string): Record<string, unknown>;`;

export const simpleConst = `export declare const VERSION: string;`;

/** Re-export patterns */
export const barrelFile = `export { User } from './user';
export { Service } from './service';`;

export const typeReExport = `export type { User } from './user';`;

export const namespaceExport = `export * from './utils';`;

/** Import patterns for preProcess testing */
export const typeImport = `import type { Foo } from './foo';
export declare class Bar {
	foo: Foo;
}`;

export const inlineTypeImport = `import { type Foo, Bar } from './module';
export declare class Baz extends Bar {
	foo: Foo;
}`;

export const dynamicImportType = `export declare class Loader {
	load(): Promise<import('./types').Config>;
}`;

export const tripleSlashReference = `/// <reference types="node" />
export declare function readFile(path: string): Buffer;`;

/** Compound declarations for splitting */
export const compoundConst = `export declare const A: string, B: number, C: boolean;`;

export const compoundLet = `export declare let x: string, y: number;`;

/** Complex type patterns */
export const conditionalType = `export type IsString<T> = T extends string ? true : false;`;

export const mappedType = `export type Readonly<T> = { readonly [K in keyof T]: T[K] };`;

export const templateLiteralType = `export type EventName = \`on\${string}\`;`;

/** Namespace declarations */
export const namespaceDeclaration = `export declare namespace Utils {
	function parse(input: string): unknown;
	interface Options {
		strict: boolean;
	}
}`;

/** Multi-file project for bundler tests */
export const multiFileProject = {
	'src/index.ts': `export { User } from './models/user';
export { Service } from './services/service';
export type { Config } from './types';`,
	'src/models/user.ts': `export interface User {
	id: number;
	name: string;
}`,
	'src/services/service.ts': `import type { User } from '../models/user';
export declare class Service {
	getUser(id: number): User;
}`,
	'src/types.ts': `export interface Config {
	port: number;
	host: string;
}`,
} as const;

/** Declaration files matching the multi-file project */
export const multiFileDts = {
	'src/models/user.d.ts': `export interface User {
	id: number;
	name: string;
}`,
	'src/services/service.d.ts': `import type { User } from '../models/user';
export declare class Service {
	getUser(id: number): User;
}`,
	'src/types.d.ts': `export interface Config {
	port: number;
	host: string;
}`,
	'src/index.d.ts': `export { User } from './models/user';
export { Service } from './services/service';
export type { Config } from './types';`,
} as const;

/** Identifier collision scenario */
export const collisionA = `export interface Config {
	valueA: string;
}`;

export const collisionB = `export interface Config {
	valueB: number;
}`;

export const collisionEntry = `export { Config } from './a';
export { Config as ConfigB } from './b';`;

/** External module re-exports */
export const externalReExport = `export { EventEmitter } from 'events';
export declare class MyEmitter extends EventEmitter {}`;

/** Empty export (should be stripped) */
export const emptyExport = `export {};
export declare const value: string;`;
