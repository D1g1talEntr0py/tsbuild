import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { vol } from 'memfs';
import { compareDeclarations, declarationMetrics } from './scripts/declaration-comparison';
import { TestHelper } from './scripts/test-helper';

vi.mock('node:fs', async () => (await vi.importActual<typeof import('memfs')>('memfs')).fs);

const reference = '/benchmark/reference';
const output = '/benchmark/output';
const entries = [{ name: 'index', moduleIds: ['000'] }];
const moduleDeclaration = `
export declare const value000: number;
export interface Item000 {
	readonly id: string;
	readonly seq: number;
	readonly tags: ReadonlyArray<string>;
}
export declare function make000(seq: number, ...tags: string[]): Item000;
export declare class Aggregator000 {
	#private;
	add(item: Item000): this;
	get count(): number;
	get base(): number;
}
export declare function transform000<T>(values: ReadonlyArray<T>, mapper: (v: T) => T): T[];
`;

beforeEach(async () => {
	await TestHelper.setupMemfs();
	vol.fromJSON({
		[join(reference, 'index.d.ts')]: "export * from './module-000';",
		[join(reference, 'module-000.d.ts')]: moduleDeclaration,
		[join(output, 'index.d.ts')]: moduleDeclaration,
	});
});
afterEach(() => { TestHelper.teardownMemfs() });

