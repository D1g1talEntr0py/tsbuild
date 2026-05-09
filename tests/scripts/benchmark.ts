#!/usr/bin/env tsx
/**
 * Performance benchmark script for tsbuild.
 *
 * Uses tinybench to run each scenario multiple times and compute statistically
 * reliable medians. Task functions return `overriddenDuration` so tinybench
 * uses tsbuild's self-reported time rather than wall-clock (which includes tsx
 * startup overhead). Results are appended to docs/performance-measurements.json.
 *
 * Usage:
 *   pnpm bench
 */
import { Bench, type Task } from 'tinybench';
import { execSync, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ITERATIONS = 5;

const root = fileURLToPath(new URL('../..', import.meta.url));
const measurementsPath = join(root, 'docs/performance-measurements.json');
const tsbuildCache = join(root, '.tsbuild');
const benchmarkFile = join(root, 'src/logger.ts');
const buildInfoPath = join(root, '.tsbuild', 'tsconfig.tsbuildinfo');
const tsbuildBin = join(root, 'dist/tsbuild.js');
const ansiPattern = /\x1b\[[0-9;]*m/g;

// ─── Build runner ──────────────────────────────────────────────────────────────

function ensureBuilt(): void {
	if (existsSync(tsbuildBin)) { return }

	console.log('Compiled tsbuild not found at dist/tsbuild.js — building first …');
	execFileSync('tsx', [ './src/tsbuild.ts' ], { cwd: root, stdio: 'inherit' });
}

function runBuild(): string {
	const result = spawnSync(process.execPath, [ tsbuildBin ], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, FORCE_COLOR: '0' },
	});

	if (result.status !== 0) {
		console.error(`Build failed:\n${result.stderr}`);
		process.exit(1);
	}

	return (result.stdout + result.stderr).replace(ansiPattern, '');
}

// ─── Output parser ─────────────────────────────────────────────────────────────

interface PhaseBreakdown { emit_ms?: number; finalize_ms?: number; diagnostics_ms?: number }

interface RunResult {
	total_ms: number;
	phases: { type_checking_ms: number; transpile_ms: number; bundle_declarations_ms: number };
	phase_breakdown: { type_checking: PhaseBreakdown };
}

interface Measurement {
	date: string;
	build_type: string;
	description: string;
	total_ms: number;
	stddev_ms: number;
	samples: number;
	phases: { type_checking_ms: number; transpile_ms: number; bundle_declarations_ms: number };
	phase_breakdown: { type_checking: PhaseBreakdown };
	speedup_vs_cold?: { total_ms: number; percent: number };
	notes?: string;
}

function parseOutput(output: string): RunResult {
	const num = (pattern: RegExp): number | undefined => {
		const m = pattern.exec(output);
		return m ? parseInt(m[1], 10) : undefined;
	};

	return {
		total_ms: num(/Completed in (\d+)ms/) ?? 0,
		phases: {
			type_checking_ms: num(/✓ Type-checking \((\d+)ms\)/) ?? 0,
			transpile_ms: num(/✓ Transpile \((\d+)ms\)/) ?? 0,
			bundle_declarations_ms: num(/✓ Bundle Declarations \((\d+)ms\)/) ?? 0,
		},
		phase_breakdown: {
			type_checking: {
				emit_ms: num(/\bEmit\b\s+(\d+)ms/),
				finalize_ms: num(/\bFinalize\b\s+(\d+)ms/),
				diagnostics_ms: num(/\bDiagnostics\b\s+(\d+)ms/),
			},
		},
	};
}

// ─── Statistics helpers ────────────────────────────────────────────────────────

