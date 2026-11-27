type TypeGuard<T = unknown> = (value: unknown) => value is T;
type MatchMode = typeof TypeDefinition.Mode[keyof typeof TypeDefinition.Mode];
type PrimitiveConstructor = StringConstructor | NumberConstructor | BooleanConstructor | BigIntConstructor | SymbolConstructor | FunctionConstructor;
type ClassConstructor = abstract new (...args: never[]) => unknown;
type TypeConstructor = PrimitiveConstructor | ClassConstructor;
type FieldCheck = (value: unknown) => boolean;

interface GuardField<T = unknown> {
	readonly [guardBrand]: true;
	readonly check: TypeGuard<T>;
}

interface ArrayField<F = BaseFieldType> {
	readonly [arrayBrand]: true;
	readonly inner: F;
}

interface OptionalField<F = BaseFieldType> {
	readonly [optionalBrand]: true;
	readonly inner: F;
}

interface ObjectField<S extends Shape> {
	readonly [objectBrand]: true;
	readonly inner: S;
	readonly mode: MatchMode;
}

interface Shape {
	readonly [key: string]: FieldType;
}

type BaseFieldType = PrimitiveConstructor | ClassConstructor | TypeDefinition<unknown> | GuardField<unknown> | ArrayField<BaseFieldType> | ObjectField<Shape> | Shape;
type FieldType = BaseFieldType | OptionalField<BaseFieldType>;

type InferBaseField<F extends BaseFieldType> =
	F extends StringConstructor ? string :
	F extends NumberConstructor ? number :
	F extends BooleanConstructor ? boolean :
	F extends BigIntConstructor ? bigint :
	F extends SymbolConstructor ? symbol :
	F extends FunctionConstructor ? (...args: never[]) => unknown :
	F extends TypeDefinition<infer T> ? T :
	F extends GuardField<infer T> ? T :
	F extends ArrayField<infer Inner extends BaseFieldType> ? InferBaseField<Inner>[] :
	F extends ObjectField<infer S> ? InferShape<S> :
	F extends ClassConstructor ? InstanceType<F> :
	F extends Shape ? InferShape<F> :
	never;

type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalField<BaseFieldType> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalField<BaseFieldType> ? never : K }[keyof S];

// Forces TypeScript to evaluate and flatten intersections for clean hover tooltips
type Simplify<T> = { [K in keyof T]: T[K] } & {};

// Infers the output type of a shape by mapping over its required and optional keys
type InferShape<S extends Shape> = Simplify<{
	-readonly [K in RequiredKeys<S>]: S[K] extends BaseFieldType ? InferBaseField<S[K]> : never;
} & {
	-readonly [K in OptionalKeys<S>]?: S[K] extends OptionalField<infer F extends BaseFieldType> ? InferBaseField<F> : never;
}>;

const { hasOwnProperty: hasOwn, propertyIsEnumerable: isEnumerable } = Object.prototype;

const primitiveChecks = new Map<Function, FieldCheck>([
	[String, (value: unknown): value is string => typeof value === 'string'],
	[Number, (value: unknown): value is number => typeof value === 'number'],
	[Boolean, (value: unknown): value is boolean => typeof value === 'boolean'],
	[BigInt, (value: unknown): value is bigint => typeof value === 'bigint'],
	[Symbol, (value: unknown): value is symbol => typeof value === 'symbol'],
	[Function, (value: unknown): value is Function => typeof value === 'function'],
]);

// Unique symbols used as brands to identify different field types at runtime.
const optionalBrand: unique symbol = Symbol('optional');
const arrayBrand: unique symbol = Symbol('array');
const guardBrand: unique symbol = Symbol('guard');
const objectBrand: unique symbol = Symbol('object');

/**
 * Type guard functions for different field types.
 * Provides type guard functions to check if a field is optional, an array, a guard, or an object.
 * @param field The field to check.
 * @returns `true` if the field matches the specific type, otherwise `false`.
 */
const isOptionalField = (field: FieldType): field is OptionalField<BaseFieldType> => typeof field === 'object' && field !== null && optionalBrand in field;

/**
 * Checks if a field is an array field.
 * @param field The field to check.
 * @returns `true` if the field is an array field, otherwise `false`.
 */
