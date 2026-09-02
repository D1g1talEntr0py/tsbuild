#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { brotliCompressSync, brotliDecompressSync, constants as brotliConstants } from 'node:zlib';
import { deserialize, serialize } from 'node:v8';

type Timing = { name: string; milliseconds: number };

const root = fileURLToPath(new URL('../..', import.meta.url));
const bundledCli = join(root, 'dist', 'tsbuild.js');
const timings: Timing[] = [];

function measure<T>(name: string, operation: () => T): T {
	const start = performance.now();
	const result = operation();
	timings.push({ name, milliseconds: performance.now() - start });
	return result;
}

function runBuild(args: string[] = []): number {
	const command = existsSync(bundledCli) ? 'node' : 'pnpm';
	const commandArgs = existsSync(bundledCli) ? [ bundledCli, ...args ] : [ 'build', ...args ];
	const result = spawnSync(command, commandArgs, { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
	if (result.error !== undefined) { throw result.error }
	return result.status ?? 1;
}

function report(name: string, milliseconds: number): void {
	console.log(`${name}: ${milliseconds.toFixed(2)} ms`);
}

async function measureRuntimePrimitives(): Promise<void> {
	const typescriptStart = performance.now();
	const typescript = await import('typescript');
	report('typescript import', performance.now() - typescriptStart);

	const configPath = join(root, 'tsconfig.json');
	const config = typescript.readConfigFile(configPath, typescript.sys.readFile);
	if (config.error !== undefined) { throw new Error(typescript.flattenDiagnosticMessageText(config.error.messageText, '\n')) }
	const parsed = typescript.parseJsonConfigFileContent(config.config, typescript.sys, root);

	const program = measure('create program', () => typescript.createProgram({ rootNames: parsed.fileNames, options: parsed.options }));
	measure('semantic diagnostics', () => program.getSemanticDiagnostics());
	measure('declaration emit', () => program.emit(undefined, () => {}, undefined, true));

	if (typescript.transpileDeclaration !== undefined) {
		const source = readFileSync(join(root, 'src/logger.ts'), 'utf8');
		measure('transpileDeclaration', () => typescript.transpileDeclaration(source, { compilerOptions: parsed.options }));
	} else {
		console.log('transpileDeclaration: unavailable');
	}
}

function measureCachePrimitives(): void {
	const cachePath = join(root, '.tsbuild', 'dts_cache.v4.br');
	if (!existsSync(cachePath)) {
		console.log('cache restore: unavailable (run pnpm build first)');
		return;
	}

	const compressed = readFileSync(cachePath);
	const decompressed = measure('Brotli decompress', () => brotliDecompressSync(compressed));
	const deserialized = measure('V8 deserialize', () => deserialize(decompressed));
	const serialized = serialize(deserialized);
	measure('V8 serialize + Brotli compress', () => brotliCompressSync(serialized, { params: { [brotliConstants.BROTLI_PARAM_QUALITY]: 5 } }));
}

async function measureEndToEnd(): Promise<void> {
	if (!existsSync(bundledCli)) {
		const bootstrap = spawnSync('pnpm', [ 'build' ], { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
		if (bootstrap.status !== 0) { throw new Error(bootstrap.stderr) }
	}
	rmSync(join(root, '.tsbuild'), { recursive: true, force: true });
	rmSync(join(root, 'dist'), { recursive: true, force: true });
	const coldStart = performance.now();
	const coldStatus = runBuild();
	report(`cold build (exit ${coldStatus})`, performance.now() - coldStart);

	const noOpStart = performance.now();
	const noOpStatus = runBuild();
	report(`no-op build (exit ${noOpStatus})`, performance.now() - noOpStart);

	const probePath = join(root, 'src', '.profile-change.ts');
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(probePath, 'export const profileChange = true;\n');
	try {
		const changeStart = performance.now();
		const changeStatus = runBuild();
		report(`one-file change build (exit ${changeStatus})`, performance.now() - changeStart);
	} finally {
		rmSync(probePath, { force: true });
	}
}

await measureRuntimePrimitives();
measureCachePrimitives();
await measureEndToEnd();
console.log('\nPrimitive timings:');
for (const timing of timings) { report(timing.name, timing.milliseconds) }
