#!/usr/bin/env node
/**
 * Performance benchmark for tsbuild — bundler comparison.
 *
 * Goal: validate that tsbuild is the fastest *full-feature* TypeScript bundler
 * (bundle + type-check + dts) on a representative project.
 *
 * Methodology:
 *   - One synthetic project (100 files), built fresh by each tool — no incremental.
 *   - mitata drives sampling (adaptive — fewer samples for slower benches).
 *   - Each iteration resets caches/outputs in the (untimed) setup phase of an
 *     iterator-style bench, so only the build subprocess wall-time is measured.
 *   - Competing tools are fetched on-demand via `pnpm dlx --package=X@version`
 *     (no project deps added; cache is pre-warmed before benchmarking).
 *
 * Build modes (groups):
 *   1. FULL    — bundle + type-check + dts (the headline)
 *   2. NO-DTS  — bundle + type-check, no declarations (tsbuild always does full,
 *                annotated as such — gives a "what does dts cost?" reference)
 *
 * After mitata runs we also print:
 *   - tsbuild self-reported phase breakdown (the inner cost of the full build)
 *   - cold-build artifact metadata: peak RSS (Linux only, via /usr/bin/time)
 *     and output byte count per tool
 *
 * Usage:
 *   pnpm bench
 */
import { bench, group, summary, barplot, run as mitataRun } from 'mitata';
import { execSync, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// ─── Configuration ─────────────────────────────────────────────────────────────

const SYNTHETIC_FILE_COUNT = 100;
const root = fileURLToPath(new URL('../..', import.meta.url));
const tsbuildBin = join(root, 'dist/tsbuild.js');
const ansiPattern = /\x1b\[[0-9;]*m/g;
const hasGnuTime = process.platform === 'linux';

/** Pinned versions for comparison tools (fetched on-demand via pnpm dlx). */
const TOOL_VERSIONS = {
	typescript: '5.7.2',
	tsup: '8.5.1',
	tsdown: '0.22.0',
} as const;

// ─── ANSI helpers ──────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && process.env.NO_COLOR !== '1';
const c = {
	reset: useColor ? '\x1b[0m' : '',
	dim: useColor ? '\x1b[2m' : '',
	bold: useColor ? '\x1b[1m' : '',
	green: useColor ? '\x1b[38;5;78m' : '',
	yellow: useColor ? '\x1b[38;5;221m' : '',
	red: useColor ? '\x1b[38;5;203m' : '',
	cyan: useColor ? '\x1b[38;5;81m' : '',
	gray: useColor ? '\x1b[38;5;245m' : '',
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Synchronously run a command, throwing with full stderr on non-zero exit. */
function exec(cmd: string, args: string[], cwd: string): { stdout: string; stderr: string } {
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
	if (r.status !== 0) {
		throw new Error(`${cmd} exited with ${r.status}\nargs: ${args.join(' ')}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
	}
	return { stdout: r.stdout, stderr: r.stderr };
}

/** Wrap a command with `/usr/bin/time -f 'MAXRSS:%M'` (Linux only). Returns peak RSS in KB or 0. */
function execWithRss(cmd: string, args: string[], cwd: string): { stdout: string; stderr: string; rssKb: number } {
	if (!hasGnuTime) {
		const r = exec(cmd, args, cwd);
		return { ...r, rssKb: 0 };
	}
	const r = spawnSync('/usr/bin/time', [ '-f', 'MAXRSS:%M', cmd, ...args ], { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
	if (r.status !== 0) {
		throw new Error(`${cmd} exited with ${r.status}\nargs: ${args.join(' ')}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
	}
	const match = r.stderr.match(/MAXRSS:(\d+)/);
	const rssKb = match ? parseInt(match[1], 10) : 0;
	const stderr = r.stderr.replace(/MAXRSS:\d+\n?/, '');
	return { stdout: r.stdout, stderr, rssKb };
}

/** Recursively sum byte sizes of all files under dir; returns 0 if missing. */
function dirSizeBytes(dir: string): number {
	if (!existsSync(dir)) return 0;
	let total = 0;
	const stack: string[] = [ dir ];
	while (stack.length > 0) {
		const current = stack.pop()!;
		const entries = readdirSync(current);
		for (let i = 0; i < entries.length; i++) {
			const path = join(current, entries[i]);
			const stat = statSync(path);
			if (stat.isDirectory()) stack.push(path);
			else total += stat.size;
		}
	}
	return total;
}

function rmrf(path: string): void { rmSync(path, { recursive: true, force: true }); }

function fmtMs(ms: number): string { return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`; }
function fmtKb(bytes: number): string { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function fmtRss(kb: number): string { return kb === 0 ? '—' : `${(kb / 1024).toFixed(0)} MB`; }

// ─── Synthetic project ─────────────────────────────────────────────────────────

/**
 * Generate a synthetic TypeScript project: `moduleCount` interconnected modules
 * + an index that re-exports them. Tsconfig uses `module: ESNext` + `moduleResolution: Bundler`
 * with extensionless imports for universal compatibility across all tested tools.
 */
function generateSyntheticProject(dir: string, moduleCount: number): void {
	mkdirSync(join(dir, 'src'), { recursive: true });
	for (let i = 0; i < moduleCount; i++) {
		const id = String(i).padStart(3, '0');
		const importPrev = i > 0 ? `import { value${String(i - 1).padStart(3, '0')} } from './module-${String(i - 1).padStart(3, '0')}';\n` : '';
		const useImport = i > 0 ? `+ value${String(i - 1).padStart(3, '0')}` : '';
		const source = `${importPrev}
/** Numeric counter for module ${id}. */
export const value${id}: number = ${i} ${useImport};

/** Branded record for cross-module composition. */
export interface Item${id} {
	readonly id: string;
	readonly seq: number;
	readonly tags: ReadonlyArray<string>;
}

/** Factory for module ${id} items. */
export function make${id}(seq: number, ...tags: string[]): Item${id} {
	return { id: '${id}', seq, tags };
}

/** Aggregate helper that consumes the upstream value. */
export class Aggregator${id} {
	#items: Item${id}[] = [];
	add(item: Item${id}): this { this.#items.push(item); return this; }
	get count(): number { return this.#items.length; }
	get base(): number { return value${id}; }
}

/** Pure transform — exercises generics and array methods. */
export function transform${id}<T>(values: ReadonlyArray<T>, mapper: (v: T) => T): T[] {
	const out: T[] = new Array(values.length);
	for (let i = 0; i < values.length; i++) out[i] = mapper(values[i]);
	return out;
}
`;
		writeFileSync(join(dir, 'src', `module-${id}.ts`), source);
	}

	let indexSource = '';
	for (let i = 0; i < moduleCount; i++) {
		indexSource += `export * from './module-${String(i).padStart(3, '0')}';\n`;
	}
	writeFileSync(join(dir, 'src/index.ts'), indexSource);

	writeFileSync(join(dir, 'package.json'), JSON.stringify({
		name: 'synthetic-bench',
		version: '0.0.0',
		type: 'module',
		private: true,
	}, null, 2));

	writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			target: 'ES2022',
			lib: [ 'ES2022' ],
			types: [],
			typeRoots: [ join(root, 'node_modules/@types') ],
			module: 'ESNext',
			moduleResolution: 'Bundler',
			outDir: './dist',
			strict: true,
			declaration: true,
			esModuleInterop: true,
			skipLibCheck: true,
			isolatedModules: true,
		},
		include: [ 'src/**/*' ],
		tsbuild: {
			entryPoints: { index: './src/index.ts' },
			outDir: './dist',
		},
	}, null, 2));
}

// ─── Tool runners ──────────────────────────────────────────────────────────────

interface Tool {
	id: string;
	outDir: string;
	/** Build the command line. Returns [cmd, args]. */
	command: (dir: string) => [ string, string[] ];
}

function tsbuildTool(): Tool {
	return {
		id: 'tsbuild',
		outDir: 'dist',
		command: dir => [ process.execPath, [ tsbuildBin, '-p', dir ] ],
	};
}

function dlxArgs(packages: string[], cmd: string, args: string[]): string[] {
	const out: string[] = [ 'dlx' ];
	for (let i = 0; i < packages.length; i++) { out.push(`--package=${packages[i]}`); }
	out.push(cmd, ...args);
	return out;
}

function tsupTool(opts: { dts: boolean }): Tool {
	const outDir = opts.dts ? 'dist-tsup-full' : 'dist-tsup-nodts';
	const dtsFlag = opts.dts ? [ '--dts' ] : [];
	return {
		id: opts.dts ? 'tsup --dts' : 'tsup',
		outDir,
		command: dir => [
			'pnpm',
			dlxArgs(
				[ `tsup@${TOOL_VERSIONS.tsup}`, `typescript@${TOOL_VERSIONS.typescript}` ],
				'tsup',
				[
					join(dir, 'src/index.ts'),
					'--format', 'esm',
					...dtsFlag,
					'--out-dir', join(dir, outDir),
					'--config', 'false',
					'--no-clean',
					'--silent',
				],
			),
		],
	};
}

function tsdownTool(opts: { dts: boolean }): Tool {
	const outDir = opts.dts ? 'dist-tsdown-full' : 'dist-tsdown-nodts';
	const dtsFlag = opts.dts ? [ '--dts' ] : [];
	return {
		id: opts.dts ? 'tsdown --dts' : 'tsdown',
		outDir,
		command: dir => [
			'pnpm',
			dlxArgs(
				[ `tsdown@${TOOL_VERSIONS.tsdown}`, `typescript@${TOOL_VERSIONS.typescript}` ],
				'tsdown',
				[
					join(dir, 'src/index.ts'),
					'--format', 'esm',
					...dtsFlag,
					'--out-dir', join(dir, outDir),
					'--no-config',
					'--logLevel', 'silent',
					'--no-report',
				],
			),
		],
	};
}

// ─── Reset helpers ─────────────────────────────────────────────────────────────

function resetForTool(dir: string, tool: Tool): void {
	rmrf(join(dir, tool.outDir));
	if (tool.id === 'tsbuild') rmrf(join(dir, '.tsbuild'));
}

// ─── Pre-warm pnpm dlx cache ───────────────────────────────────────────────────

function prewarm(): void {
	console.log(`${c.dim}Pre-warming pnpm dlx cache (one-time download)…${c.reset}`);
	const targets: Array<{ label: string; packages: string[]; cmd: string }> = [
		{ label: 'tsup', packages: [ `tsup@${TOOL_VERSIONS.tsup}`, `typescript@${TOOL_VERSIONS.typescript}` ], cmd: 'tsup' },
		{ label: 'tsdown', packages: [ `tsdown@${TOOL_VERSIONS.tsdown}`, `typescript@${TOOL_VERSIONS.typescript}` ], cmd: 'tsdown' },
	];
	for (let i = 0; i < targets.length; i++) {
		const t = targets[i];
		process.stdout.write(`  ${t.label.padEnd(10)} `);
		try {
			execFileSync('pnpm', dlxArgs(t.packages, t.cmd, [ '--version' ]), { stdio: 'pipe', encoding: 'utf8' });
			console.log(`${c.green}✓${c.reset}`);
		} catch (err) {
			console.log(`${c.red}✗${c.reset}\n${(err as Error).message}`);
			throw err;
		}
	}
}

// ─── Build dist if missing ─────────────────────────────────────────────────────

function ensureTsbuildBuilt(): void {
	if (existsSync(tsbuildBin)) return;
	console.log(`${c.dim}Building tsbuild…${c.reset}`);
	execSync('pnpm build', { cwd: root, stdio: 'inherit' });
}

// ─── tsbuild phase parsing ─────────────────────────────────────────────────────

interface Phases { typeCheckMs: number; transpileMs: number; bundleDtsMs: number; }

function parseTsbuildPhases(combinedOutput: string): Phases | undefined {
	const clean = combinedOutput.replace(ansiPattern, '');
	const tc = /✓ Type-checking\/Emit \((\d+)ms\)/.exec(clean);
	const tr = /✓ Transpile \((\d+)ms\)/.exec(clean);
	const bd = /✓ Bundle Declarations \((\d+)ms\)/.exec(clean);
	if (!tc || !tr || !bd) return undefined;
	return { typeCheckMs: +tc[1], transpileMs: +tr[1], bundleDtsMs: +bd[1] };
}

// ─── Artifact measurement (cold, single-shot, post-mitata) ─────────────────────

interface Artifact {
	id: string;
	wallMs: number;
	rssKb: number;
	outputBytes: number;
	phases?: Phases;
}

function measureArtifact(dir: string, tool: Tool): Artifact {
	resetForTool(dir, tool);
	const [ cmd, args ] = tool.command(dir);
	const start = performance.now();
	const r = execWithRss(cmd, args, dir);
	const wallMs = performance.now() - start;
	const outputBytes = dirSizeBytes(join(dir, tool.outDir));
	const phases = tool.id === 'tsbuild' ? parseTsbuildPhases(r.stdout + r.stderr) : undefined;
	return { id: tool.id, wallMs, rssKb: r.rssKb, outputBytes, phases };
}

// ─── Custom rendering ──────────────────────────────────────────────────────────

function renderArtifactTable(title: string, artifacts: Artifact[]): void {
	const sorted = artifacts.slice().sort((a, b) => a.outputBytes - b.outputBytes);
	const longestId = sorted.reduce((m, a) => Math.max(m, a.id.length), 0);
	console.log(`\n${c.bold}${c.cyan}┌─ ${title}${c.reset}`);
	console.log(`${c.dim}│  one cold build per tool · peak RSS · output size${c.reset}`);
	console.log(`${c.dim}│${c.reset}`);
	for (let i = 0; i < sorted.length; i++) {
		const a = sorted[i];
		console.log(`${c.dim}│${c.reset}  ${c.cyan}${a.id.padEnd(longestId)}${c.reset}  ${c.dim}rss${c.reset} ${fmtRss(a.rssKb).padStart(7)}  ${c.dim}out${c.reset} ${fmtKb(a.outputBytes).padStart(8)}`);
	}
	console.log(`${c.dim}└─${c.reset}`);
}

function renderPhaseBreakdown(phases: Phases): void {
	const total = phases.typeCheckMs + phases.transpileMs + phases.bundleDtsMs;
	const width = 32;
	const rows: Array<[ string, number ]> = [
		[ 'type-check/emit', phases.typeCheckMs ],
		[ 'transpile', phases.transpileMs ],
		[ 'bundle declarations', phases.bundleDtsMs ],
	];
	const longestLabel = rows.reduce((m, r) => Math.max(m, r[0].length), 0);
	console.log(`\n${c.bold}${c.cyan}┌─ tsbuild phase breakdown (cold full build)${c.reset}`);
	console.log(`${c.dim}│${c.reset}`);
	for (let i = 0; i < rows.length; i++) {
		const [ label, ms ] = rows[i];
		const frac = total === 0 ? 0 : ms / total;
		const cells = Math.max(1, Math.round(frac * width));
		const bar = '█'.repeat(cells).padEnd(width);
		const pct = total === 0 ? '0%' : `${(frac * 100).toFixed(0)}%`;
		console.log(`${c.dim}│${c.reset}  ${label.padEnd(longestLabel)}  ${`${ms} ms`.padStart(7)}  ${c.cyan}${bar}${c.reset}  ${c.dim}${pct}${c.reset}`);
	}
	console.log(`${c.dim}│  total: ${total} ms${c.reset}`);
	console.log(`${c.dim}└─${c.reset}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

ensureTsbuildBuilt();

const dir = mkdtempSync(join(tmpdir(), 'tsbuild-bench-'));
console.log(`${c.bold}tsbuild — bundler benchmark${c.reset}  ${c.dim}(synthetic project, ${SYNTHETIC_FILE_COUNT} files)${c.reset}`);
console.log(`${c.dim}project: ${dir}${c.reset}\n`);

generateSyntheticProject(dir, SYNTHETIC_FILE_COUNT);
prewarm();

// Define tools per mode.
const fullTools: Tool[] = [ tsbuildTool(), tsupTool({ dts: true }), tsdownTool({ dts: true }) ];
const noDtsTools: Tool[] = [ tsbuildTool(), tsupTool({ dts: false }), tsdownTool({ dts: false }) ];

// Mitata runs — measure pure wall-time across many samples.
console.log(`\n${c.bold}Running mitata bench (adaptive sampling — slower benches get fewer samples)…${c.reset}\n`);

barplot(() => {
	summary(() => {
		group('Full · type-check + bundle + dts', () => {
			for (let i = 0; i < fullTools.length; i++) {
				const tool = fullTools[i];
				bench(tool.id, function* () {
					resetForTool(dir, tool);
					const [ cmd, args ] = tool.command(dir);
					yield () => { exec(cmd, args, dir); };
				});
			}
		});
	});
});

barplot(() => {
	summary(() => {
		group('No dts · bundle only (tsbuild always does full build — annotated)', () => {
			for (let i = 0; i < noDtsTools.length; i++) {
				const tool = noDtsTools[i];
				bench(tool.id === 'tsbuild' ? 'tsbuild (full *)' : tool.id, function* () {
					resetForTool(dir, tool);
					const [ cmd, args ] = tool.command(dir);
					yield () => { exec(cmd, args, dir); };
				});
			}
		});
	});
});

await mitataRun({ colors: useColor });

// Per-tool single-shot cold build for artifact size + RSS + phase breakdown.
console.log(`\n${c.dim}Capturing cold-build artifact metadata (RSS + output size) — separate from timing.${c.reset}`);
const fullArtifacts: Artifact[] = [];
for (let i = 0; i < fullTools.length; i++) {
	process.stdout.write(`  ${fullTools[i].id.padEnd(16)} `);
	try {
		const a = measureArtifact(dir, fullTools[i]);
		fullArtifacts.push(a);
		console.log(`${c.green}✓${c.reset} ${fmtRss(a.rssKb)} · ${fmtKb(a.outputBytes)}`);
	} catch (err) {
		console.log(`${c.red}✗ ${(err as Error).message}${c.reset}`);
	}
}

const noDtsArtifacts: Artifact[] = [];
for (let i = 0; i < noDtsTools.length; i++) {
	const tool = noDtsTools[i];
	const label = tool.id === 'tsbuild' ? 'tsbuild (full *)' : tool.id;
	process.stdout.write(`  ${label.padEnd(16)} `);
	try {
		const a = measureArtifact(dir, tool);
		noDtsArtifacts.push({ ...a, id: label });
		console.log(`${c.green}✓${c.reset} ${fmtRss(a.rssKb)} · ${fmtKb(a.outputBytes)}`);
	} catch (err) {
		console.log(`${c.red}✗ ${(err as Error).message}${c.reset}`);
	}
}

renderArtifactTable('Full build artifacts · type-check + bundle + dts', fullArtifacts);
renderArtifactTable('No-dts build artifacts  (* tsbuild always does full)', noDtsArtifacts);

// Phase breakdown for tsbuild (from the full artifact measurement).
const tsbuildArtifact = fullArtifacts.find(a => a.id === 'tsbuild');
if (tsbuildArtifact?.phases) renderPhaseBreakdown(tsbuildArtifact.phases);

// Persist a summary to docs.
const measurementsPath = join(root, 'docs/performance-measurements.json');
const record = {
	timestamp: new Date().toISOString(),
	node: process.version,
	platform: process.platform,
	synthetic_file_count: SYNTHETIC_FILE_COUNT,
	full: fullArtifacts.map(a => ({ tool: a.id, wall_ms: Math.round(a.wallMs), peak_rss_mb: a.rssKb / 1024, output_kb: a.outputBytes / 1024 })),
	no_dts: noDtsArtifacts.map(a => ({ tool: a.id, wall_ms: Math.round(a.wallMs), peak_rss_mb: a.rssKb / 1024, output_kb: a.outputBytes / 1024 })),
	tsbuild_phases: tsbuildArtifact?.phases ?? null,
};
try {
	const existing = existsSync(measurementsPath) ? JSON.parse(readFileSync(measurementsPath, 'utf8')) as unknown[] : [];
	if (Array.isArray(existing)) {
		existing.push(record);
		writeFileSync(measurementsPath, JSON.stringify(existing, null, 2));
		console.log(`\n${c.dim}Appended record to docs/performance-measurements.json${c.reset}`);
	}
} catch {
	writeFileSync(measurementsPath, JSON.stringify([ record ], null, 2));
}

rmrf(dir);