const isArrayField = (field: unknown): field is ArrayField<BaseFieldType> => typeof field === 'object' && field !== null && arrayBrand in field;

/**
 * Checks if a field is a guard field.
 * @param field The field to check.
 * @returns `true` if the field is a guard field, otherwise `false`.
 */
const isGuardField = (field: unknown): field is GuardField<unknown> => typeof field === 'object' && field !== null && guardBrand in field;

/**
 * Checks if a field is an object field.
 * @param field The field to check.
 * @returns `true` if the field is an object field, otherwise `false`.
 */
const isObjectField = (field: unknown): field is ObjectField<Shape> => typeof field === 'object' && field !== null && objectBrand in field;

/**
 * Wraps a custom type guard function explicitly so it is never confused with a class constructor.
 * @param check The custom type guard function to wrap.
 * @returns A guard field containing the provided type guard function.
 */
export const guard = <T>(check: TypeGuard<T>): GuardField<T> => ({ [guardBrand]: true, check });

/**
 * Marks a field in a {@link TypeDefinition} shape as optional.
 * An optional field may be omitted or set to `undefined`.
 * @param field The field to mark as optional.
 * @returns An optional field wrapping the provided field.
 */
export const optional = <F extends BaseFieldType>(field: F): OptionalField<F> => ({ [optionalBrand]: true, inner: field });

/**
 * Validates an array field inside a shape where every element matches the given field type or inline shape.
 * @param field The field representing the type of array elements.
 * @returns An array field wrapping the provided field.
 */
export const array = <F extends BaseFieldType>(field: F): ArrayField<F> => ({ [arrayBrand]: true, inner: field });

/**
 * Marks a nested field as an object with the given shape and match mode.
 * @param shape The shape of the object.
 * @param mode The match mode to use (defaults to `'strict'`).
 * @returns An object field wrapping the provided shape.
 */
export const object = <S extends Shape>(shape: S, mode: MatchMode = TypeDefinition.Mode.strict): ObjectField<S> => ({ [objectBrand]: true, inner: shape, mode });

/** Runtime shape validator parameterized by the resolved output type `T`. */
export class TypeDefinition<T> {
	declare readonly type: T;
	readonly #check: FieldCheck;

	/** Match modes for object shape validation. */
	static Mode = {
		strict: 'strict' as const,
		structural: 'structural' as const
	} as const;

