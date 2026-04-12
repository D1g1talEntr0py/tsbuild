#!/usr/bin/env tsx
/**
 * Performance benchmark script for tsbuild.
 *
 * Runs three build scenarios, parses timing output, and appends results to
 * docs/performance-measurements.json for regression tracking.
 *
 * Usage:
 *   pnpm bench
 */
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const measurementsPath = join(root, 'docs/performance-measurements.json');
const tsbuildCache = join(root, '.tsbuild');
const benchmarkFile = join(root, 'src/logger.ts');
const ansiPattern = /\x1b\[[0-9;]*m/g;

// ─── Build runner ──────────────────────────────────────────────────────────────

function runBuild(label: string): string {
	console.log(`  Running: ${label}...`);
	const result = spawnSync('tsx', [ './src/tsbuild.ts' ], {
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

interface Measurement {
	date: string;
	build_type: string;
	description: string;
	total_ms: number;
	phases: {
		type_checking_ms: number;
		transpile_ms: number;
		bundle_declarations_ms: number;
	};
	phase_breakdown: { type_checking: PhaseBreakdown };
	speedup_vs_cold?: { total_ms: number; percent: number };
	notes?: string;
}

function parseOutput(output: string) {
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

// ─── Main ──────────────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; name: string };
const date = new Date().toISOString().slice(0, 10);

console.log(`\ntsbuild v${pkg.version} — benchmark\n`);

// 1. Cold build
console.log('1/3 Cold build (clearing .tsbuild cache)');
rmSync(tsbuildCache, { recursive: true, force: true });
const coldOutput = runBuild('cold build');
const cold = parseOutput(coldOutput);

// 2. Incremental — no changes
console.log('2/3 Incremental (no changes)');
const noChangeOutput = runBuild('incremental, no changes');
const noChange = parseOutput(noChangeOutput);

// 3. Incremental — with a source file change (append + revert)
console.log('3/3 Incremental (with source change to src/logger.ts)');
appendFileSync(benchmarkFile, '\n// bench\n');
let changeOutput = '';
try {
	changeOutput = runBuild('incremental, with change');
} finally {
	execSync(`git checkout ${benchmarkFile}`, { cwd: root, stdio: 'ignore' });
}
const withChange = parseOutput(changeOutput);

// ─── Build measurement records ─────────────────────────────────────────────────

const coldRecord: Measurement = {
	date,
	build_type: 'cold_build_fresh_cache',
	description: 'Cold build after clearing .tsbuild cache',
	...cold,
};

const noChangeRecord: Measurement = {
	date,
	build_type: 'incremental_no_changes',
	description: 'Incremental rebuild with no file changes',
	...noChange,
	speedup_vs_cold: {
		total_ms: cold.total_ms - noChange.total_ms,
		percent: parseFloat(((1 - noChange.total_ms / cold.total_ms) * 100).toFixed(1)),
	},
};

const withChangeRecord: Measurement = {
	date,
	build_type: 'incremental_with_change',
	description: 'Incremental rebuild after modifying src/logger.ts',
	...withChange,
	speedup_vs_cold: {
		total_ms: cold.total_ms - withChange.total_ms,
		percent: parseFloat(((1 - withChange.total_ms / cold.total_ms) * 100).toFixed(1)),
	},
};

// ─── Append to measurement log ─────────────────────────────────────────────────

const log = JSON.parse(readFileSync(measurementsPath, 'utf8')) as { measurements: Measurement[] };
log.measurements.push(coldRecord, noChangeRecord, withChangeRecord);
writeFileSync(measurementsPath, JSON.stringify(log, null, 2) + '\n');

// ─── Summary table ─────────────────────────────────────────────────────────────

const col = (n: number) => String(n).padStart(6);
const pct = (n: number | undefined) => n !== undefined ? `+${n.toFixed(1)}%` : 'n/a';
const topBorder = '┌──────────────────────────────────────────────────────────────────┐';
const headerText = `  tsbuild v${pkg.version} — benchmark results`;
const headerRow = `│${headerText.padEnd(topBorder.length - 2)}│`;

console.log(`
${topBorder}
${headerRow}
│  tsbuild v${pkg.version} — benchmark results
├────────────────────────┬────────┬─────────────┬──────────────────┤
│  Scenario              │ Total  │ Type-check  │ Speedup vs cold  │
├────────────────────────┼────────┼─────────────┼──────────────────┤
│  Cold build            │${col(cold.total_ms)}ms │${col(cold.phases.type_checking_ms)}ms       │       baseline   │
│  Incremental (clean)   │${col(noChange.total_ms)}ms │${col(noChange.phases.type_checking_ms)}ms       │${String(pct(noChangeRecord.speedup_vs_cold?.percent)).padStart(16)}  │
│  Incremental (change)  │${col(withChange.total_ms)}ms │${col(withChange.phases.type_checking_ms)}ms       │${String(pct(withChangeRecord.speedup_vs_cold?.percent)).padStart(16)}  │
└────────────────────────┴────────┴─────────────┴──────────────────┘

Results appended to docs/performance-measurements.json
`);
