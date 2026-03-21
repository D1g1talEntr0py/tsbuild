import { describe, it, expect } from 'vitest';
import { Json } from 'src/json';
import type { JsonString } from 'src/@types';

describe('Json', () => {
	describe('parse', () => {
		it('parses a JSON string into an object', () => {
			const jsonString = '{"name":"test","value":42}' as JsonString<{ name: string; value: number }>;
			const result = Json.parse(jsonString);
			expect(result).toEqual({ name: 'test', value: 42 });
		});

		it('parses a JSON array', () => {
			const jsonString = '[1,2,3]' as JsonString<number[]>;
			expect(Json.parse(jsonString)).toEqual([1, 2, 3]);
		});

		it('parses primitive JSON values', () => {
			expect(Json.parse('"hello"' as JsonString<string>)).toBe('hello');
			expect(Json.parse('42' as JsonString<number>)).toBe(42);
			expect(Json.parse('true' as JsonString<boolean>)).toBe(true);
			expect(Json.parse('null' as JsonString<null>)).toBe(null);
		});
	});

	describe('serialize', () => {
		it('serializes an object to a JSON string', () => {
			const data = { name: 'test', value: 42 };
			const result = Json.serialize(data);
			expect(JSON.parse(result)).toEqual(data);
		});

		it('serializes arrays', () => {
			const result = Json.serialize([1, 2, 3]);
			expect(JSON.parse(result)).toEqual([1, 2, 3]);
		});

		it('serializes primitive values', () => {
			expect(Json.serialize('hello')).toBe('"hello"');
			expect(Json.serialize(42)).toBe('42');
			expect(Json.serialize(true)).toBe('true');
			expect(Json.serialize(null)).toBe('null');
		});

		it('returns a branded JsonString type', () => {
			const result: JsonString<{ x: number }> = Json.serialize({ x: 1 });
			expect(typeof result).toBe('string');
		});
	});
});