	/** Private constructor to enforce controlled instantiation. */
	private constructor(check: FieldCheck) { this.#check = check }

	/** Validates a value against this definition and narrows its type. */
	is(value: unknown): value is T {
		return this.#check(value);
	}

	/**
	 * Creates a TypeDefinition from an object shape.
	 * Defaults to `'strict'` (exact own enumerable string keys on plain objects).
	 * Pass `'structural'` to allow extra, inherited, or non-enumerable properties.
	 * @param shape The shape of the object.
	 * @param mode The match mode to use (defaults to `'strict'`).
	 * @returns A TypeDefinition for the given object shape.
	 */
	static ofShape<S extends Shape>(shape: S, mode: MatchMode = TypeDefinition.Mode.strict): TypeDefinition<InferShape<S>> {
		return new TypeDefinition(TypeDefinition.#compileShape(shape, mode));
	}

	/**
	 * Creates a TypeDefinition for an array whose elements match the given field type or inline shape.
	 * @param field The field type or inline shape for the array elements.
	 * @returns A TypeDefinition for the array.
	 */
	static ofArray<F extends BaseFieldType>(field: F): TypeDefinition<InferBaseField<F>[]> {
		return new TypeDefinition(TypeDefinition.#compileArray('root', field));
	}

	/**
	 * Creates a TypeDefinition from a primitive constructor (e.g. `String`) or class constructor (e.g. `Foo`).
	 * @param typeConstructor The constructor to create the TypeDefinition from.
	 * @returns A TypeDefinition for the given constructor.
	 */
	static ofType<C extends TypeConstructor>(typeConstructor: C): TypeDefinition<InferBaseField<C>> {
		const primitiveCheck = primitiveChecks.get(typeConstructor);

		if (primitiveCheck !== undefined) { return new TypeDefinition(primitiveCheck) }

		if (typeConstructor.prototype === undefined) {
			throw new TypeError('Invalid constructor passed to ofType(): expected a primitive or class constructor');
		}

		return new TypeDefinition((value: unknown): value is InferBaseField<C> => value instanceof typeConstructor);
	}

	/**
	 * Creates a standalone type guard from an object shape.
	 * @param shape The shape of the object.
	 * @param mode The match mode to use (defaults to `'strict'`).
	 * @returns A type guard for the given object shape.
	 */
	static typeGuardOfShape<S extends Shape>(shape: S, mode: MatchMode = TypeDefinition.Mode.strict): TypeGuard<InferShape<S>> {
		return TypeDefinition.#compileShape(shape, mode);
	}

	/**
	 * Creates a standalone type guard for an array.
	 * @param field The field type or inline shape for the array elements.
	 * @returns A type guard for the array.
	 */
	static typeGuardOfArray<F extends BaseFieldType>(field: F): TypeGuard<InferBaseField<F>[]> {
		return TypeDefinition.#compileArray('root', field);
	}

	/**
	 * Creates a standalone type guard from a primitive or class constructor.
	 * @param typeConstructor The constructor to create the type guard from.
	 * @returns A type guard for the given constructor.
	 */
	static typeGuardOfType<C extends TypeConstructor>(typeConstructor: C): TypeGuard<InferBaseField<C>> {
		const primitiveCheck = primitiveChecks.get(typeConstructor);

		if (primitiveCheck !== undefined) { return primitiveCheck as TypeGuard<InferBaseField<C>> }

		if (typeConstructor.prototype === undefined) {
			throw new TypeError('Invalid constructor passed to typeGuardOfType(): expected a primitive or class constructor');
		}

		return (value: unknown): value is InferBaseField<C> => value instanceof typeConstructor;
	}

	/**
	 * Checks if an object has any enumerable symbol properties.
	 * @param value The object to check.
	 * @returns `true` if the object has enumerable symbol properties, otherwise `false`.
	 */
	static #hasEnumerableSymbols(value: object) {
		const symbols = Object.getOwnPropertySymbols(value);

		for (let i = 0, length = symbols.length; i < length; i++) {
			if (isEnumerable.call(value, symbols[i])) { return true }
		}

		return false;
	}

	/**
	 * Compiles a type guard for an array field.
	 * @param label The label for the array field.
	 * @param inner The inner field type for the array elements.
	 * @returns A type guard for the array.
	 */
	static #compileArray<F extends BaseFieldType>(label: string, inner: F): TypeGuard<InferBaseField<F>[]> {
		const checkItem = TypeDefinition.#resolveCheck(label, inner);

		return (value: unknown): value is InferBaseField<F>[] => {
			if (!Array.isArray(value)) { return false }

			for (let i = 0, length = value.length; i < length; i++) {
				if (!checkItem(value[i])) { return false }
			}

			return true;
		};
	}

	/**
	 * Resolves the appropriate field check for a given key and field type.
	 * @param key The key associated with the field.
	 * @param field The field type to resolve.
	 * @returns A field check function for the given field.
	 */
	static #resolveCheck(key: string, field: BaseFieldType): FieldCheck {
		if (field instanceof TypeDefinition) { return field.#check }

		if (isGuardField(field)) { return field.check }

		if (isArrayField(field)) { return TypeDefinition.#compileArray(key, field.inner) }

		if (isObjectField(field)) { return TypeDefinition.#compileShape(field.inner, field.mode) }

		if (typeof field === 'function') {
			const primitiveCheck = primitiveChecks.get(field);

			if (primitiveCheck !== undefined) { return primitiveCheck }

			if (field.prototype === undefined) {
				throw new TypeError(`Invalid type definition for "${key}": wrap custom type guards with guard()`);
			}

			const FieldTypeConstructor = field as ClassConstructor;

			return (value: unknown) => value instanceof FieldTypeConstructor;
		}

		if (typeof field === 'object' && field !== null && !Array.isArray(field)) {
			return TypeDefinition.#compileShape(field, TypeDefinition.Mode.strict);
		}

		throw new TypeError(`Invalid type definition for "${key}"`);
	}

	/**
	 * Compiles a type guard for an object shape.
	 * @param shape The shape of the object.
	 * @param mode The match mode to use (defaults to `'strict'`).
	 * @returns A type guard for the object shape.
	 */
	static #compileShape<S extends Shape>(shape: S, mode: MatchMode = TypeDefinition.Mode.strict): TypeGuard<InferShape<S>> {
		if (Object.getOwnPropertySymbols(shape).length > 0) { throw new TypeError('Symbol keys are not supported in shapes') }

		const entries = Object.entries(shape);
		const requiredKeys: string[] = [];
		const optionalKeys: string[] = [];
		const requiredFieldChecks: FieldCheck[] = [];
		const optionalFieldChecks: FieldCheck[] = [];

		for (let i = 0, length = entries.length; i < length; i++) {
			const key = entries[i][0];
			const field = entries[i][1];

			if (isOptionalField(field)) {
				optionalKeys.push(key);
				optionalFieldChecks.push(TypeDefinition.#resolveCheck(key, field.inner));
			} else {
				requiredKeys.push(key);
				requiredFieldChecks.push(TypeDefinition.#resolveCheck(key, field));
			}
		}

		const requiredKeysLength = requiredKeys.length;
		const optionalKeysLength = optionalKeys.length;

		// Structural mode: allows extra, inherited, and non-enumerable properties
		if (mode === TypeDefinition.Mode.structural) {
			return optionalKeysLength === 0 ? (value: unknown): value is InferShape<S> => {
				if (value === null || typeof value !== 'object') { return false }

				const record = value as Record<string, unknown>;
				for (let i = 0; i < requiredKeysLength; i++) {
					const key = requiredKeys[i];
					if (!(key in record) || !requiredFieldChecks[i](record[key])) { return false }
				}

				return true;
			} : (value: unknown): value is InferShape<S> => {
				if (value === null || typeof value !== 'object') { return false }

				const record = value as Record<string, unknown>;
				for (let i = 0; i < requiredKeysLength; i++) {
					const key = requiredKeys[i];
					if (!(key in record) || !requiredFieldChecks[i](record[key])) { return false }
				}

				for (let i = 0; i < optionalKeysLength; i++) {
					const key = optionalKeys[i];
					if (key in record) {
						const propertyValue = record[key];
						if (propertyValue !== undefined && !optionalFieldChecks[i](propertyValue)) { return false }
					}
				}

				return true;
			};
		}

		// Strict mode: exact own enumerable string keys on non-array objects
		return optionalKeysLength === 0 ? (value: unknown): value is InferShape<S> => {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) { return false }

			const record = value as Record<string, unknown>;
			for (let i = 0; i < requiredKeysLength; i++) {
				const key = requiredKeys[i];
				if (!isEnumerable.call(record, key) || !requiredFieldChecks[i](record[key])) { return false }
			}

			let keyCount = 0;
			for (const key in record) {
				if (hasOwn.call(record, key) && ++keyCount > requiredKeysLength) { return false }
			}

			return !TypeDefinition.#hasEnumerableSymbols(record);
		} : (value: unknown): value is InferShape<S> => {
			if (value === null || typeof value !== 'object' || Array.isArray(value)) { return false }

			const record = value as Record<string, unknown>;
			for (let i = 0; i < requiredKeysLength; i++) {
				const key = requiredKeys[i];
				if (!isEnumerable.call(record, key) || !requiredFieldChecks[i](record[key])) { return false }
			}

			let expectedKeys = requiredKeysLength;
			for (let i = 0; i < optionalKeysLength; i++) {
				const key = optionalKeys[i];
				if (isEnumerable.call(record, key)) {
					expectedKeys++;
					const propertyValue = record[key];
					if (propertyValue !== undefined && !optionalFieldChecks[i](propertyValue)) { return false }
				}
			}

			let keyCount = 0;
			for (const key in record) {
				if (hasOwn.call(record, key) && ++keyCount > expectedKeys) { return false }
			}

			return !TypeDefinition.#hasEnumerableSymbols(record);
		};
	}
}

export type { MatchMode, TypeGuard };