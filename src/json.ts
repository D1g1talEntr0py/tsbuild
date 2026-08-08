import type { JsonString } from './@types';

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
	static parse<T>(jsonString: JsonString<T>, transformer?: (key: string, value: unknown) => unknown): T {
		return JSON.parse(jsonString, transformer) as T;
	}

	/**
	 * Serialize an object of type T into a JSON string.
	 * @param data The object to serialize.
	 * @param replacer An optional function to transform the values before serialization.
	 * @param space An optional string or number to use for indentation in the output JSON string.
	 * @returns The serialized JSON string.
	 */
	static serialize<T>(data: T, replacer?: (key: string, value: unknown) => unknown, space?: string | number): JsonString<T> {
		return JSON.stringify(data, replacer, space) as JsonString<T>;
	}
}