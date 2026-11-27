import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess, execFile, execFileSync, type ExecFileException } from 'node:child_process';
import { measureToolMemory, type BenchmarkScenario, type Tool } from './scripts/benchmark';

vi.mock('node:child_process', async importOriginal => ({
	...await importOriginal<typeof import('node:child_process')>(),
	execFile: vi.fn(),
	execFileSync: vi.fn(),
}));

const scenario: BenchmarkScenario = { id: 'standard', label: 'standard', moduleCount: 100, entryCount: 1 };
const tool: Tool = { id: 'build', outDir: 'dist', command: () => [ 'node', [ 'build.js' ] ] };
let complete: (error?: ExecFileException) => void;

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.mocked(execFile).mockImplementation((_cmd, _args, _options, callback) => {
		const child = new ChildProcess();
		Object.defineProperty(child, 'pid', { value: 123 });
		complete = error => { callback?.(error ?? null, 'captured stdout', 'captured stderr') };
		return child;
	});
});

afterEach(() => { vi.useRealTimers() });

describe('benchmark process-tree memory', () => {
	it('takes the peak sum of the build and all descendants, excluding the harness and unrelated processes', async () => {
		vi.mocked(execFileSync)
			.mockReturnValueOnce('999 1 999999\n125 124 30720\n123 999 10240\n126 999 999999\n124 123 20480\n')
			.mockReturnValueOnce('999 1 999999\n123 999 10240\n124 123 10240\n');
		const result = measureToolMemory(tool, '/benchmark', scenario);
		await vi.advanceTimersByTimeAsync(10);
		complete();
		await expect(result).resolves.toBe(60 * 1024 * 1024);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('takes the maximum, not the sum, of sequential type-check and bundle peaks', async () => {
		vi.mocked(execFileSync)
			.mockReturnValueOnce('123 999 10240\n124 123 51200\n')
			.mockReturnValueOnce('123 999 20480\n124 123 61440\n');
		const result = measureToolMemory({ ...tool, typeCheck: true }, '/benchmark', scenario);
		await vi.advanceTimersByTimeAsync(5);
		complete();
		await vi.advanceTimersByTimeAsync(5);
		complete();
		await expect(result).resolves.toBe(80 * 1024 * 1024);
		expect(vi.mocked(execFile).mock.calls.map(([cmd]) => cmd)).toEqual([ 'pnpm', 'node' ]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('surfaces subprocess failures with captured output and stops sampling', async () => {
		const result = measureToolMemory(tool, '/benchmark', scenario);
		complete(Object.assign(new Error('build failed'), { cmd: 'node build.js' }));
		await expect(result).rejects.toThrow('Memory measurement command failed: node build.js\nstdout:\ncaptured stdout\nstderr:\ncaptured stderr');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('waits for the build to finish and reports sampling failures instead of partial measurements', async () => {
		vi.mocked(execFileSync)
			.mockReturnValueOnce('123 999 10240\n')
			.mockImplementationOnce(() => { throw new Error('ps failed') });
		const result = measureToolMemory(tool, '/benchmark', scenario);
		await vi.advanceTimersByTimeAsync(10);
		expect(vi.getTimerCount()).toBe(0);
		complete();
		await expect(result).rejects.toThrow('Failed to sample process-tree RSS for node.');
	});

	it('does not report zero as a successful measurement when the build exits before sampling', async () => {
		const result = measureToolMemory(tool, '/benchmark', scenario);
		complete();
		await expect(result).rejects.toThrow('No process-tree RSS samples captured for node.');
		expect(vi.getTimerCount()).toBe(0);
	});
});