function pickMedianPhases(runs: RunResult[]): Pick<Measurement, 'phases' | 'phase_breakdown'> {
	const med = (fn: (r: RunResult) => number): number => {
		const vals = runs.map(fn).sort((a, b) => a - b);
		const mid = Math.floor(vals.length / 2);
		return Math.round(vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid]);
	};

	return {
		phases: {
			type_checking_ms: med(r => r.phases.type_checking_ms),
			transpile_ms: med(r => r.phases.transpile_ms),
			bundle_declarations_ms: med(r => r.phases.bundle_declarations_ms),
		},
		phase_breakdown: {
			type_checking: {
				emit_ms: runs[0].phase_breakdown.type_checking.emit_ms !== undefined
					? med(r => r.phase_breakdown.type_checking.emit_ms ?? 0) : undefined,
				finalize_ms: runs[0].phase_breakdown.type_checking.finalize_ms !== undefined
					? med(r => r.phase_breakdown.type_checking.finalize_ms ?? 0) : undefined,
				diagnostics_ms: runs[0].phase_breakdown.type_checking.diagnostics_ms !== undefined
					? med(r => r.phase_breakdown.type_checking.diagnostics_ms ?? 0) : undefined,
			},
		},
	};
}

function taskLatency(task: Task) {
	const r = task.result;
	if (r.state !== 'completed') {
		throw new Error(`Benchmark task '${task.name}' did not complete (state: ${r.state})`);
	}
	return r.latency;
}

function makeBench(): Bench {
	return new Bench({ iterations: ITERATIONS, time: 0, warmup: false, throws: true });
}

function addProgressListener(bench: Bench, label: string): void {
	process.stdout.write(`  ${label}: `);
	bench.addEventListener('cycle', () => { process.stdout.write('.') });
	bench.addEventListener('complete', () => { process.stdout.write('\n') });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; name: string };
const date = new Date().toISOString().slice(0, 10);

ensureBuilt();

console.log(`\ntsbuild v${pkg.version} — benchmark (${ITERATIONS} iterations, dist build)\n`);

// 1. Cold build — clear cache before every iteration
console.log('1/3 Cold build');
const coldRuns: RunResult[] = [];
const coldBench = makeBench();
coldBench.add('cold', () => {
	rmSync(tsbuildCache, { recursive: true, force: true });
	const run = parseOutput(runBuild());
	coldRuns.push(run);
	return { overriddenDuration: run.total_ms };
});
addProgressListener(coldBench, 'running');
await coldBench.run();
const coldLatency = taskLatency(coldBench.tasks[0]);

// 2. Incremental — no changes (prime cache first, then run N iterations)
console.log('2/3 Incremental (no changes)');
runBuild(); // establish warm cache
const noChangeRuns: RunResult[] = [];
const noChangeBench = makeBench();
noChangeBench.add('incremental-clean', () => {
	const run = parseOutput(runBuild());
	noChangeRuns.push(run);
	return { overriddenDuration: run.total_ms };
});
addProgressListener(noChangeBench, 'running');
await noChangeBench.run();
const noChangeLatency = taskLatency(noChangeBench.tasks[0]);

// 3. Incremental — with a source file change (append + revert around each iteration)
// We snapshot+restore tsconfig.tsbuildinfo alongside the source file so that each
// iteration starts with the same tsbuildinfo state, ensuring TypeScript always
// detects the change (otherwise tsbuildinfo records the changed-file hash after
// iteration 1, and iteration 2 sees the same hash → spurious no-change result).
console.log('3/3 Incremental (with source change to src/logger.ts)');
const withChangeRuns: RunResult[] = [];
const withChangeBench = makeBench();
let buildInfoSnapshot: Buffer | undefined;
withChangeBench.add('incremental-change', () => {
	const run = parseOutput(runBuild());
	withChangeRuns.push(run);
	return { overriddenDuration: run.total_ms };
}, {
	beforeEach() {
		try { buildInfoSnapshot = readFileSync(buildInfoPath) } catch { buildInfoSnapshot = undefined }
		appendFileSync(benchmarkFile, '\n// bench\n');
	},
	afterEach() {
		execSync(`git checkout ${benchmarkFile}`, { cwd: root, stdio: 'ignore' });
		if (buildInfoSnapshot !== undefined) { writeFileSync(buildInfoPath, buildInfoSnapshot) }
	},
});
addProgressListener(withChangeBench, 'running');
await withChangeBench.run();
const withChangeLatency = taskLatency(withChangeBench.tasks[0]);

