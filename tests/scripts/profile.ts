#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { brotliCompressSync, brotliDecompressSync, constants as brotliConstants } from 'node:zlib';
import { deserialize, serialize } from 'node:v8';
import { dtsCacheFile } from 'src/constants';

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
	const { API, EmitOnly } = await import('typescript/sync');
	report('typescript import', performance.now() - typescriptStart);

	using api = measure('start native API', () => new API({ cwd: root }));
	const configPath = join(root, 'tsconfig.json');
	const config = api.readConfigFile(configPath) as { config?: object; error?: { text: string } };
	if (config.error !== undefined) { throw new Error(config.error.text) }
	const parsed = api.parseJsonConfigFileContent(config.config ?? {}, { configFileName: configPath });

	using snapshot = measure('create snapshot', () => api.createSnapshot({ createPrograms: [ { rootFiles: parsed.fileNames, compilerOptions: parsed.options } ] }));
	const program = snapshot.operation.createdPrograms[0];
	measure('semantic diagnostics', () => program.getSemanticDiagnostics());
	measure('declaration emit', () => program.emitToString(EmitOnly.OnlyDts));
	measure('parse source file', () => {
		using retained = api.createSourceFile(join(root, 'src/logger.ts'), readFileSync(join(root, 'src/logger.ts'), 'utf8'));
		return retained.sourceFile;
	});
}

function measureCachePrimitives(): void {
	const cachePath = join(root, '.tsbuild', dtsCacheFile);
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

async function measureCheckHeavy(): Promise<void> {
	const { API, EmitOnly, formatDiagnosticsWithColorAndContext } = await import('typescript/sync');
	const dir = mkdtempSync(join(tmpdir(), 'tsbuild-profile-check-heavy-'));
	try {
		const rootFiles: string[] = [];
		for (let i = 0; i < 200; i++) {
			const left = Array.from({ length: 60 }, (_, j) => `"a${i}_${j}"`).join(' | ');
			const right = Array.from({ length: 30 }, (_, j) => `"b${i}_${j}"`).join(' | ');
			const path = join(dir, `module-${i}.ts`);
			writeFileSync(path, `type L${i} = ${left};
type R${i} = ${right};
type X${i} = \`\${L${i}}-\${R${i}}\`;
type Obj${i} = { [K in X${i}]: { k: K; n: ${i} } };
type Vals${i} = Obj${i}[X${i}];
type Tup${i}<N extends number, A extends unknown[] = []> = A['length'] extends N ? A : Tup${i}<N, [...A, ${i}]>;
type Add${i}<A extends number, B extends number> = [...Tup${i}<A>, ...Tup${i}<B>]['length'];
export const s${i}: Add${i}<400, 399> = 799;
export function pick${i}(v: Vals${i}): X${i} { return v.k; }
export const o${i}: Partial<Obj${i}> = {};
declare const all${i}: Vals${i}[];
export const ks${i} = all${i}.map((v) => v.k satisfies X${i});
`);
			rootFiles.push(path);
		}

		using api = new API({ cwd: dir });
		const parsed = api.parseJsonConfigFileContent({
			compilerOptions: { target: 'ESNext', lib: [ 'ESNext' ], types: [], module: 'ESNext', moduleResolution: 'Bundler', strict: true, declaration: true, skipLibCheck: true },
			files: rootFiles
		}, { configFileName: join(dir, 'tsconfig.json') });
		if (parsed.errors.length > 0) { throw new Error(formatDiagnosticsWithColorAndContext(parsed.errors, api)) }

		console.log('\nHigh-complexity type-checking (200 modules):');
		using snapshot = measure('check-heavy create snapshot', () => api.createSnapshot({ createPrograms: [ { rootFiles, compilerOptions: parsed.options } ] }));
		const program = snapshot.operation.createdPrograms[0];
		const diagnostics = measure('check-heavy complete diagnostics', () => api.batch(
			program.getProgramDiagnostics.gen(),
			program.getSyntacticDiagnostics.gen(),
			program.getGlobalDiagnostics.gen(),
			program.getSemanticDiagnostics.gen(),
			program.getDeclarationDiagnostics.gen()
		).flat());
		if (diagnostics.length > 0) { throw new Error(formatDiagnosticsWithColorAndContext(diagnostics, api)) }

		const output = measure('check-heavy declaration emit', () => program.emitToString(EmitOnly.OnlyDts));
		if (output.diagnostics?.length) { throw new Error(formatDiagnosticsWithColorAndContext(output.diagnostics, api)) }
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
await measureCheckHeavy();
console.log('\nPrimitive timings:');
for (const timing of timings) { report(timing.name, timing.milliseconds) }
