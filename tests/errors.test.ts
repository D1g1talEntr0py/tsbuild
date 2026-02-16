import { castError, BuildError, TypeCheckError, BundleError, ConfigurationError, UnsupportedSyntaxError } from '../src/errors';
import { describe, it, expect } from 'vitest';
import { createSourceFile, ScriptTarget, SyntaxKind } from 'typescript';

describe('errors', () => {
  describe('castError', () => {
    it('should return the error if input is already an Error', () => {
      const error = new Error('test error');
      expect(castError(error)).toBe(error);
    });

    it('should create an Error from a string', () => {
      const error = castError('test error');
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('test error');
    });

    it('should create an Error with "Unknown error" for other types', () => {
      const error = castError(123);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Unknown error');
    });
  });

  describe('BuildError', () => {
    it('should set name and code correctly', () => {
      const error = new BuildError('test message', 5);
      expect(error.name).toBe('BuildError');
      expect(error.message).toBe('test message');
      expect(error.code).toBe(5);
    });
  });

  describe('TypeCheckError', () => {
    it('should set code to 1 and store diagnostics', () => {
      const error = new TypeCheckError('type error', 'diagnostic output');
      expect(error.name).toBe('TypeCheckError');
      expect(error.code).toBe(1);
      expect(error.diagnostics).toBe('diagnostic output');
    });

    it('should work without diagnostics', () => {
      const error = new TypeCheckError('type error');
      expect(error.diagnostics).toBeUndefined();
    });
  });

  describe('BundleError', () => {
    it('should set code to 2', () => {
      const error = new BundleError('bundle failed');
      expect(error.name).toBe('BundleError');
      expect(error.message).toBe('bundle failed');
      expect(error.code).toBe(2);
    });
  });

  describe('ConfigurationError', () => {
    it('should set code to 3', () => {
      const error = new ConfigurationError('invalid config');
      expect(error.name).toBe('ConfigurationError');
      expect(error.message).toBe('invalid config');
      expect(error.code).toBe(3);
    });
  });

  describe('UnsupportedSyntaxError', () => {
    it('should include syntax kind and node text in message', () => {
      const source = createSourceFile('test.ts', 'const x = 1;', ScriptTarget.Latest, true);
      const node = source.statements[0];
      const error = new UnsupportedSyntaxError(node);
      expect(error.message).toContain('Syntax not yet supported');
      expect(error.message).toContain(SyntaxKind[node.kind]);
      expect(error.message).toContain('const x = 1');
    });

    it('should use custom message when provided', () => {
      const source = createSourceFile('test.ts', 'let y = 2;', ScriptTarget.Latest, true);
      const node = source.statements[0];
      const error = new UnsupportedSyntaxError(node, 'Custom error');
      expect(error.message).toContain('Custom error');
    });

    it('should handle node without getText method', () => {
      const fakeNode = { kind: SyntaxKind.Identifier } as unknown as import('typescript').Node;
      const error = new UnsupportedSyntaxError(fakeNode);
      expect(error.message).toContain('<no text>');
      expect(error.message).toContain('Identifier');
    });

    it('should handle unknown syntax kind', () => {
      const fakeNode = { kind: 99999, getText: () => 'some text' } as unknown as import('typescript').Node;
      const error = new UnsupportedSyntaxError(fakeNode);
      expect(error.message).toContain('Unknown(99999)');
    });
  });
});