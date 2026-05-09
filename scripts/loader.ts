import process from 'node:process';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { registerHooks, type LoadHookSync, type ResolveHookSync } from 'node:module';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolvePath(projectRoot, 'src');
// Cache lives under node_modules/.cache (standard tooling location) so that tsbuild's
// `--clearCache` (which wipes .tsbuild/) doesn't blow away our transform cache and force
// 30+ esbuild spawnSync calls on the next run.
const cacheDir = resolvePath(projectRoot, 'node_modules', '.cache', 'tsbuild-loader');

mkdirSync(cacheDir, { recursive: true });

const resolveCache = new Map<string, ReturnType<ResolveHookSync>>();
const existsCache = new Map<string, boolean>();
const pathHashCache = new Map<string, string>();

/**
 * Returns a short stable hash for a filesystem path.
 * @param path Absolute filesystem path.
 * @returns Deterministic short hash used in cache file names.
 */
function hashPath(path: string): string {
	const cached = pathHashCache.get(path);
	if (cached !== undefined) { return cached }

	const hash = createHash('sha1').update(path).digest('hex').slice(0, 16);
	pathHashCache.set(path, hash);

	return hash;
}

/**
 * Checks whether a path exists and is a file.
 * @param path Absolute filesystem path.
 * @returns True when the path exists and is a file.
 */
function fileExists(path: string): boolean {
	const cached = existsCache.get(path);
	if (cached !== undefined) { return cached }

	const stat = statSync(path, { throwIfNoEntry: false });
	const exists = stat !== undefined && stat.isFile();
	existsCache.set(path, exists);

	return exists;
}

/**
 * Resolves a TypeScript source path from a module path candidate.
 * @param absPath Absolute candidate path.
 * @returns Matching TypeScript path or null when no source file exists.
 */
function resolveTsPath(absPath: string): string | null {
	if (absPath.endsWith('.ts') && fileExists(absPath)) { return absPath }

	if (absPath.endsWith('.js')) {
		const tsPath = absPath.slice(0, -3) + '.ts';
		if (fileExists(tsPath)) { return tsPath }
	}

	const withTs = absPath + '.ts';
	if (fileExists(withTs)) { return withTs }

	const indexTs = absPath + '/index.ts';
	if (fileExists(indexTs)) { return indexTs }

	return null;
}

const hooks = {
	/**
	 * Resolves project-local TypeScript imports.
	 * @param specifier Module specifier from the importer.
	 * @param context Node hook resolve context.
	 * @param nextResolve Node default resolver.
	 * @returns Resolve result for Node's module loader.
	 */
	resolve(specifier, context, nextResolve) {
		const cacheKey = context.parentURL !== undefined ? specifier + '\0' + context.parentURL : specifier;
		const cached = resolveCache.get(cacheKey);
		if (cached !== undefined) { return cached }

		let absPath: string | null = null;

		if (specifier.startsWith('src/')) {
			absPath = resolvePath(srcRoot, specifier.slice(4));
		} else if (specifier.charCodeAt(0) === 46 /* . */ && context.parentURL !== undefined && context.parentURL.startsWith('file:')) {
			absPath = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
		}

		if (absPath !== null) {
			const tsPath = resolveTsPath(absPath);
			if (tsPath !== null) {
				const result = { url: pathToFileURL(tsPath).href, format: 'module', shortCircuit: true };
				resolveCache.set(cacheKey, result);
				return result;
			}
		}

		return nextResolve(specifier, context);
	},
	/**
	 * Loads and transforms TypeScript files.
	 * @param url Resolved module URL.
	 * @param context Node hook load context.
	 * @param nextLoad Node default loader.
	 * @returns Load result for Node's module loader.
	 */
	load(url, context, nextLoad) {
		if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);

		const path = fileURLToPath(url);
		const stat = statSync(path);
		const cachePath = resolvePath(cacheDir, hashPath(path) + '-' + stat.mtimeMs + '-' + stat.size + '.js');

		let code: string;
		try {
			code = readFileSync(cachePath, 'utf8');
		} catch {
			const source = readFileSync(path, 'utf8');
			code = transformSync(source, {
				loader: 'ts',
				format: 'esm',
				target: 'es2024',
				sourcefile: path,
				sourcemap: 'inline',
				platform: 'node'
			}).code;
			writeFileSync(cachePath, code);
		}

		return { format: 'module', source: code, shortCircuit: true };
	}
} satisfies { resolve: ResolveHookSync; load: LoadHookSync };

registerHooks(hooks);

const entry = process.argv[2];
if (entry !== undefined) {
	const entryUrl = entry.startsWith('file:') ? entry : pathToFileURL(resolvePath(entry)).href;
	process.argv.splice(1, 1);
	await import(entryUrl);
}