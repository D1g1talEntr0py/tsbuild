import { transformSync, version as esbuildVersion } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks, type LoadHookSync, type ResolveHookSync } from 'node:module';
import process from 'node:process';

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = resolvePath(projectRoot, 'src');
// Cache lives under node_modules/.cache (standard tooling location) so that tsbuild's
// `--clearCache` (which wipes .tsbuild/) doesn't blow away our transform cache and force
// 30+ esbuild spawnSync calls on the next run.
const cacheDir = resolvePath(projectRoot, 'node_modules', '.cache', 'tsbuild-loader');

mkdirSync(cacheDir, { recursive: true });

// Snapshot the cache directory once at startup. Membership lookups replace per-load
// readFileSync+ENOENT control flow on cold misses. New entries are added as they're written.
const cachedEntries = new Set<string>(readdirSync(cacheDir));

// Bake the running Node version and esbuild version into every cache key so that
// upgrading either automatically invalidates stale transforms.
const cacheVersion = `${process.versions.node}-${esbuildVersion}`;

type StatInfo = { mtimeMs: number; size: number };

const resolveCache = new Map<string, ReturnType<ResolveHookSync>>();
// Only positive results are cached. Negative results would go stale in long-running watch processes when new files appear.
const statCache = new Map<string, StatInfo>();
const pathHashCache = new Map<string, string>();

/**
 * Returns a stable 16-hex-character SHA-256 hash for a filesystem path.
 *
 * 16 hex chars = 64 bits of hash space (~1.8×10¹⁹ combinations), making
 * collisions effectively impossible even in large monorepos. The result is
 * memoised per process, so each unique path pays the hashing cost at most once.
 *
 * @param path Absolute filesystem path.
 * @returns Deterministic 16-char hex hash used in cache file names.
 */
function hashPath(path: string): string {
	const cached = pathHashCache.get(path);
	if (cached !== undefined) { return cached }

	const hash = createHash('sha256').update(path).digest('hex').slice(0, 16);
	pathHashCache.set(path, hash);

	return hash;
}

/**
 * Returns cached stat info for a regular file, or undefined when the path is missing or not a file.
 * Cached so resolve() and load() share a single statSync() per file.
 * @param path Absolute filesystem path.
 * @returns Stat info (mtimeMs + size) or undefined.
 */
function getStat(path: string): StatInfo | undefined {
	const cached = statCache.get(path);
	if (cached !== undefined) { return cached }

	const stat = statSync(path, { throwIfNoEntry: false });
	if (stat === undefined || !stat.isFile()) { return undefined }

	const info: StatInfo = { mtimeMs: stat.mtimeMs, size: stat.size };
	statCache.set(path, info);

	return info;
}

/**
 * Checks whether a path exists and is a file.
 * @param path Absolute filesystem path.
 * @returns True when the path exists and is a file.
 */
function fileExists(path: string): boolean {
	return getStat(path) !== undefined;
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
		// Fast-path: bare specifiers (node:*, npm packages, absolute paths) skip the cache entirely.
		// Only relative ('.') and src/ aliased imports need TS resolution.
		const firstChar = specifier.charCodeAt(0);
		const isRelative = firstChar === 46 /* . */;
		const isSrcAlias = firstChar === 115 /* s */ && specifier.startsWith('src/');
		if (!isRelative && !isSrcAlias) { return nextResolve(specifier, context) }

		const cacheKey = context.parentURL !== undefined ? specifier + '\0' + context.parentURL : specifier;
		const cached = resolveCache.get(cacheKey);
		if (cached !== undefined) { return cached }

		let absPath: string | null = null;

		if (isSrcAlias) {
			absPath = resolvePath(srcRoot, specifier.slice(4));
		} else if (context.parentURL !== undefined && context.parentURL.startsWith('file:')) {
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
		if (!url.startsWith('file:') || !url.endsWith('.ts')) { return nextLoad(url, context) }

		const path = fileURLToPath(url);
		// Reuse stat info populated by resolve() when available; fall back to statSync otherwise.
		const info = getStat(path);
		if (info === undefined) { return nextLoad(url, context) }

		const cacheFileName = hashPath(path) + '-' + info.mtimeMs + '-' + info.size + '-' + cacheVersion + '.js';
		const cachePath = resolvePath(cacheDir, cacheFileName);

		// Source must be a string: Node's --experimental-strip-types re-processes Buffer sources
		// for .ts URLs, which corrupts pre-transpiled output (e.g. legacy decorators).
		let source: string;
		if (cachedEntries.has(cacheFileName)) {
			source = readFileSync(cachePath, 'utf8');
		} else {
			// Target the exact running Node version so esbuild only down-levels what's needed.
			// minifyWhitespace reduces cache file size for faster warm reads (minifySyntax and
			// minifyIdentifiers are intentionally off — syntax changes risk correctness, and
			// identifier minification breaks debuggers). keepNames prevents esbuild from
			// renaming variables even when minification is off. supported.decorators=false forces
			// decorator transformation because Node's --experimental-strip-types skips it.
			source = transformSync(readFileSync(path), { loader: 'ts', format: 'esm', target: `node${process.versions.node}`, sourcefile: path, platform: 'node', supported: { decorators: false }, minifyWhitespace: true, keepNames: true }).code;
			cachedEntries.add(cacheFileName);
			// Fire-and-forget: the in-memory `source` is already returned to Node; the disk write
			// only matters for future runs, so we don't block the loader on it.
			writeFile(cachePath, source).catch((err: unknown) => {
				process.stderr.write(`[tsbuild-loader] cache write failed for ${cacheFileName}: ${err instanceof Error ? err.message : String(err)}\n`);
			});
		}

		return { format: 'module', source, shortCircuit: true };
	}
} satisfies { resolve: ResolveHookSync; load: LoadHookSync };

registerHooks(hooks);

// If an entry file is provided as a command-line argument, load it to start the application.
const entry = process.argv[2];
if (entry !== undefined) {
	process.argv.splice(1, 1);
	await import(entry.startsWith('file:') ? entry : pathToFileURL(resolvePath(entry)).href);
}