// ─── Build measurement records ─────────────────────────────────────────────────

const coldPhases = pickMedianPhases(coldRuns);
const noChangePhases = pickMedianPhases(noChangeRuns);
const withChangePhases = pickMedianPhases(withChangeRuns);

// tinybench latency stats are in ms (overriddenDuration was in ms)
const coldMedian = Math.round(coldLatency.p50);
const noChangeMedian = Math.round(noChangeLatency.p50);
const withChangeMedian = Math.round(withChangeLatency.p50);

const coldRecord: Measurement = {
	date,
	build_type: 'cold_build_fresh_cache',
	description: 'Cold build after clearing .tsbuild cache',
	total_ms: coldMedian,
	stddev_ms: Math.round(coldLatency.sd),
	samples: coldLatency.samplesCount,
	...coldPhases,
};

const noChangeRecord: Measurement = {
	date,
	build_type: 'incremental_no_changes',
	description: 'Incremental rebuild with no file changes',
	total_ms: noChangeMedian,
	stddev_ms: Math.round(noChangeLatency.sd),
	samples: noChangeLatency.samplesCount,
	...noChangePhases,
	speedup_vs_cold: {
		total_ms: coldMedian - noChangeMedian,
		percent: parseFloat(((1 - noChangeMedian / coldMedian) * 100).toFixed(1)),
	},
};

const withChangeRecord: Measurement = {
	date,
	build_type: 'incremental_with_change',
	description: 'Incremental rebuild after modifying src/logger.ts',
	total_ms: withChangeMedian,
	stddev_ms: Math.round(withChangeLatency.sd),
	samples: withChangeLatency.samplesCount,
	...withChangePhases,
	speedup_vs_cold: {
		total_ms: coldMedian - withChangeMedian,
		percent: parseFloat(((1 - withChangeMedian / coldMedian) * 100).toFixed(1)),
	},
};

// ─── Append to measurement log ─────────────────────────────────────────────────

const log = JSON.parse(readFileSync(measurementsPath, 'utf8')) as { measurements: Measurement[] };
log.measurements.push(coldRecord, noChangeRecord, withChangeRecord);
writeFileSync(measurementsPath, JSON.stringify(log, null, 2) + '\n');

// ─── Summary table ─────────────────────────────────────────────────────────────

const col = (n: number) => String(n).padStart(6);
const sd = (n: number) => `±${n}ms`.padStart(8);
const pct = (n: number | undefined) => n !== undefined ? (n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`) : 'n/a';
const topBorder = '┌─────────────────────────────────────────────────────────────────────────────┐';
const headerText = `  tsbuild v${pkg.version} — benchmark results (p50 of ${ITERATIONS} runs)`;
const headerRow = `│${headerText.padEnd(topBorder.length - 2)}│`;

console.log(`
${topBorder}
${headerRow}
├────────────────────────┬────────┬──────────┬─────────────┬──────────────────┤
│  Scenario              │  p50   │  stddev  │ Type-check  │ Speedup vs cold  │
├────────────────────────┼────────┼──────────┼─────────────┼──────────────────┤
│  Cold build            │${col(coldMedian)}ms│ ${sd(coldRecord.stddev_ms)} │${col(coldPhases.phases.type_checking_ms)}ms     │       baseline   │
│  Incremental (clean)   │${col(noChangeMedian)}ms│ ${sd(noChangeRecord.stddev_ms)} │${col(noChangePhases.phases.type_checking_ms)}ms     │${String(pct(noChangeRecord.speedup_vs_cold?.percent)).padStart(16)}  │
│  Incremental (change)  │${col(withChangeMedian)}ms│ ${sd(withChangeRecord.stddev_ms)} │${col(withChangePhases.phases.type_checking_ms)}ms     │${String(pct(withChangeRecord.speedup_vs_cold?.percent)).padStart(16)}  │
└────────────────────────┴────────┴──────────┴─────────────┴──────────────────┘

Results appended to docs/performance-measurements.json
`);
