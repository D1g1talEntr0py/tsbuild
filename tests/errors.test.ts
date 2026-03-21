import { describe, it, expect } from 'vitest';
import { BuildError, TypeCheckError, BundleError, ConfigurationError, UnsupportedSyntaxError, castError } from 'src/errors';
import ts from 'typescript';

describe('castError', () => {
	it('returns Error as-is', () => {
		const error = new Error('test');
		expect(castError(error)).toBe(error);
	});

	it('wraps string in Error', () => {
		const result = castError('test message');
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('test message');
	});

	it('wraps unknown in Error with default message', () => {
		const result = castError(42);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('Unknown error');
	});

	it('wraps null in Error with default message', () => {
		const result = castError(null);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('Unknown error');
	});

	it('wraps undefined in Error with default message', () => {
		const result = castError(undefined);
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('Unknown error');
	});
});

describe('BuildError', () => {
	it('sets message and default exit code 1', () => {
		const error = new BuildError('build failed');
		expect(error.message).toBe('build failed');
		expect(error.code).toBe(1);
		expect(error.name).toBe('BuildError');
	});

	it('accepts custom exit code', () => {
		const error = new BuildError('custom', 4);
		expect(error.code).toBe(4);
	});

	it('is an instance of Error', () => {
		expect(new BuildError('test')).toBeInstanceOf(Error);
	});

	it('captures stack trace', () => {
		const error = new BuildError('test');
		expect(error.stack).toBeDefined();
		expect(error.stack).toContain('errors.test.ts');
	});
});

describe('TypeCheckError', () => {
	it('sets exit code 1 and includes diagnostics', () => {
		const error = new TypeCheckError('type check failed', 'some diagnostics');
		expect(error.code).toBe(1);
		expect(error.diagnostics).toBe('some diagnostics');
		expect(error.name).toBe('TypeCheckError');
	});

	it('diagnostics are optional', () => {
		const error = new TypeCheckError('type check failed');
		expect(error.diagnostics).toBeUndefined();
	});

	it('is an instance of BuildError', () => {
		expect(new TypeCheckError('test')).toBeInstanceOf(BuildError);
	});
});

describe('BundleError', () => {
	it('sets exit code 2', () => {
		const error = new BundleError('bundle failed');
		expect(error.code).toBe(2);
		expect(error.name).toBe('BundleError');
	});

	it('is an instance of BuildError', () => {
		expect(new BundleError('test')).toBeInstanceOf(BuildError);
	});
});

describe('ConfigurationError', () => {
	it('sets exit code 3', () => {
		const error = new ConfigurationError('bad config');
		expect(error.code).toBe(3);
		expect(error.name).toBe('ConfigurationError');
	});

	it('is an instance of BuildError', () => {
		expect(new ConfigurationError('test')).toBeInstanceOf(BuildError);
	});
});

describe('UnsupportedSyntaxError', () => {
	it('formats syntax kind name in message', () => {
		const sourceFile = ts.createSourceFile('test.d.ts', 'export class Foo {}', ts.ScriptTarget.ESNext, true);
		const classNode = sourceFile.statements[0];
		const error = new UnsupportedSyntaxError(classNode);
		expect(error.message).toContain('ClassDeclaration');
		expect(error.message).toContain('Syntax not yet supported');
		expect(error.name).toBe('UnsupportedSyntaxError');
	});

	it('uses custom message', () => {
		const sourceFile = ts.createSourceFile('test.d.ts', 'const x = 1;', ts.ScriptTarget.ESNext, true);
		const node = sourceFile.statements[0];
		const error = new UnsupportedSyntaxError(node, 'Custom error');
		expect(error.message).toContain('Custom error');
	});

	it('truncates long node text to 100 characters', () => {
		const longCode = `export const ${'x'.repeat(200)} = 1;`;
		const sourceFile = ts.createSourceFile('test.d.ts', longCode, ts.ScriptTarget.ESNext, true);
		const node = sourceFile.statements[0];
		const error = new UnsupportedSyntaxError(node);
		// The getText() slice(0, 100) should truncate
		const textPart = error.message.split(' - "')[1];
		expect(textPart.replace('"', '').length).toBeLessThanOrEqual(101);
	});

	it('handles node without getText method', () => {
		const fakeNode = { kind: ts.SyntaxKind.Unknown } as ts.Node;
		const error = new UnsupportedSyntaxError(fakeNode);
		expect(error.message).toContain('<no text>');
	});

	it('handles unknown syntax kind', () => {
		const fakeNode = { kind: 99999, getText: () => 'test' } as unknown as ts.Node;
		const error = new UnsupportedSyntaxError(fakeNode);
		expect(error.message).toContain('Unknown(99999)');
	});

	it('is an instance of BundleError', () => {
		const sourceFile = ts.createSourceFile('test.d.ts', 'const x = 1;', ts.ScriptTarget.ESNext, true);
		expect(new UnsupportedSyntaxError(sourceFile.statements[0])).toBeInstanceOf(BundleError);
	});

	it('has exit code 2 (inherited from BundleError)', () => {
		const sourceFile = ts.createSourceFile('test.d.ts', 'const x = 1;', ts.ScriptTarget.ESNext, true);
		const error = new UnsupportedSyntaxError(sourceFile.statements[0]);
		expect(error.code).toBe(2);
	});
});
