import { Logger } from '../logger';
import { Paths } from '../paths';
import { TypeCheckError } from '../errors';
import { newLine } from '../constants';
import { formatDiagnostics, formatDiagnosticsWithColorAndContext } from 'typescript/sync';
import type { AbsolutePath } from '../@types';
import type { Diagnostic, FormatDiagnosticsHost } from 'typescript/sync';

/** Host shared by configuration and type-check diagnostic formatting. */
export const diagnosticsHost: FormatDiagnosticsHost = { getNewLine: () => newLine, getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (fileName) => fileName };

/**
 * Deduplicates diagnostics by file/start/code to avoid duplicate reporting across diagnostic sources.
 * With isolatedDeclarations, errors like TS9007 appear in both getSemanticDiagnostics() and emit/declaration diagnostics simultaneously.
 * @param diagnostics - Diagnostics emitted by TypeScript APIs
 * @returns Deduplicated diagnostics preserving first-seen order
 */
export function dedupeDiagnostics(diagnostics: ReadonlyArray<Diagnostic>): Diagnostic[] {
	const unique = new Map<string, Diagnostic>();
	for (const diagnostic of diagnostics) {
		const key = `${diagnostic.fileName ?? ''}:${diagnostic.pos}:${diagnostic.code}`;
		if (!unique.has(key)) { unique.set(key, diagnostic) }
	}

	return Array.from(unique.values());
}

/**
 * Handles type errors in the project.
 * @param message - The message to display.
 * @param diagnostics - The diagnostics to handle.
 * @param projectDirectory - The project directory.
 */
export function handleTypeErrors(message: string, diagnostics: ReadonlyArray<Diagnostic>, projectDirectory: AbsolutePath): never {
	// Print formatted diagnostics (matches tsc output)
	Logger.error(formatDiagnosticsWithColorAndContext(diagnostics, diagnosticsHost));

	// Build error summary by file (single pass)
	const filesWithErrors = new Map<string, { count: number; line: number }>();

	for (const { fileName, startPosition } of diagnostics) {
		if (fileName === undefined) { continue }

		const line = startPosition?.line ?? 0;
		const existing = filesWithErrors.get(fileName);
		if (existing !== undefined) {
			existing.count++;
			existing.line = Math.min(existing.line, line);
		} else {
			filesWithErrors.set(fileName, { count: 1, line });
		}
	}

	// Print summary at the end (matches tsc format)
	const errorCount = diagnostics.length;
	const fileCount = filesWithErrors.size;
	const [ [ firstFileName, { line: firstLine } ] = [ '', { line: 0 } ] ] = filesWithErrors;
	const relativeFirstFileName = Paths.relative(projectDirectory, firstFileName);

	if (errorCount === 1) {
		Logger.error(`Found 1 error in ${relativeFirstFileName}:${firstLine + 1}${newLine}`);
	} else if (fileCount === 1) {
		Logger.error(`Found ${errorCount} errors in the same file, starting at: ${relativeFirstFileName}:${firstLine + 1}${newLine}`);
	} else {
		Logger.error(`Found ${errorCount} errors in ${fileCount} files.${newLine}`);
		Logger.error('Errors  Files');

		for (const [fileName, { count, line }] of filesWithErrors) { Logger.error(`     ${count}  ${fileName}:${line + 1}`) }
	}

	// Throw to signal build failure - handleBuildError will set the exit code
	throw new TypeCheckError(message, formatDiagnostics(diagnostics, diagnosticsHost));
}