import type { SourceFile } from 'typescript/ast';
import type { API, RetainedSourceFile } from 'typescript/sync';

/** Maximum number of source files created, or released, per batched TypeScript API round trip. */
export const sourceFileBatchSize = 32;

/** A source file name paired with the text to parse. */
export type SourceText = readonly [ fileName: string, text: string ];

/** Outcome of one request generator executed inside a batch. */
type Settled<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: unknown };

/**
 * Wraps a request generator so its failure becomes a result instead of failing the whole batch.
 * A failing generator otherwise cancels its siblings, discarding source file leases that were already created.
 * @param request - The request generator to settle
 */
function* settle<T, Yield, Next>(request: Generator<Yield, T, Next>): Generator<Yield, Settled<T>, Next> {
	try { return { ok: true, value: yield* request } } catch (error) {
		return { ok: false, error };
	}
}

/**
 * Releases every lease in one batched round trip, attempting all of them even when some fail.
 * @param api - The API that created the leases
 * @param leases - The retained source files to release
 * @throws The first release error, after every release was attempted
 */
function release(api: API, leases: readonly RetainedSourceFile[]) {
	if (leases.length === 0) { return }

	const failure = api.batch(...leases.map((lease) => settle(lease.dispose.gen()))).find((outcome) => !outcome.ok);

	if (failure !== undefined) { throw failure.error }
}

/**
 * Parses source texts through the TypeScript API in bounded batches rather than one round trip per file.
 *
 * Each batch of at most `batchSize` files is created in one round trip, handed to `consume` in input order while
 * its remote leases are held, then released in one round trip. Leases never outlive the batch: every lease that
 * was created is released even when another file in the batch fails to parse or `consume` throws.
 * The returned values may include the parsed {@link SourceFile} itself, which stays readable locally after release.
 * @param api - The TypeScript API used to parse the files
 * @param files - File names and texts to parse, in order
 * @param consume - Called once per parsed file, in input order, while its lease is held
 * @param batchSize - Maximum number of files per round trip
 * @returns The values returned by `consume`, in input order
 * @throws {RangeError} When `batchSize` is not a positive integer.
 * @throws The first creation or `consume` error once the batch's leases are released; a release error is
 *   thrown on its own, or as a `SuppressedError` when it follows a creation or `consume` error.
 */
export function parseSourceFiles<T>(api: API, files: readonly SourceText[], consume: (sourceFile: SourceFile) => T, batchSize: number = sourceFileBatchSize): T[] {
	if (!Number.isInteger(batchSize) || batchSize < 1) { throw new RangeError(`Source file batch size must be a positive integer; received ${batchSize}.`) }

	const results: T[] = [];

	/**
	 * Maps a source text tuple to a settled creation result.
	 * @param sourceText The source text tuple containing the file name and text
	 * @param sourceText[0] The file name
	 * @param sourceText[1] The file text
	 * @returns The settled result of creating the source file
	 */
	const sourceFileMapper = ([ fileName, text ]: SourceText) => settle(api.createSourceFile.gen(fileName, text))

	for (let start = 0, length = files.length; start < length; start += batchSize) {
		const batch = files.slice(start, start + batchSize);

		// A single file gains nothing from batching; the direct request also uses the binary transport.
		if (batch.length === 1) {
			const [ fileName, text ] = batch[0];

			using retained = api.createSourceFile(fileName, text);

			results.push(consume(retained.sourceFile));

			continue;
		}

		const leases: RetainedSourceFile[] = [];
		const created = api.batch(...batch.map(sourceFileMapper));

		for (const outcome of created) {
			if (outcome.ok) { leases.push(outcome.value) }
		}

		// Ensure that all leases are released even if an error occurs
		using cleanup = new DisposableStack();

		cleanup.defer(() => release(api, leases));

		for (const outcome of created) {
			if (!outcome.ok) { throw outcome.error }
		}

		for (const { sourceFile } of leases) { results.push(consume(sourceFile)) }
	}

	return results;
}
