import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticCategory, formatDiagnostics, formatDiagnosticsWithColorAndContext } from 'typescript/sync';
import { toRootedFilePath } from 'typescript/path';
import { dedupeDiagnostics, diagnosticsHost, handleTypeErrors } from '../../src/project/diagnostics';
import { TypeCheckError } from '../../src/errors';
import { Logger } from '../../src/logger';
import { Paths } from '../../src/paths';
import type { Diagnostic } from 'typescript/sync';

const projectDirectory = Paths.absolute('/project');
const newLine = '\n';
const indexFile = toRootedFilePath('/project/src/index.ts', undefined);
const otherFile = toRootedFilePath('/project/src/other.ts', undefined);
const diagnostic: Diagnostic = { category: DiagnosticCategory.Error, code: 2322, fileName: indexFile, pos: 6, end: 7, startPosition: { line: 1, character: 0 }, text: 'Type mismatch' };
const atStart = { pos: 0, startPosition: { line: 0, character: 0 } };

afterEach(() => { vi.restoreAllMocks() });

describe('dedupeDiagnostics', () => {
	it('keeps the first diagnostic for each file/start/code in input order', () => {
		const differentStart = { ...diagnostic, ...atStart };
		const differentCode = { ...diagnostic, code: 9007 };
		const differentFile = { ...diagnostic, fileName: otherFile };
		const globalDiagnostic = { ...diagnostic, fileName: undefined, startPosition: undefined };
		const result = dedupeDiagnostics([ diagnostic, { ...diagnostic, text: 'Duplicate' }, differentStart, differentCode, differentFile, globalDiagnostic, { ...globalDiagnostic }, { ...globalDiagnostic, pos: 0 } ]);
		expect(result).toEqual([ diagnostic, differentStart, differentCode, differentFile, globalDiagnostic, { ...globalDiagnostic, pos: 0 } ]);
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
		expect(errorLogger).toHaveBeenNthCalledWith(2, `Found 1 error in src/index.ts:2${newLine}`);
	});

	it('reports the earliest line for multiple diagnostics in one file', () => {
		const errorLogger = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		expect(() => handleTypeErrors('failed', [ diagnostic, { ...diagnostic, ...atStart } ], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger).toHaveBeenLastCalledWith(`Found 2 errors in the same file, starting at: src/index.ts:1${newLine}`);
	});

	it('preserves file order and counts global diagnostics only in the total', () => {
		const errorLogger = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		expect(() => handleTypeErrors('failed', [ diagnostic, { ...diagnostic, fileName: otherFile, ...atStart }, { ...diagnostic, ...atStart }, { ...diagnostic, fileName: undefined } ], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger.mock.calls.slice(1)).toEqual([
			[ `Found 4 errors in 2 files.${newLine}` ],
			[ 'Errors  Files' ],
			[ '     2  /project/src/index.ts:1' ],
			[ '     1  /project/src/other.ts:1' ]
		]);
	});

	it('preserves the fileless and empty diagnostic summaries', () => {
		const errorLogger = vi.spyOn(Logger, 'error').mockImplementation(() => {});
		expect(() => handleTypeErrors('failed', [ { ...diagnostic, fileName: undefined } ], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger).toHaveBeenLastCalledWith(`Found 1 error in ${Paths.relative(projectDirectory, '')}:1${newLine}`);
		expect(() => handleTypeErrors('failed', [], projectDirectory)).toThrow(TypeCheckError);
		expect(errorLogger.mock.calls.slice(-2)).toEqual([ [ `Found 0 errors in 0 files.${newLine}` ], [ 'Errors  Files' ] ]);
	});
});

describe('diagnosticsHost', () => {
	it('uses POSIX conventions without changing filenames', () => {
		expect(diagnosticsHost.getNewLine()).toBe(newLine);
		expect(diagnosticsHost.getCurrentDirectory()).toBe(process.cwd());
		expect(diagnosticsHost.getCanonicalFileName('Mixed/Case.ts')).toBe('Mixed/Case.ts');
	});
});