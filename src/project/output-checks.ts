/** Maximum number of filesystem checks submitted together, independent of output count. */
const outputCheckBatchSize = 64;

/**
 * Checks outputs in bounded batches, preserving input-order false/error precedence.
 * Already submitted checks are drained before returning or throwing; a failed batch
 * never starts another batch. Later checks in the same batch may still perform I/O.
 * @param values - Output paths or names to check
 * @param check - Filesystem predicate; non-missing access errors must reject
 * @returns Whether every output passed its check
 */
export async function everyOutputInBatches<T>(values: readonly T[], check: (value: T) => Promise<boolean>): Promise<boolean> {
	for (let offset = 0; offset < values.length; offset += outputCheckBatchSize) {
		const results = await Promise.allSettled(values.slice(offset, offset + outputCheckBatchSize).map(async (value) => check(value)));

		for (const result of results) {
			if (result.status === 'rejected') { throw result.reason }
			if (!result.value) { return false }
		}
	}

	return true;
}
