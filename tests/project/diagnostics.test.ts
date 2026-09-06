import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSourceFile, DiagnosticCategory, formatDiagnostics, formatDiagnosticsWithColorAndContext, ScriptTarget, sys } from 'typescript';
import { dedupeDiagnostics, diagnosticsHost, handleTypeErrors } from '../../src/project/diagnostics';
import { TypeCheckError } from '../../src/errors';
import { Logger } from '../../src/logger';
import { Paths } from '../../src/paths';
import type { Diagnostic } from 'typescript';

const projectDirectory = Paths.absolute('/project');
const sourceFile = createSourceFile('/project/src/index.ts', 'first\nsecond\nthird\n', ScriptTarget.Latest);
const diagnostic: Diagnostic = { category: DiagnosticCategory.Error, code: 2322, file: sourceFile, start: 6, length: 1, messageText: 'Type mismatch' };

afterEach(() => { vi.restoreAllMocks() });

describe('dedupeDiagnostics', () => {
	it('keeps the first diagnostic for each file/start/code in input order', () => {
		const differentStart = { ...diagnostic, start: 0 };
		const differentCode = { ...diagnostic, code: 9007 };
		const differentFile = { ...diagnostic, file: createSourceFile('/project/src/other.ts', 'value', ScriptTarget.Latest) };
		const globalDiagnostic = { ...diagnostic, file: undefined, start: undefined };
		const result = dedupeDiagnostics([ diagnostic, { ...diagnostic, messageText: 'Duplicate' }, differentStart, differentCode, differentFile, globalDiagnostic, { ...globalDiagnostic }, { ...globalDiagnostic, start: 0 } ]);
		expect(result).toEqual([ diagnostic, differentStart, differentCode, differentFile, globalDiagnostic, { ...globalDiagnostic, start: 0 } ]);
		expect(result[0]).toBe(diagnostic);
	});

	it('accepts an empty input', () => {
		expect(dedupeDiagnostics([])).toEqual([]);
	});
});

describe('handleTypeErrors', () => {
	it('logs TypeScript formatting and throws the original message and plain diagnostics', () => {
		const errorLogger = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		const diagnostics = [ diagnostic ];
		expect(() => handleTypeErrors('Type-checking failed', diagnostics, projectDirectory)).toThrow(TypeCheckError);
		try {
			handleTypeErrors('Type-checking failed', diagnostics, projectDirectory);
		} catch (error) {
			expect(error).toMatchObject({ message: 'Type-checking failed', code: 1, diagnostics: formatDiagnostics(diagnostics, diagnosticsHost) });
		}
		expect(errorLogger).toHaveBeenNthCalledWith(1, formatDiagnosticsWithColorAndContext(diagnostics, diagnosticsHost));
		expect(errorLogger).toHaveBeenNthCalledWith(2, `Found 1 error in src/index.ts:2${sys.newLine}`);
	});

	it('reports the earliest line for multiple diagnostics in one file', () => {
		const errorLogger = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		expect(() => handleTypeErrors('failed', [ diagnostic, { ...diagnostic, start: 0 } ], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger).toHaveBeenLastCalledWith(`Found 2 errors in the same file, starting at: src/index.ts:1${sys.newLine}`);
	});

	it('preserves file order and counts global diagnostics only in the total', () => {
		const errorLogger = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		const otherFile = createSourceFile('/project/src/other.ts', 'value', ScriptTarget.Latest);
		expect(() => handleTypeErrors('failed', [ diagnostic, { ...diagnostic, file: otherFile, start: 0 }, { ...diagnostic, start: 0 }, { ...diagnostic, file: undefined } ], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger.mock.calls.slice(1)).toEqual([
			[ `Found 4 errors in 2 files.${sys.newLine}` ],
			[ 'Errors  Files' ],
			[ '     2  /project/src/index.ts:1' ],
			[ '     1  /project/src/other.ts:1' ]
		]);
	});

	it('preserves the fileless and empty diagnostic summaries', () => {
		const errorLogger = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		expect(() => handleTypeErrors('failed', [ { ...diagnostic, file: undefined } ], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger).toHaveBeenLastCalledWith(`Found 1 error in ${Paths.relative(projectDirectory, '')}:1${sys.newLine}`);
		expect(() => handleTypeErrors('failed', [], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger.mock.calls.slice(-2)).toEqual([ [ `Found 0 errors in 0 files.${sys.newLine}` ], [ 'Errors  Files' ] ]);
	});
});

describe('diagnosticsHost', () => {
	it('uses TypeScript system conventions without changing filenames', () => {
		expect(diagnosticsHost.getNewLine()).toBe(sys.newLine);
		expect(diagnosticsHost.getCurrentDirectory()).toBe(sys.getCurrentDirectory());
		expect(diagnosticsHost.getCanonicalFileName('Mixed/Case.ts')).toBe('Mixed/Case.ts');
	});
});