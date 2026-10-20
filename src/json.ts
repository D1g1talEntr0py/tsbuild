import type { JsonString } from './@types';

type Replacer = (key: string, value: unknown) => unknown;

/**
 * A utility class for JSON serialization and deserialization.
 */
export class Json {
	/**
	 * Parse a JSON string into an object of type T.
	 * @param jsonString The JSON string to parse.
	 * @param transformer An optional function to transform the parsed values.
	 * @returns The parsed object of type T.
	 */
	static parse: <T>(jsonString: JsonString<T>, transformer?: Replacer) => T = JSON.parse;

	/**
	 * Serialize an object of type T into a JSON string.
	 * @param data The object to serialize.
	 * @param replacer An optional function to transform the values before serialization.
	 * @param space An optional string or number to use for indentation in the output JSON string.
	 * @returns The serialized JSON string.
	 */
	static serialize: <T>(data: T, replacer?: Replacer, space?: string | number) => JsonString<T> = JSON.stringify as <T>(data: T, replacer?: Replacer, space?: string | number) => JsonString<T>;
}