describe('declaration comparison', () => {
	it('accepts a bundled API against unbundled tsc output, preserving private classes and generics', () => {
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result).toMatchObject({
			valid: true, checkedEntries: 1, expectedExports: 5, missingExports: [], extraExports: [], errors: [],
		});
		expect(vol.readdirSync(output)).toEqual(['index.d.ts']);
		expect(result.digest).not.toBe(declarationMetrics(reference).digest);
		expect(result.structuresMatched).toBe(5);
		expect(result.structuralDifferences).toEqual([]);
	});

	it('resolves shared chunks and validates every declaration extension', () => {
		vol.writeFileSync(join(output, 'chunk.d.mts'), moduleDeclaration);
		vol.writeFileSync(join(output, 'index.d.mts'), "export * from './chunk.mjs';");
		vol.writeFileSync(join(output, 'index.d.cts'), moduleDeclaration);
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result).toMatchObject({ valid: true, checkedEntries: 3, expectedExports: 15 });
		expect(result.files).toHaveLength(4);
		expect(result.duplications).toContainEqual({
			kind: 'alternate-variant', files: ['index.d.cts', 'index.d.ts'], identical: true,
		});
	});

	it.each([
		['value type', 'value000: number', 'value000: string'],
		['readonly member', 'readonly id: string', 'id: string'],
		['factory parameter', 'make000(seq: number', 'make000(seq: string'],
		['generic signature', 'mapper: (v: T) => T', 'mapper: (v: T) => string'],
		['class getter', 'get count(): number', 'get count(): string'],
		['readonly getter', 'get count(): number', 'count: number'],
		['class parameter', 'add(item: Item000)', 'add(item: string)'],
		['class return', 'add(item: Item000): this', 'add(item: Item000): void'],
		['polymorphic this return', 'add(item: Item000): this', 'add(item: Item000): Aggregator000'],
		['abstract class', 'export declare class Aggregator000', 'export declare abstract class Aggregator000'],
		['private nominal marker', '\t#private;', ''],
		['class constructor', '#private;', '#private;\nconstructor(required: string);'],
	])('rejects a changed %s even when the declaration compiles', (_, from, to) => {
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration.replace(from, to));
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.errors.join('\n')).toContain('error TS');
		expect(result.structuralDifferences.length).toBeGreaterThan(0);
		expect(result.typeDifferences.length).toBeGreaterThan(0);
	});

	it('reports missing type-only exports and extra type-only exports', () => {
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration.replaceAll('export ', '') +
			'\nexport { value000, make000, Aggregator000, transform000 };\nexport type Unexpected = string;');
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.missingExports).toEqual(['index.d.ts: Item000']);
		expect(result.extraExports).toEqual(['index.d.ts: Unexpected']);
	});

	it('rejects a missing entry even if declarations exist', () => {
		vol.renameSync(join(output, 'index.d.ts'), join(output, 'other.d.ts'));
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Missing declaration entry: index');
		expect(result.missingEntries).toEqual(['index']);
	});

	it('reports a library that produces no declaration output directory', () => {
		const result = compareDeclarations(TestHelper.api, reference, '/benchmark/no-output', entries);
		expect(result.valid).toBe(false);
		expect(result.missingEntries).toEqual(['index']);
		expect(result.errors).toEqual(['Missing declaration output directory: /benchmark/no-output']);
	});

	it('checks all entries rather than only index', () => {
		vol.writeFileSync(join(reference, 'second.d.ts'), "export * from './module-000';");
		const result = compareDeclarations(TestHelper.api, reference, output, [...entries, { name: 'second', moduleIds: ['000'] }]);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Missing declaration entry: second');
	});

	it('reports unresolved imports with declaration checking enabled', () => {
		vol.writeFileSync(join(output, 'broken.d.ts'), "export { Missing } from './missing';");
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.errors.join('\n')).toContain("Cannot find module './missing'");
		expect(result.missingReferences).toHaveLength(1);
		expect(result.declarationErrors).toHaveLength(1);
	});

	it('rejects declarations that depend on original source files', () => {
		vol.writeFileSync('/benchmark/source.ts', 'export const source = 1;');
		vol.writeFileSync(join(output, 'source.d.ts'), "export * from '../source';");
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain('Declaration resolves to source instead of emitted declarations: /benchmark/source.ts');
	});

	it('surfaces missing reference declarations and cleans up consumer files on failure', () => {
		vol.unlinkSync(join(reference, 'index.d.ts'));
		expect(() => compareDeclarations(TestHelper.api, reference, output, entries)).toThrow('Missing tsc reference declaration');
		expect(vol.readdirSync(output)).toEqual(['index.d.ts']);
	});

	it('requires consumer checks to stay aligned with the synthetic fixture exports', () => {
		vol.writeFileSync(join(reference, 'module-000.d.ts'), `${moduleDeclaration}\nexport type NewAPI = number;`);
		expect(() => compareDeclarations(TestHelper.api, reference, output, entries)).toThrow('update its declaration consumer checks');
		expect(vol.readdirSync(output)).toEqual(['index.d.ts']);
	});

	it('reports the affected public symbol and expected/actual structural signatures', () => {
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration.replace('readonly seq: number', 'readonly seq?: string'));
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		const difference = result.structuralDifferences.find(item => item.symbol === 'Item000');
		expect(difference).toMatchObject({ entry: 'index.d.ts', symbol: 'Item000' });
		expect(difference?.expected).toContain('readonly seq: number');
		expect(difference?.actual).toContain('readonly seq?: string');
		expect(result.typeDifferences.some(item => item.check === 'module 000: record shape / readonly')).toBe(true);
	});

	it('follows private referenced types instead of comparing their renamed identifiers', () => {
		const original = moduleDeclaration.replaceAll('export ', '').replace('readonly id: string;', 'readonly id: Hidden;') +
			'\ninterface Hidden { readonly nested: number; }\nexport { value000, Item000, make000, Aggregator000, transform000 };';
		vol.writeFileSync(join(reference, 'module-000.d.ts'), original);
		vol.writeFileSync(join(output, 'index.d.ts'), original.replaceAll('Hidden', 'Renamed'));
		expect(compareDeclarations(TestHelper.api, reference, output, entries).structuralDifferences).toEqual([]);
		vol.writeFileSync(join(output, 'index.d.ts'), vol.readFileSync(join(output, 'index.d.ts'), 'utf8').toString().replace('nested: number', 'nested: string'));
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.structuralDifferences.some(item => item.symbol === 'Item000')).toBe(true);
	});

	it('ignores generic parameter renaming and member ordering', () => {
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration
			.replaceAll('<T>', '<U>').replaceAll('ReadonlyArray<T>', 'ReadonlyArray<U>').replaceAll('(v: T) => T', '(v: U) => U').replaceAll(': T[]', ': U[]')
			.replace('readonly id: string;\n\treadonly seq: number;', 'readonly seq: number;\n\treadonly id: string;'));
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(true);
		expect(result.structuralDifferences).toEqual([]);
	});

	it('reports exact duplicate members even if TypeScript permits them', () => {
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration.replace('readonly seq: number;', 'readonly seq: number;\nreadonly seq: number;'));
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.duplications).toContainEqual({
			kind: 'repeated-declaration', files: ['index.d.ts'], identical: true, declaration: 'readonly seq : number ;',
		});
	});

	it('allows distinct overloads and interface merging without labelling them duplicate declarations', () => {
		const overloaded = moduleDeclaration.replace('export declare function make000(seq: number, ...tags: string[]): Item000;',
			'export declare function make000(seq: number, ...tags: string[]): Item000;\nexport declare function make000(seq: string, ...tags: string[]): Item000;') +
			'\nexport interface Item000 { readonly extra?: number; }';
		vol.writeFileSync(join(reference, 'module-000.d.ts'), overloaded);
		vol.writeFileSync(join(output, 'index.d.ts'), overloaded);
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(true);
		expect(result.duplications).toEqual([]);
	});

	it('detects lost shared private identity across independently bundled entry points', () => {
		vol.writeFileSync(join(reference, 'second.d.ts'), "export * from './module-000';");
		vol.writeFileSync(join(output, 'second.d.ts'), moduleDeclaration);
		const result = compareDeclarations(TestHelper.api, reference, output, [...entries, { name: 'second', moduleIds: ['000'] }]);
		expect(result.valid).toBe(false);
		expect(result.typeDifferences).toContainEqual({
			entry: 'second.d.ts', check: 'Aggregator000: shared identity across entries',
			diagnostic: 'tsc re-exports one shared declaration, but second.d.ts and index.d.ts expose incompatible copies of Aggregator000.',
		});
		expect(result.duplications.some(item => item.kind === 'cross-file-copy')).toBe(true);
	});

	it('preserves shared private identity when entries re-export a shared declaration chunk', () => {
		vol.writeFileSync(join(reference, 'second.d.ts'), "export * from './module-000';");
		vol.writeFileSync(join(output, 'chunk.d.ts'), moduleDeclaration);
		vol.writeFileSync(join(output, 'index.d.ts'), "export * from './chunk';");
		vol.writeFileSync(join(output, 'second.d.ts'), "export * from './chunk';");
		const result = compareDeclarations(TestHelper.api, reference, output, [...entries, { name: 'second', moduleIds: ['000'] }]);
		expect(result.valid).toBe(true);
		expect(result.typeDifferences).toEqual([]);
	});

	it('does not mistake unrelated generic type parameters for a shared-identity defect', () => {
		const generic = 'export interface Generic<T> { readonly value: T }';
		vol.writeFileSync(join(reference, 'module-000.d.ts'), moduleDeclaration + generic);
		vol.writeFileSync(join(reference, 'second.d.ts'), "export * from './module-000';");
		vol.writeFileSync(join(output, 'chunk.d.ts'), moduleDeclaration);
		vol.writeFileSync(join(output, 'index.d.ts'), "export * from './chunk';\n" + generic);
		vol.writeFileSync(join(output, 'second.d.ts'), "export * from './chunk';\n" + generic);
		const entry = {
			...entries[0], additionalExports: ['Generic'],
			additionalChecks: ['export type Generic_application = Assert<Equal<Reference.Generic<{ id: string }>, Actual.Generic<{ id: string }>>>;'],
		};
		const result = compareDeclarations(TestHelper.api, reference, output, [entry, { ...entry, name: 'second' }]);
		expect(result.valid).toBe(true);
		expect(result.typeDifferences).toEqual([]);
	});

	it('reports const/let declaration differences even when the value type is unchanged', () => {
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration.replace('const value000', 'let value000'));
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		const difference = result.structuralDifferences.find(item => item.symbol === 'value000');
		expect(difference?.expected).toContain('const');
		expect(difference?.actual).toContain('let');
	});

	it('reports an exact repeated overload as a duplicate declaration', () => {
		const signature = 'export declare function make000(seq: number, ...tags: string[]): Item000;';
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration + signature);
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.duplications.some(item => item.kind === 'repeated-declaration' && item.declaration?.includes('make000'))).toBe(true);
	});

	it('detects redundant members across merged interface fragments', () => {
		vol.writeFileSync(join(output, 'index.d.ts'), moduleDeclaration + '\nexport interface Item000 { readonly seq: number; }');
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(false);
		expect(result.duplications).toContainEqual({
			kind: 'repeated-declaration', files: ['index.d.ts'], declaration: 'readonly seq : number ;', identical: true,
		});
	});

	it('explains format-specific import targets instead of counting alternate formats as duplicates', () => {
		vol.writeFileSync(join(output, 'chunk.d.mts'), moduleDeclaration);
		vol.writeFileSync(join(output, 'index.d.mts'), "export * from './chunk.mjs';");
		const result = compareDeclarations(TestHelper.api, reference, output, entries);
		expect(result.valid).toBe(true);
		expect(result.duplications).toContainEqual({
			kind: 'alternate-variant', files: ['index.d.mts', 'index.d.ts'], identical: false,
			references: [{ file: 'index.d.mts', specifiers: ['./chunk.mjs'] }, { file: 'index.d.ts', specifiers: [] }],
		});
	});
});

