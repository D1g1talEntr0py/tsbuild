import { describe, expect, expectTypeOf, it } from 'vitest';
import { array, guard, object, optional, TypeDefinition } from '../src/type-definition';

describe('TypeDefinition', () => {
	it('validates values through definitions and narrows their types', () => {
		const definition = TypeDefinition.ofShape({ name: String });
		const value: unknown = { name: 'Ada' };

		expect(definition.is(value)).toBe(true);
		expect(definition.is({ name: 42 })).toBe(false);
		if (definition.is(value)) {
			expectTypeOf(value).toEqualTypeOf<{ name: string }>();
		}

		expect(TypeDefinition.ofType(Number).is(42)).toBe(true);
		expect(TypeDefinition.ofArray(String).is([42])).toBe(false);
	});

	it('composes object fields directly and inside arrays and optional fields', () => {
		const field = object({ a: Number });
		const check = TypeDefinition.typeGuardOfShape({ direct: field, list: array(field), maybe: optional(field) });
		const value = { direct: { a: 1 }, list: [{ a: 2 }] };

		expect(check(value)).toBe(true);
		expect(check({ ...value, maybe: { a: 3 } })).toBe(true);
		expect(check({ ...value, maybe: undefined })).toBe(true);
		expect(check({ ...value, direct: { a: '1' } })).toBe(false);
		expect(check({ ...value, list: [{ a: '2' }] })).toBe(false);
		expect(check({ ...value, maybe: { a: '3' } })).toBe(false);
		expect(check({ ...value, direct: { a: 1, extra: true } })).toBe(false);
		expect(TypeDefinition.ofArray(field).is([{ a: 1 }])).toBe(true);
		expectTypeOf(check).toEqualTypeOf<(value: unknown) => value is { direct: { a: number }; list: { a: number }[]; maybe?: { a: number } }>();
	});

	it('validates numeric shape keys as string properties', () => {
		const check = TypeDefinition.typeGuardOfShape({ 0: String });

		expect(check({ 0: 'Ada' })).toBe(true);
		expect(check({ 0: 42 })).toBe(false);
		expect(check({})).toBe(false);
		expect(check(['Ada'])).toBe(false);
	});

	it('rejects symbol keys in root and nested schemas rather than ignoring them', () => {
		const symbol = Symbol('field');
		const shape = { [symbol]: Number };

		expect(() => TypeDefinition.ofShape(shape)).toThrow('Symbol keys are not supported in shapes');
		expect(() => TypeDefinition.typeGuardOfShape({ nested: shape }, TypeDefinition.Mode.structural)).toThrow('Symbol keys are not supported in shapes');
		expect(() => TypeDefinition.ofArray(object(shape))).toThrow('Symbol keys are not supported in shapes');
	});

	it('supports validation callbacks and preserves type narrowing', () => {
		const check = TypeDefinition.typeGuardOfShape({ name: String });
		const values: unknown[] = [{ name: 'Ada' }, { name: 42 }, null];

		expect(check({ name: 'Ada' })).toBe(true);
		const matches = values.filter(check);
		expect(matches).toEqual([{ name: 'Ada' }]);
		expectTypeOf(matches).toEqualTypeOf<{ name: string }[]>();
	});

	const shapes = [
		['required fields', TypeDefinition.typeGuardOfShape({ name: String }), { name: 'Ada' }],
		['omitted optional fields', TypeDefinition.typeGuardOfShape({ name: String, age: optional(Number) }), { name: 'Ada' }],
		['present optional fields', TypeDefinition.typeGuardOfShape({ name: String, age: optional(Number) }), { name: 'Ada', age: 37 }],
	] as const;

	it.each(shapes)('rejects extra enumerable properties with %s', (_name, check, value) => {
		expect(check(value)).toBe(true);
		expect(check({ ...value, extra: true })).toBe(false);
		expect(check({ ...value, [Symbol('extra')]: true })).toBe(false);
	});

	it.each(shapes)('ignores non-enumerable and inherited symbol properties with %s', (_name, check, value) => {
		const symbol = Symbol('extra');
		const nonEnumerable = Object.defineProperty({ ...value }, symbol, { value: true, enumerable: false });
		const inherited = Object.setPrototypeOf({ ...value }, { [symbol]: true });

		expect(check(nonEnumerable)).toBe(true);
		expect(check(inherited)).toBe(true);
	});

	it('rejects extra enumerable symbols in nested definitions and inline shapes', () => {
		const check = TypeDefinition.typeGuardOfShape({
			file: TypeDefinition.ofShape({ name: String }),
			metadata: { size: Number },
		});
		const value = { file: { name: 'index.ts' }, metadata: { size: 42 } };

		expect(check(value)).toBe(true);
		expect(check({ ...value, file: { ...value.file, [Symbol('extra')]: true } })).toBe(false);
		expect(check({ ...value, metadata: { ...value.metadata, [Symbol('extra')]: true } })).toBe(false);
	});

	it('allows extra properties while validating declared fields when opted in', () => {
		const check = TypeDefinition.typeGuardOfShape({ name: String, age: optional(Number) }, TypeDefinition.Mode.structural);
		const value = { name: 'Ada', extra: true, [Symbol('extra')]: true };

		expect(check(value)).toBe(true);
		expect(check({ ...value, age: 37 })).toBe(true);
		expect(check({ ...value, age: undefined })).toBe(true);
		expect(check({ ...value, name: 42 })).toBe(false);
		expect(check({ ...value, age: '37' })).toBe(false);
		expect(check({ extra: true })).toBe(false);
		expect(check(null)).toBe(false);
		expectTypeOf(check).toEqualTypeOf<(value: unknown) => value is { name: string; age?: number }>();
	});

	it('accepts inherited and non-enumerable declared properties in structural shapes', () => {
		const check = TypeDefinition.typeGuardOfShape({ name: String, setup: Function }, TypeDefinition.Mode.structural);
		class Plugin {
			get name() { return 'plugin' }
			setup() {}
		}
		const nonEnumerable = Object.defineProperties({}, { name: { value: 'plugin' }, setup: { value: () => {} } });
		const array = Object.assign([], { name: 'plugin', setup() {} });

		expect(check(new Plugin())).toBe(true);
		expect(check(nonEnumerable)).toBe(true);
		expect(check(array)).toBe(true);
		expect(check({ name: 'plugin', setup: 'not a function', extra: true })).toBe(false);
	});

	it.each([TypeDefinition.Mode.strict, TypeDefinition.Mode.structural])('preserves field presence and optional validation in %s mode', mode => {
		const structural = mode === TypeDefinition.Mode.structural;
		const definition = TypeDefinition.ofShape({ name: String, age: optional(Number) }, mode);
		const value = Object.create({ name: 'Ada', age: 37 }) as object;
		const nonEnumerable = Object.defineProperties({}, { name: { value: 'Ada' }, age: { value: 37 } });

		expect(definition.is(value)).toBe(structural);
		expect(definition.is(nonEnumerable)).toBe(structural);
		expect(definition.is(Object.create({ name: 'Ada', age: '37' }))).toBe(false);
		expect(definition.is({ name: 'Ada', age: undefined })).toBe(true);
		expect(definition.is({ name: 'Ada', age: '37' })).toBe(false);
		expect(definition.is({ age: 37 })).toBe(false);
		expect(definition.is(Object.assign([], { name: 'Ada' }))).toBe(structural);
		expect(definition.is(null)).toBe(false);
		expect(definition.is('Ada')).toBe(false);
	});

	it('requires fields even when their validator accepts undefined', () => {
		const isUndefined = (value: unknown): value is undefined => value === undefined;
		const check = TypeDefinition.typeGuardOfShape({ marker: guard(isUndefined) }, TypeDefinition.Mode.structural);

		expect(check({ extra: true })).toBe(false);
		expect(check({ marker: undefined, extra: true })).toBe(true);
	});

	it('supports structural definitions as optional fields without relaxing the surrounding shape', () => {
		const plugin = TypeDefinition.ofShape({ name: String, setup: Function }, TypeDefinition.Mode.structural);
		const check = TypeDefinition.typeGuardOfShape({ plugin: optional(plugin) });

		expect(check({})).toBe(true);
		expect(check({ plugin: { name: 'plugin', setup() {}, extra: true } })).toBe(true);
		expect(check({ plugin: { name: 'plugin', setup: 'invalid' } })).toBe(false);
		expect(check({ extra: true })).toBe(false);
	});

	it('validates arrays of shapes and narrows their element types', () => {
		const check = TypeDefinition.typeGuardOfArray({ name: String, scores: array(Number) });
		const values: unknown[] = [
			[{ name: 'Ada', scores: [1, 2] }],
			[],
			[{ name: 'Grace', scores: ['1'] }],
			[{ name: 42, scores: [] }],
			{ name: 'Ada', scores: [] },
			null,
		];
		const matches = values.filter(check);

		expect(matches).toEqual([[{ name: 'Ada', scores: [1, 2] }], []]);
		expectTypeOf(matches).toEqualTypeOf<{ name: string; scores: number[] }[][]>();
	});

	it.each([
		['string', String, 'Ada', 42],
		['number', Number, 42, '42'],
		['boolean', Boolean, true, 'true'],
		['bigint', BigInt, 1n, 1],
		['symbol', Symbol, Symbol('value'), 'value'],
		['function', Function, () => {}, {}],
	])('creates a type guard for %s values', (_name, constructor, valid, invalid) => {
		const check = TypeDefinition.typeGuardOfType(constructor);

		expect(check(valid)).toBe(true);
		expect(check(invalid)).toBe(false);
	});

	it('creates type guards for class instances', () => {
		const check = TypeDefinition.typeGuardOfType(Date);
		const date = new Date(0);
		const values: unknown[] = [date, date.toISOString(), null];
		const matches = values.filter(check);

		expect(matches).toEqual([date]);
		expectTypeOf(matches).toEqualTypeOf<Date[]>();
	});

	it('composes definitions from guards, types, arrays, and shapes', () => {
		const name = guard((value: unknown): value is string => typeof value === 'string' && value.length > 0);
		const tags = TypeDefinition.ofArray(String);
		const created = TypeDefinition.ofType(Date);
		const metadata = TypeDefinition.ofShape({ count: TypeDefinition.ofType(Number) });
		const check = TypeDefinition.typeGuardOfShape({ name, tags, created, metadata });
		const value = { name: 'Ada', tags: ['ts'], created: new Date(0), metadata: { count: 1 } };

		expect(check(value)).toBe(true);
		expect(check({ ...value, name: '' })).toBe(false);
		expect(check({ ...value, tags: [42] })).toBe(false);
		expect(check({ ...value, created: '1970-01-01' })).toBe(false);
		expect(check({ ...value, metadata: { count: '1' } })).toBe(false);
		expect(check({ ...value, metadata: { count: 1, extra: true } })).toBe(false);
		expectTypeOf(tags.type).toEqualTypeOf<string[]>();
		expectTypeOf(created.type).toEqualTypeOf<Date>();
		expectTypeOf(metadata.type).toEqualTypeOf<{ count: number }>();
	});

	it('rejects custom guards passed as constructors', () => {
		const check = (value: unknown): value is string => typeof value === 'string';

		expect(() => {
			// @ts-expect-error Custom guards are not constructors.
			TypeDefinition.ofType(check);
		}).toThrow('Invalid constructor passed to ofType(): expected a primitive or class constructor');
		expect(() => {
			// @ts-expect-error Custom guards are not constructors.
			TypeDefinition.typeGuardOfType(check);
		}).toThrow(TypeError);
	});
});
