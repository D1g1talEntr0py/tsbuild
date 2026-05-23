import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', async () => {
	const memfs = await import('memfs');
	return memfs.fs.promises;
});

vi.mock('node:fs', async () => {
	const memfs = await import('memfs');
	return memfs.fs;
});

import { vol } from 'memfs';
import { IncrementalBuildCache } from 'src/incremental-build-cache';
import type { AbsolutePath, CachedDeclaration } from 'src/@types';
import { join } from 'node:path';

const projectRoot = '/project' as AbsolutePath;
const buildInfoFile = 'tsconfig.tsbuildinfo';

beforeEach(() => {
	vol.reset();
	vol.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => { vol.reset() });

describe('IncrementalBuildCache', () => {
	describe('constructor', () => {
		it('creates a cache instance', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache).toBeInstanceOf(IncrementalBuildCache);
		});

		it('has correct toStringTag', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(Object.prototype.toString.call(cache)).toBe('[object IncrementalBuildCache]');
		});
	});

	describe('restore', () => {
		it('restores cached declarations from saved cache', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const source = new Map<string, CachedDeclaration>([
				['/project/src/a.d.ts', { code: 'declare const a: string;', typeReferences: new Set<string>(), fileReferences: new Set<string>() }],
				['/project/src/b.d.ts', { code: 'declare const b: number;', typeReferences: new Set<string>(), fileReferences: new Set<string>() }],
			]);
			await cache1.save(source, false);

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);
			expect(target.size).toBe(2);
			expect(target.get('/project/src/a.d.ts')?.code).toBe('declare const a: string;');
			expect(target.get('/project/src/b.d.ts')?.code).toBe('declare const b: number;');
		});

		it('handles missing cache file gracefully', async () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);
			expect(target.size).toBe(0);
		});

		it('handles corrupt cache file gracefully', async () => {
			const cacheDir = join(projectRoot, '.tsbuild');
			vol.mkdirSync(cacheDir, { recursive: true });
			vol.writeFileSync(join(cacheDir, 'dts_cache.v8.br'), 'not valid brotli data');

			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);
			expect(target.size).toBe(0);
		});

		it('skips restoration when cache is invalidated', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const source = new Map<string, CachedDeclaration>([
				['/project/src/a.d.ts', { code: 'declare const a: string;', typeReferences: new Set<string>(), fileReferences: new Set<string>() }],
			]);
			await cache1.save(source, false);

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			cache2.invalidate();
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);
			expect(target.size).toBe(0);
		});
	});

	describe('save', () => {
		it('saves declarations to compressed cache file', async () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const source = new Map<string, CachedDeclaration>([
				['/project/src/a.d.ts', { code: 'declare const a: string;', typeReferences: new Set<string>(), fileReferences: new Set<string>() }],
			]);
			await cache.save(source, false);
			const cacheFile = join(projectRoot, '.tsbuild', 'dts_cache.v8.br');
			expect(vol.existsSync(cacheFile)).toBe(true);
		});

		it('round-trips save and restore with multiple files', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const source = new Map<string, CachedDeclaration>();
			for (let i = 0; i < 10; i++) {
				source.set(`/project/src/file${i}.d.ts`, {
					code: `declare const file${i}: string;`,
					typeReferences: i % 2 === 0 ? new Set(['node']) : new Set<string>(),
					fileReferences: new Set<string>(),
				});
			}
			await cache1.save(source, false);

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const target = new Map<string, CachedDeclaration>();
			await cache2.restore(target);
			expect(target.size).toBe(10);
			expect([...target.get('/project/src/file0.d.ts')!.typeReferences]).toEqual(['node']);
			expect([...target.get('/project/src/file1.d.ts')!.typeReferences]).toEqual([]);
		});
	});

	describe('invalidate', () => {
		it('removes the cache directory', async () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const source = new Map<string, CachedDeclaration>([
				['/project/src/a.d.ts', { code: 'declare const a: string;', typeReferences: new Set<string>(), fileReferences: new Set<string>() }],
			]);
			await cache.save(source, false);
			cache.invalidate();
			expect(vol.existsSync(join(projectRoot, '.tsbuild'))).toBe(false);
		});

		it('does not throw if cache directory does not exist', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(() => cache.invalidate()).not.toThrow();
		});
	});

	describe('isBuildInfoFile', () => {
		it('returns true for matching build info path', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache.isBuildInfoFile(join(projectRoot, buildInfoFile) as AbsolutePath)).toBe(true);
		});

		it('returns false for non-matching path', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache.isBuildInfoFile('/other/path' as AbsolutePath)).toBe(false);
		});
	});

	describe('isValid', () => {
		it('returns true initially', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache.isValid()).toBe(true);
		});

		it('returns false after invalidation', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			cache.invalidate();
			expect(cache.isValid()).toBe(false);
		});
	});

	describe('output manifest', () => {
		it('returns undefined when no manifest exists', () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache.hasPersistedManifest()).toBe(false);
			expect(cache.getPreviousOutputs()).toBeUndefined();
		});

		it('round-trips outputs through saveOutputs/getPreviousOutputs', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			await cache1.saveOutputs([ 'dist/a.js', 'dist/b.js' ]);

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache2.hasPersistedManifest()).toBe(true);
			expect(cache2.getPreviousOutputs()).toEqual([ 'dist/a.js', 'dist/b.js' ]);
		});

		it('saveOutputs creates the cache directory if missing', async () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			await cache.saveOutputs([ 'dist/x.js' ]);
			expect(vol.existsSync(join(projectRoot, '.tsbuild', 'outputs.manifest.json'))).toBe(true);
		});

		it('updates in-memory snapshot immediately so subsequent reads do not race the disk write', async () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const writePromise = cache.saveOutputs([ 'dist/fresh.js' ]);
			expect(cache.getPreviousOutputs()).toEqual([ 'dist/fresh.js' ]);
			await writePromise;
		});

		it('preserves the snapshot across invalidate so manifest-driven cleanup survives --clearCache', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			await cache1.saveOutputs([ 'dist/a.js' ]);

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			cache2.invalidate();
			expect(cache2.hasPersistedManifest()).toBe(true);
			expect(cache2.getPreviousOutputs()).toEqual([ 'dist/a.js' ]);
		});

		it('handles malformed manifest gracefully', () => {
			const cacheDir = join(projectRoot, '.tsbuild');
			vol.mkdirSync(cacheDir, { recursive: true });
			vol.writeFileSync(join(cacheDir, 'outputs.manifest.json'), 'not valid json');

			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache.getPreviousOutputs()).toBeUndefined();
		});

		it('ignores non-array manifest payloads', () => {
			const cacheDir = join(projectRoot, '.tsbuild');
			vol.mkdirSync(cacheDir, { recursive: true });
			vol.writeFileSync(join(cacheDir, 'outputs.manifest.json'), JSON.stringify({ outputs: [] }));

			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(cache.getPreviousOutputs()).toBeUndefined();
		});
	});

	describe('fingerprint matching', () => {
		it('returns false when fingerprint does not match', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			await cache1.save(new Map(), 'fingerprint-v1');
			vol.writeFileSync(join(projectRoot, buildInfoFile), '{}');

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(await cache2.fingerprintMatches('fingerprint-v2')).toBe(false);
		});

		it('returns true when fingerprint matches', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			await cache1.save(new Map(), 'fingerprint-v1');
			vol.writeFileSync(join(projectRoot, buildInfoFile), '{}');

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(await cache2.fingerprintMatches('fingerprint-v1')).toBe(true);
		});

		it('returns false when cache is invalidated', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			await cache1.save(new Map(), 'fingerprint-v1');
			vol.writeFileSync(join(projectRoot, buildInfoFile), '{}');

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			cache2.invalidate();
			expect(await cache2.fingerprintMatches('fingerprint-v1')).toBe(false);
		});

		it('returns false when persisted state does not exist', async () => {
			const cache = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(await cache.fingerprintMatches('fingerprint-v1')).toBe(false);
		});

		it('persists fingerprint in cache for next build', async () => {
			const cache1 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			const declarations = new Map<string, CachedDeclaration>([['file.d.ts', { code: 'export {};', typeReferences: new Set<string>(), fileReferences: new Set<string>() }]]);
			await cache1.save(declarations, 'fingerprint-abc123');
			vol.writeFileSync(join(projectRoot, buildInfoFile), '{}');

			const cache2 = new IncrementalBuildCache(projectRoot, buildInfoFile);
			expect(await cache2.fingerprintMatches('fingerprint-abc123')).toBe(true);
			const restored = new Map<string, CachedDeclaration>();
			await cache2.restore(restored);
			expect(restored.get('file.d.ts')?.code).toBe('export {};');
		});
	});
});