describe('declaration metrics', () => {
	it('counts declaration bytes and lines only, including nested chunks', () => {
		vol.fromJSON({
			'/metrics/index.d.ts': 'export {};\n',
			'/metrics/chunks/shared.d.mts': '// chunk\r\nexport {};',
			'/metrics/empty.d.cts': '',
			'/metrics/index.js': 'export {};',
			'/metrics/index.d.ts.map': '{}',
		});
		const result = declarationMetrics('/metrics');
		expect(result.files.map(({ path, bytes, lines }) => ({ path, bytes, lines }))).toEqual([
			{ path: 'chunks/shared.d.mts', bytes: 20, lines: 2 },
			{ path: 'empty.d.cts', bytes: 0, lines: 0 },
			{ path: 'index.d.ts', bytes: 11, lines: 1 },
		]);
		expect(result.bytes).toBe(31);
		expect(result.lines).toBe(3);
		expect(result.digest).toHaveLength(64);
		expect(result.files.every(file => file.digest.length === 64)).toBe(true);
	});

	it('distinguishes both content and file layout changes', () => {
		const initial = declarationMetrics(output).digest;
		vol.renameSync(join(output, 'index.d.ts'), join(output, 'index.d.mts'));
		const renamed = declarationMetrics(output).digest;
		expect(renamed).not.toBe(initial);
		vol.writeFileSync(join(output, 'index.d.mts'), `${moduleDeclaration}\n`);
		expect(declarationMetrics(output).digest).not.toBe(renamed);
	});
});
