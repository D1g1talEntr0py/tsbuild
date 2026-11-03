#!/usr/bin/env node
/**
 * Performance benchmark for tsbuild — bundler comparison.
 *
 * Goal: compare full-feature TypeScript build tools (bundle + type-check + dts)
 * across representative project sizes and entry-point layouts.
 *
 * Methodology:
 *   - Isolated synthetic projects cover small, standard, large, and multi-entry workloads.
 *   - mitata drives sampling (adaptive — fewer samples for slower benches).
 *   - Each iteration resets caches/outputs in the (un-timed) setup phase of an
 *     iterator-style bench, so only the build subprocess wall-time is measured.
 *   - Competing tools are fetched on-demand via `pnpm dlx --package=X@version`
 *     (no project deps added; cache is pre-warmed before benchmarking).
 *
 * Build modes (groups):
 *   1. FULL    — bundle + type-check + dts (the headline)
 *   2. NO-DTS  — bundle + type-check, no declarations on the standard workload
 *                (gives a "what does dts cost?" reference)
 *
 * After mitata runs we also print:
 *   - tsbuild self-reported phase breakdown (the inner cost of the full build)
 *   - cold-build artifact metadata: output byte count and file metrics per tool
 *
 * Usage:
 *   pnpm bench
 *   pnpm bench -- --scenario=multi-entry
 *   pnpm bench -- --scenario=small --smoke --no-save
 */
import { bench, group, summary, barplot, run as mitataRun } from 'mitata';
import { execSync, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// ─── Configuration ─────────────────────────────────────────────────────────────

const root = fileURLToPath(new URL('../..', import.meta.url));
const tsbuildBin = join(root, 'dist/tsbuild.js');
const ansiPattern = /\x1b\[[0-9;]*m/g;

/** Synthetic workload shared by the performance and declaration-quality runners. */
export interface BenchmarkScenario {
	id: string;
	label: string;
	moduleCount: number;
	entryCount: number;
}

/** Available synthetic project sizes. */
export const SCENARIOS: BenchmarkScenario[] = [
	{ id: 'small', label: 'small · 10 modules', moduleCount: 10, entryCount: 1 },
	{ id: 'standard', label: 'standard · 100 modules', moduleCount: 100, entryCount: 1 },
	{ id: 'large', label: 'large · 500 modules', moduleCount: 500, entryCount: 1 },
	{ id: 'multi-entry', label: 'multi-entry · 100 modules / 10 entries', moduleCount: 100, entryCount: 10 },
];

/** Pinned versions for comparison tools (fetched on-demand via pnpm dlx). */
export const TOOL_VERSIONS = {
	typescript: '5.7.2',
	tsup: '8.5.1',
	tsdown: '0.22.0',
	unbuild: '3.6.1',
	unbuildTypescript: '5.9.2',
	obuild: '0.4.45',
	obuildTypescript: '7.0.2',
} as const;

// ─── ANSI helpers ──────────────────────────────────────────────────────────────

const useColor = process.stdout.isTTY && process.env['NO_COLOR'] !== '1';
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
	if (r.status !== 0 || r.signal !== null) {
		const exitInfo = r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
		throw new Error(`${cmd} exited with ${exitInfo}\nargs: ${args.join(' ')}\nstdout:\n${r.stdout ?? ''}\nstderr:\n${r.stderr ?? ''}`);
	}
	return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run a command and capture stdout/stderr for later parsing and artifact measurement. */
function execWithOutput(cmd: string, args: string[], cwd: string): { stdout: string; stderr: string } {
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
	if (r.status !== 0 || r.signal !== null) {
		const exitInfo = r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
		throw new Error(`command exited with ${exitInfo}\ncommand: ${[cmd, ...args].join(' ')}\nstdout:\n${r.stdout ?? ''}\nstderr:\n${r.stderr ?? ''}`);
	}
	return { stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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

function fmtKb(bytes: number): string { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsDeclarationFile(dir: string): boolean {
	const stack = [ dir ];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of readdirSync(current)) {
			const path = join(current, entry);
			if (statSync(path).isDirectory()) stack.push(path);
			else if (/\.d\.(?:ts|mts|cts)$/.test(entry)) return true;
		}
	}
	return false;
}

// ─── Synthetic project ─────────────────────────────────────────────────────────

/**
 * Generate a synthetic TypeScript project: `moduleCount` interconnected modules
 * + an index that re-exports them. Tsconfig uses `module: ESNext` + `moduleResolution: Bundler`
 * with extensionless imports for universal compatibility across all tested tools.
 */
export function generateSyntheticProject(dir: string, scenario: BenchmarkScenario): void {
	rmrf(join(dir, 'src'));
	mkdirSync(join(dir, 'src'), { recursive: true });
	for (let i = 0; i < scenario.moduleCount; i++) {
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

	const entryPoints: Record<string, string> = {};
	const entryNames: string[] = [];
	for (let entryIndex = 0; entryIndex < scenario.entryCount; entryIndex++) {
		const name = scenario.entryCount === 1 ? 'index' : `entry-${String(entryIndex).padStart(2, '0')}`;
		const start = Math.floor(entryIndex * scenario.moduleCount / scenario.entryCount);
		const end = Math.floor((entryIndex + 1) * scenario.moduleCount / scenario.entryCount);
		let entrySource = '';
		for (let i = start; i < end; i++) {
			entrySource += `export * from './module-${String(i).padStart(3, '0')}';\n`;
		}
		writeFileSync(join(dir, 'src', `${name}.ts`), entrySource);
		entryPoints[name] = `./src/${name}.ts`;
		entryNames.push(name);
	}

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
			entryPoints,
		},
	}, null, 2));

	writeFileSync(join(dir, 'build.config.mjs'), `export default {
	entries: ${JSON.stringify(entryNames.map(name => `./src/${name}`))},
	outDir: 'dist-unbuild-full',
	declaration: true,
};
`);
}

