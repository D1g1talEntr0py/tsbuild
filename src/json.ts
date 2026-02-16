import type { JsonString } from 'src/@types';

/**
 * A utility class for JSON serialization and deserialization.
 */
export class Json {
	/**
	 * Parse a JSON string into an object of type T.
	 * @param jsonString The JSON string to parse.
	 * @returns The parsed object of type T.
	 */
	static parse<T>(jsonString: JsonString<T>): T {
		return JSON.parse(jsonString) as T;
	}

	/**
	 * Serialize an object of type T into a JSON string.
	 * @param data The object to serialize.
	 * @returns The serialized JSON string.
	 */
	static serialize<T>(data: T): JsonString<T> {
		return JSON.stringify(data) as JsonString<T>;
	}
}