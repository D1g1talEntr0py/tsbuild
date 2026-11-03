import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSourceFiles, sourceFileBatchSize } from '../src/dts/source-file-batches';
import { TestHelper } from './scripts/test-helper';
import type { MockInstance } from 'vitest';
import type { RetainedSourceFile } from 'typescript/sync';
import type { SourceText } from '../src/dts/source-file-batches';

type TrackedLease = { readonly fileName: string; readonly retained: RetainedSourceFile; readonly release: MockInstance; released: boolean };

/**
 * Records every source file lease the shared API creates through batched requests, and whether its release request completed.
 * @returns The leases in creation order
 */
function trackLeases(): TrackedLease[] {
	const leases: TrackedLease[] = [];
	const { createSourceFile } = TestHelper.api;
	const create = createSourceFile.gen;
	vi.spyOn(createSourceFile, 'gen').mockImplementation(function* (fileName, sourceText, options) {
		const retained = yield* create(fileName, sourceText, options);
		const { dispose } = retained;
		const disposeGenerator = dispose.gen;
		const lease: TrackedLease = {
			fileName,
			retained,
			released: false,
			release: vi.spyOn(dispose, 'gen').mockImplementation(function* () {
				yield* disposeGenerator();
				lease.released = true;
			})
		};
		leases.push(lease);
		return retained;
	});

	return leases;
}

/**
 * Asserts that every lease was released exactly once.
 * @param leases - Tracked leases
 */
function expectAllReleased(leases: readonly TrackedLease[]) {
	for (const { fileName, release, released } of leases) {
		expect(release, fileName).toHaveBeenCalledTimes(1);
		expect(released, fileName).toBe(true);
	}
}

const declarations = (count: number, prefix = 'file'): SourceText[] => Array.from({ length: count }, (_, i) => [ `/batch/${prefix}-${i}.d.ts`, `export declare const value${i}: ${i};` ]);
const fileName = ({ fileName }: { fileName: string }) => fileName;
const batchSizes = (batch: MockInstance) => batch.mock.calls.map((args) => args.length);

describe('parseSourceFiles', () => {
	afterEach(() => { vi.restoreAllMocks() });

	it('makes no API requests for empty input', () => {
		const batch = vi.spyOn(TestHelper.api, 'batch');
		const leases = trackLeases();
		const consume = vi.fn();

		expect(parseSourceFiles(TestHelper.api, [], consume)).toEqual([]);
		expect(batch).not.toHaveBeenCalled();
		expect(leases).toHaveLength(0);
		expect(consume).not.toHaveBeenCalled();
	});

	it('creates and releases leases in bounded batches and returns results in input order', () => {
		const files = declarations(70);
		const batch = vi.spyOn(TestHelper.api, 'batch');
		const leases = trackLeases();

		const result = parseSourceFiles(TestHelper.api, files, fileName);

		expect(result).toEqual(files.map(([ name ]) => name));
		expect(sourceFileBatchSize).toBe(32);
		// Create and release alternate per batch: 32 + 32 + 6 files
		expect(batchSizes(batch)).toEqual([ 32, 32, 32, 32, 6, 6 ]);
		expect(leases.map(fileName)).toEqual(files.map(([ name ]) => name));
		expectAllReleased(leases);
	});

	it('honours a custom batch size', () => {
		const batch = vi.spyOn(TestHelper.api, 'batch');

		expect(parseSourceFiles(TestHelper.api, declarations(5), fileName, 2)).toHaveLength(5);
		// The final single-file batch uses a direct request
		expect(batchSizes(batch)).toEqual([ 2, 2, 2, 2 ]);
	});

	it('parses a single file without a batch request', () => {
		const batch = vi.spyOn(TestHelper.api, 'batch');

		expect(parseSourceFiles(TestHelper.api, declarations(1), (sourceFile) => sourceFile.statements.length)).toEqual([ 1 ]);
		expect(batch).not.toHaveBeenCalled();
	});

	it.each([ 0, -1, 1.5, Number.NaN ])('rejects batch size %s before making requests', (size) => {
		const batch = vi.spyOn(TestHelper.api, 'batch');

		expect(() => parseSourceFiles(TestHelper.api, declarations(2), fileName, size)).toThrow(RangeError);
		expect(batch).not.toHaveBeenCalled();
	});

	it('releases every created lease when another file in the batch fails to parse', () => {
		const files: SourceText[] = [ ...declarations(2, 'before'), [ '', 'export {};' ], ...declarations(2, 'after') ];
		const leases = trackLeases();
		const consume = vi.fn(fileName);

		expect(() => parseSourceFiles(TestHelper.api, files, consume)).toThrow('fileName must not be empty');
		// Files after the failure were created too; none are processed and all are released
		expect(leases.map(fileName)).toEqual([ '/batch/before-0.d.ts', '/batch/before-1.d.ts', '/batch/after-0.d.ts', '/batch/after-1.d.ts' ]);
		expectAllReleased(leases);
		expect(consume).not.toHaveBeenCalled();
		// The API remains usable afterwards
		expect(parseSourceFiles(TestHelper.api, declarations(3), fileName)).toHaveLength(3);
	});

	it('makes no release request when every file in a batch fails to parse', () => {
		const batch: MockInstance = vi.spyOn(TestHelper.api, 'batch');

		expect(() => parseSourceFiles(TestHelper.api, [ [ '', 'export {};' ], [ '', 'export {};' ] ], fileName)).toThrow('fileName must not be empty');
		expect(batchSizes(batch)).toEqual([ 2 ]);
	});

	it('releases the current batch and stops when processing throws', () => {
		const failure = new Error('malformed declaration');
		const batch = vi.spyOn(TestHelper.api, 'batch');
		const leases = trackLeases();
		const consume = vi.fn((sourceFile: { fileName: string }) => {
			if (sourceFile.fileName.endsWith('file-1.d.ts')) { throw failure }
			return sourceFile.fileName;
		});

		expect(() => parseSourceFiles(TestHelper.api, declarations(6), consume, 3)).toThrow(failure);
		expect(consume).toHaveBeenCalledTimes(2);
		expect(leases).toHaveLength(3);
		expectAllReleased(leases);
		// One create and one release batch; later batches are never requested
		expect(batchSizes(batch)).toEqual([ 3, 3 ]);
	});

	it('attempts every release and reports a release failure', () => {
		const releaseFailure = new Error('release failed');
		const leases = trackLeases();
		let configured = false;
		const failFirstRelease = () => {
			if (!configured) { leases[0].release.mockImplementationOnce(function* () { throw releaseFailure }) }
			configured = true;
		};

		expect(() => parseSourceFiles(TestHelper.api, declarations(3), (sourceFile) => {
			failFirstRelease();
			return sourceFile.fileName;
		})).toThrow(releaseFailure);
		expect(leases[0].release).toHaveBeenCalledTimes(1);
		expectAllReleased(leases.slice(1));

		// The failed release never reached the server, so it can still be released
		leases[0].retained.dispose();
	});

	it('reports a release failure together with the processing failure it follows', () => {
		const releaseFailure = new Error('release failed');
		const failure = new Error('malformed declaration');
		const leases = trackLeases();
		let thrown: unknown;

		try {
			parseSourceFiles(TestHelper.api, declarations(2), () => {
				leases[0].release.mockImplementationOnce(function* () { throw releaseFailure });
				throw failure;
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(SuppressedError);
		expect(thrown).toMatchObject({ error: releaseFailure, suppressed: failure });
		expect(leases[0].release).toHaveBeenCalledTimes(1);
		expectAllReleased(leases.slice(1));
		leases[0].retained.dispose();
	});
});