// ─── Tool runners ──────────────────────────────────────────────────────────────

/** Build runner configuration, shared without executing the performance benchmark on import. */
export interface Tool {
	id: string;
	outDir: string;
	dtsEnabled?: boolean;
	typeCheck?: boolean;
	typescriptVersion?: string;
	configure?: (dir: string, scenario: BenchmarkScenario) => void;
	/** Build the command line. Returns [cmd, args]. */
	command: (dir: string, scenario: BenchmarkScenario) => [ string, string[] ];
}

function entryFiles(dir: string, scenario: BenchmarkScenario): string[] {
	return Array.from({ length: scenario.entryCount }, (_, index) => {
		const name = scenario.entryCount === 1 ? 'index' : `entry-${String(index).padStart(2, '0')}`;
		return join(dir, 'src', `${name}.ts`);
	});
}

function typeCheckCommand(tool: Tool, dir: string): [ string, string[] ] {
	return [
		'pnpm',
		dlxArgs(
			[ `typescript@${tool.typescriptVersion ?? TOOL_VERSIONS.typescript}` ],
			'tsc',
			[ '--noEmit', '-p', join(dir, 'tsconfig.json') ],
		),
	];
}

function toolCommands(tool: Tool, dir: string, scenario: BenchmarkScenario): Array<[ string, string[] ]> {
	const commands: Array<[ string, string[] ]> = [];
	if (tool.typeCheck) { commands.push(typeCheckCommand(tool, dir)) }
	commands.push(tool.command(dir, scenario));
	return commands;
}

/** Executes a configured tool, surfacing subprocess failures. */
export function execTool(tool: Tool, cwd: string, scenario: BenchmarkScenario): void {
	const commands = toolCommands(tool, cwd, scenario);
	for (let i = 0; i < commands.length; i++) {
		const [ cmd, args ] = commands[i];
		exec(cmd, args, cwd);
	}
}

function execToolWithOutput(tool: Tool, cwd: string, scenario: BenchmarkScenario): { stdout: string; stderr: string } {
	let stdout = '';
	let stderr = '';
	const commands = toolCommands(tool, cwd, scenario);
	for (let i = 0; i < commands.length; i++) {
		const [ cmd, args ] = commands[i];
		const result = execWithOutput(cmd, args, cwd);
		if (i > 0) {
			stdout += '\n';
			stderr += '\n';
		}
		stdout += result.stdout;
		stderr += result.stderr;
	}

	return { stdout, stderr };
}

