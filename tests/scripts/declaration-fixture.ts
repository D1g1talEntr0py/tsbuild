import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateSyntheticProject, type BenchmarkScenario } from './benchmark';
import type { DeclarationEntry } from './declaration-comparison';

const sharedSource = `
export interface Shared<T extends { id: string } = { id: string }> {
	readonly value: T;
	readonly next?: Shared<T>;
}
export type Outcome<T extends { id: string }> = { readonly ok: true; result: Shared<T> } | { readonly ok: false; error: Error };
export type Projected<T> = { readonly [K in keyof T]?: T[K] };
export type Payload<T> = T extends Shared<infer U> ? U : never;
export function select(value: string): Shared;
export function select(value: number): Shared<{ id: string; count: number }>;
export function select(value: string | number): Shared | Shared<{ id: string; count: number }> {
	return typeof value === 'number' ? { value: { id: String(value), count: value } } : { value: { id: value } };
}
export class SharedStore {
	#state: Shared[] = [];
	add(value: Shared): this { this.#state.push(value); return this; }
	get size(): number { return this.#state.length; }
}
export const brandedKey: unique symbol = Symbol('benchmark');
export interface Branded {
	readonly [brandedKey]: 'brand';
	readonly value: string;
}
`;

/** Adds recursive/generic shared contracts and multi-entry nominal identity cases to the workload. */
export function generateDeclarationFixture(directory: string, scenario: BenchmarkScenario): DeclarationEntry[] {
	generateSyntheticProject(directory, scenario);
	writeFileSync(join(directory, 'src/shared.ts'), sharedSource);
	return Array.from({ length: scenario.entryCount }, (_, index) => {
		const start = Math.floor(index * scenario.moduleCount / scenario.entryCount);
		const end = Math.floor((index + 1) * scenario.moduleCount / scenario.entryCount);
		const name = scenario.entryCount === 1 ? 'index' : `entry-${String(index).padStart(2, '0')}`;
		appendFileSync(join(directory, 'src', `${name}.ts`), "\nexport * from './shared';\n");
		return {
			name,
			moduleIds: Array.from({ length: end - start }, (_, offset) => String(start + offset).padStart(3, '0')),
			additionalExports: ['Shared', 'Outcome', 'Projected', 'Payload', 'select', 'SharedStore', 'brandedKey', 'Branded'],
			additionalChecks: [
				'export type Shared_default = Assert<Equal<Reference.Shared, Actual.Shared>>;',
				'export type Shared_generic = Assert<Equal<Reference.Shared<{ id: string; nested: readonly number[] }>, Actual.Shared<{ id: string; nested: readonly number[] }>>>;',
				'export type Outcome_union = Assert<Equal<Reference.Outcome<{ id: string }>, Actual.Outcome<{ id: string }>>>;',
				'export type Projected_mapped = Assert<Equal<Reference.Projected<{ id: string; count: number }>, Actual.Projected<{ id: string; count: number }>>>;',
				'export type Payload_conditional = Assert<Equal<Reference.Payload<Reference.Shared<{ id: string; count: number }>>, Actual.Payload<Actual.Shared<{ id: string; count: number }>>>>;',
				'export type select_overloads = Assert<Equal<typeof Reference.select, typeof Actual.select>>;',
				'export const selectedString: Actual.Shared = Actual.select("value");',
				'export const selectedNumber: Actual.Shared<{ id: string; count: number }> = Actual.select(1);',
				'export type store_properties = Assert<Equal<Omit<Reference.SharedStore, "add">, Omit<Actual.SharedStore, "add">>>;',
				'export type store_parameters = Assert<Equal<Parameters<Reference.SharedStore["add"]>, Parameters<Actual.SharedStore["add"]>>>;',
				'export type store_brand = Assert<Equal<PublicShape<Reference.SharedStore> extends Reference.SharedStore ? true : false, PublicShape<Actual.SharedStore> extends Actual.SharedStore ? true : false>>;',
				'export type branded_value = Assert<Equal<Reference.Branded["value"], Actual.Branded["value"]>>;',
				'export type branded_key = Assert<Equal<Actual.Branded[typeof Actual.brandedKey], "brand">>;',
				'export type branded_keys = Assert<Equal<keyof Actual.Branded, typeof Actual.brandedKey | "value">>;',
			],
		};
	});
}