function tsbuildTool(opts: { dts?: boolean } = {}): Tool {
	const outDir = 'dist';
	return {
		id: opts.dts === false ? 'tsbuild (compilerOptions.declaration=false)' : 'tsbuild',
		outDir,
		dtsEnabled: opts.dts !== false,
		command: dir => [ process.execPath, [ tsbuildBin, '-p', dir ] ],
	};
}

function dlxArgs(packages: string[], cmd: string, args: string[]): string[] {
	const out: string[] = [ '--allow-build=esbuild', 'dlx' ];
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
		dtsEnabled: opts.dts,
		typeCheck: true,
		command: (dir, scenario) => [
			'pnpm',
			dlxArgs(
				[ `tsup@${TOOL_VERSIONS.tsup}`, `typescript@${TOOL_VERSIONS.typescript}` ],
				'tsup',
				[
					...entryFiles(dir, scenario),
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
		dtsEnabled: opts.dts,
		typeCheck: true,
		command: (dir, scenario) => [
			'pnpm',
			dlxArgs(
				[ `tsdown@${TOOL_VERSIONS.tsdown}`, `typescript@${TOOL_VERSIONS.typescript}` ],
				'tsdown',
				[
					...entryFiles(dir, scenario),
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

function unbuildTool(opts: { dts: boolean }): Tool {
	const outDir = opts.dts ? 'dist-unbuild-full' : 'dist-unbuild-nodts';
	return {
		id: opts.dts ? 'unbuild --dts' : 'unbuild',
		outDir,
		dtsEnabled: opts.dts,
		typeCheck: true,
		typescriptVersion: TOOL_VERSIONS.unbuildTypescript,
		configure: (dir, scenario) => {
			const entryNames = Array.from({ length: scenario.entryCount }, (_, index) =>
				scenario.entryCount === 1 ? 'index' : `entry-${String(index).padStart(2, '0')}`,
			);
			writeFileSync(join(dir, 'build.config.mjs'), `export default {
	entries: ${JSON.stringify(entryNames.map(name => `./src/${name}`))},
	outDir: '${outDir}',
	declaration: ${opts.dts},
};
`);
		},
		command: () => [
			'pnpm',
			dlxArgs(
				[ `unbuild@${TOOL_VERSIONS.unbuild}`, `typescript@${TOOL_VERSIONS.unbuildTypescript}` ],
				'unbuild',
				[],
			),
		],
	};
}

function obuildTool(opts: { dts: boolean }): Tool {
	const outDir = opts.dts ? 'dist-obuild-full' : 'dist-obuild-nodts';
	return {
		id: opts.dts ? 'obuild --dts' : 'obuild',
		outDir,
		dtsEnabled: opts.dts,
		typeCheck: true,
		typescriptVersion: TOOL_VERSIONS.obuildTypescript,
		configure: (dir, scenario) => {
			const entryNames = Array.from({ length: scenario.entryCount }, (_, index) =>
				scenario.entryCount === 1 ? 'index' : `entry-${String(index).padStart(2, '0')}`,
			);
			const inputs = entryNames.map(name => `./src/${name}.ts`);
			writeFileSync(join(dir, 'build.config.mjs'), `export default {
	entries: [{
		type: 'bundle',
		input: ${JSON.stringify(inputs)},
		outDir: '${outDir}',
		dts: ${opts.dts},
		license: false,
	}],
};
`);
		},
		command: () => [
			'pnpm',
			dlxArgs(
				[ `obuild@${TOOL_VERSIONS.obuild}`, `typescript@${TOOL_VERSIONS.obuildTypescript}` ],
				'obuild',
				[],
			),
		],
	};
}

/** Returns pinned comparison tools with or without declaration emission. */
export function toolsForMode(dts: boolean): Tool[] {
	return [
		tsbuildTool({ dts }),
		tsupTool({ dts }),
		tsdownTool({ dts }),
		unbuildTool({ dts }),
		obuildTool({ dts }),
	];
}

function verifyToolOutput(dir: string, tool: Tool, scenario: BenchmarkScenario): void {
	const outputDir = join(dir, tool.outDir);
	if (!existsSync(outputDir) || dirSizeBytes(outputDir) === 0) {
		throw new Error(`${tool.id} produced no output for the '${scenario.id}' scenario.`);
	}
	if (tool.dtsEnabled !== containsDeclarationFile(outputDir)) {
		throw new Error(`${tool.id} produced unexpected declaration output for the '${scenario.id}' scenario.`);
	}
}

function runSmoke(dir: string, scenarios: BenchmarkScenario[]): void {
	for (const scenario of scenarios) {
		for (const tool of [...toolsForMode(true), ...toolsForMode(false)]) {
			generateSyntheticProject(dir, scenario);
			resetForTool(dir, tool, scenario);
			execTool(tool, dir, scenario);
			verifyToolOutput(dir, tool, scenario);
			console.log(`  ${scenario.id.padEnd(12)} ${tool.id} ✓`);
		}
	}
}

// ─── Reset helpers ─────────────────────────────────────────────────────────────

function setSyntheticDeclarationOption(dir: string, enabled: boolean): void {
	const path = join(dir, 'tsconfig.json');
	const tsconfig = JSON.parse(readFileSync(path, 'utf8')) as { compilerOptions?: { declaration?: boolean } };
	if (tsconfig.compilerOptions === undefined) { tsconfig.compilerOptions = {}; }
	tsconfig.compilerOptions.declaration = enabled;
	writeFileSync(path, JSON.stringify(tsconfig, null, 2));
}

/** Resets only the isolated fixture's output and cache and applies tool configuration. */
export function resetForTool(dir: string, tool: Tool, scenario: BenchmarkScenario): void {
	setSyntheticDeclarationOption(dir, tool.dtsEnabled !== false);
	tool.configure?.(dir, scenario);
	rmrf(join(dir, tool.outDir));
	if (tool.id.startsWith('tsbuild')) rmrf(join(dir, '.tsbuild'));
}

// ─── Pre-warm pnpm dlx cache ───────────────────────────────────────────────────

function prewarm(dir: string, scenario: BenchmarkScenario): void {
	console.log(`${c.dim}Pre-warming pnpm dlx cache (one-time download)…${c.reset}`);
	const targets: Array<{ label: string; packages: string[]; cmd: string; args?: string[]; cwd?: string }> = [
		{ label: 'typescript', packages: [ `typescript@${TOOL_VERSIONS.typescript}` ], cmd: 'tsc' },
		{ label: 'tsup', packages: [ `tsup@${TOOL_VERSIONS.tsup}`, `typescript@${TOOL_VERSIONS.typescript}` ], cmd: 'tsup' },
		{ label: 'tsdown', packages: [ `tsdown@${TOOL_VERSIONS.tsdown}`, `typescript@${TOOL_VERSIONS.typescript}` ], cmd: 'tsdown' },
		{ label: 'unbuild', packages: [ `unbuild@${TOOL_VERSIONS.unbuild}`, `typescript@${TOOL_VERSIONS.unbuildTypescript}` ], cmd: 'unbuild' },
		{ label: 'obuild', packages: [ `obuild@${TOOL_VERSIONS.obuild}`, `typescript@${TOOL_VERSIONS.obuildTypescript}` ], cmd: 'obuild', args: [], cwd: dir },
	];
	obuildTool({ dts: true }).configure?.(dir, scenario);
	for (let i = 0; i < targets.length; i++) {
		const t = targets[i];
		process.stdout.write(`  ${t.label.padEnd(10)} `);
		try {
			execFileSync('pnpm', dlxArgs(t.packages, t.cmd, t.args ?? [ '--version' ]), { cwd: t.cwd, stdio: 'pipe', encoding: 'utf8' });
			console.log(`${c.green}✓${c.reset}`);
		} catch (err) {
			console.log(`${c.red}✗${c.reset}\n${(err as Error).message}`);
			throw err;
		}
	}
}

// ─── Build dist if missing ─────────────────────────────────────────────────────

/** Builds the local CLI if missing, or when a runner requires fresh source output. */
export function ensureTsbuildBuilt(force = false): void {
	if (!force && existsSync(tsbuildBin)) return;
	console.log(`${c.dim}Building tsbuild…${c.reset}`);
	execSync(force ? 'pnpm build --force' : 'pnpm build', { cwd: root, stdio: 'inherit' });
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
	scenario: string;
	wallMs: number;
	outputBytes: number;
	phases?: Phases;
}

function measureArtifact(dir: string, tool: Tool, scenario: BenchmarkScenario): Artifact {
	generateSyntheticProject(dir, scenario);
	resetForTool(dir, tool, scenario);
	const start = performance.now();
	const r = execToolWithOutput(tool, dir, scenario);
	const wallMs = performance.now() - start;
	const outputBytes = dirSizeBytes(join(dir, tool.outDir));
	verifyToolOutput(dir, tool, scenario);
	const phases = tool.id.startsWith('tsbuild') ? parseTsbuildPhases(r.stdout + r.stderr) : undefined;
	return { id: tool.id, scenario: scenario.id, wallMs, outputBytes, phases };
}

// ─── Custom rendering ──────────────────────────────────────────────────────────

function renderArtifactTable(title: string, artifacts: Artifact[]): void {
	const sorted = artifacts.slice().sort((a, b) => a.outputBytes - b.outputBytes);
	const longestId = sorted.reduce((m, a) => Math.max(m, a.id.length), 0);
	console.log(`\n${c.bold}${c.cyan}┌─ ${title}${c.reset}`);
	console.log(`${c.dim}│  one cold build per tool · output size · ${sorted[0]?.scenario ?? 'no samples'} scenario${c.reset}`);
	console.log(`${c.dim}│${c.reset}`);
	for (let i = 0; i < sorted.length; i++) {
		const a = sorted[i];
		console.log(`${c.dim}│${c.reset}  ${c.cyan}${a.id.padEnd(longestId)}${c.reset}  ${c.dim}out${c.reset} ${fmtKb(a.outputBytes).padStart(8)}`);
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

async function main(): Promise<void> {
	const requestedScenario = process.argv.slice(2).find(arg => arg.startsWith('--scenario='))?.slice('--scenario='.length);
	const smoke = process.argv.includes('--smoke');
	const saveResults = !process.argv.includes('--no-save');
	const selectedScenarios = requestedScenario === undefined
		? SCENARIOS
		: SCENARIOS.filter(scenario => scenario.id === requestedScenario);
	if (selectedScenarios.length === 0) {
		throw new Error(`Unknown scenario '${requestedScenario}'. Choose one of: ${SCENARIOS.map(scenario => scenario.id).join(', ')}`);
	}

	ensureTsbuildBuilt();

	const dir = mkdtempSync(join(tmpdir(), 'tsbuild-bench-'));
	const fullArtifacts: Artifact[] = [];
	const noDtsArtifacts: Artifact[] = [];
	const artifactScenario = selectedScenarios.find(scenario => scenario.id === 'standard') ?? selectedScenarios[0];

	try {
		console.log(`${c.bold}tsbuild — bundler benchmark${c.reset}  ${c.dim}(${selectedScenarios.map(scenario => scenario.label).join('; ')})${c.reset}`);
		console.log(`${c.dim}project: ${dir}${c.reset}\n`);

		generateSyntheticProject(dir, artifactScenario);
		prewarm(dir, artifactScenario);

		if (smoke) {
			console.log(`${c.yellow}Smoke run: one build per tool and scenario; timing results are not collected.${c.reset}`);
			runSmoke(dir, selectedScenarios);
			console.log(`\n${c.dim}Skipped saving results (--smoke).${c.reset}`);
		} else {
			console.log(`\n${c.bold}Running mitata bench (adaptive sampling — slower benches get fewer samples)…${c.reset}\n`);

			barplot(() => {
				summary(() => {
					for (const scenario of selectedScenarios) {
						const fullTools = toolsForMode(true);
						group(`Full · ${scenario.label} · type-check + bundle + dts`, () => {
							for (const tool of fullTools) {
								bench(tool.id, function* () {
									generateSyntheticProject(dir, scenario);
									resetForTool(dir, tool, scenario);
									yield () => { execTool(tool, dir, scenario); };
								});
							}
						});
					}

					const noDtsTools = toolsForMode(false);
					group(`No dts · ${artifactScenario.label} · type-check + bundle`, () => {
						for (const tool of noDtsTools) {
							bench(tool.id, function* () {
								generateSyntheticProject(dir, artifactScenario);
								resetForTool(dir, tool, artifactScenario);
								yield () => { execTool(tool, dir, artifactScenario); };
							});
						}
					});
				});
			});

			await mitataRun({ colors: useColor });

			console.log(`\n${c.dim}Capturing cold-build artifact metadata (output size) — separate from timing.${c.reset}`);
			const fullTools = toolsForMode(true);
			for (const tool of fullTools) {
				process.stdout.write(`  ${tool.id.padEnd(24)} `);
				const artifact = measureArtifact(dir, tool, artifactScenario);
				fullArtifacts.push(artifact);
				console.log(`${c.green}✓${c.reset} ${fmtKb(artifact.outputBytes)}`);
			}

			const noDtsTools = toolsForMode(false);
			for (const tool of noDtsTools) {
				process.stdout.write(`  ${tool.id.padEnd(24)} `);
				const artifact = measureArtifact(dir, tool, artifactScenario);
				noDtsArtifacts.push(artifact);
				console.log(`${c.green}✓${c.reset} ${fmtKb(artifact.outputBytes)}`);
			}

			renderArtifactTable('Full build artifacts · type-check + bundle + dts', fullArtifacts);
			renderArtifactTable('No-dts build artifacts', noDtsArtifacts);

			const tsbuildArtifact = fullArtifacts.find(artifact => artifact.id === 'tsbuild');
			if (tsbuildArtifact?.phases) renderPhaseBreakdown(tsbuildArtifact.phases);

			if (saveResults) {
				const measurementsPath = join(root, 'docs/performance-measurements.json');
				const record = {
					timestamp: new Date().toISOString(),
					node: process.version,
					platform: process.platform,
					scenarios: selectedScenarios.map(scenario => ({
						id: scenario.id,
						modules: scenario.moduleCount,
						entries: scenario.entryCount,
					})),
					full: fullArtifacts.map(artifact => ({
						scenario: artifact.scenario,
						tool: artifact.id,
						wall_ms: Math.round(artifact.wallMs),
						peak_rss_mb: null,
						output_kb: artifact.outputBytes / 1024,
					})),
					no_dts: noDtsArtifacts.map(artifact => ({
						scenario: artifact.scenario,
						tool: artifact.id,
						wall_ms: Math.round(artifact.wallMs),
						peak_rss_mb: null,
						output_kb: artifact.outputBytes / 1024,
					})),
					tsbuild_phases: tsbuildArtifact?.phases ?? null,
				};
				const existing = existsSync(measurementsPath)
					? JSON.parse(readFileSync(measurementsPath, 'utf8')) as unknown
					: [];
				if (!Array.isArray(existing) && !isRecord(existing)) {
					throw new Error(`Unexpected benchmark results format in ${measurementsPath}.`);
				}
				const updated = Array.isArray(existing)
					? [ ...existing, record ]
					: {
						...existing,
						benchmark_comparisons: [
							...(Array.isArray(existing['benchmark_comparisons']) ? existing['benchmark_comparisons'] : []),
							record,
						],
					};
				writeFileSync(measurementsPath, JSON.stringify(updated, null, 2));
				console.log(`\n${c.dim}Appended record to docs/performance-measurements.json${c.reset}`);
			} else {
				console.log(`\n${c.dim}Skipped saving results (--no-save).${c.reset}`);
			}
		}
	} finally {
		rmrf(dir);
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await main() }
