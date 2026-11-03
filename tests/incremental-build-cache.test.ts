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
import type { AbsolutePath, BuildInputManifest, CachedDeclaration } from 'src/@types';
import { join } from 'node:path';
import { Files } from 'src/files';
import { Paths } from 'src/paths';
import { dtsCacheFile, dtsCacheVersion } from 'src/constants';

const projectRoot = '/project' as AbsolutePath;
const inputPath = '/project/src/index.ts' as AbsolutePath;
const cachedDeclaration: CachedDeclaration = {
	code: 'declare const value: string;', typeReferences: new Set<string>(), fileReferences: new Set<string>(),
};
const manifestFor = (key: string, files: BuildInputManifest['files'] = []): BuildInputManifest => ({ key, files });

beforeEach(() => {
	vol.reset();
	vol.mkdirSync(projectRoot, { recursive: true });
});
afterEach(() => { vol.reset() });

describe('IncrementalBuildCache', () => {
	it('constructs with the expected inspection tag and valid state', () => {
		const cache = new IncrementalBuildCache(projectRoot);
		expect(cache).toBeInstanceOf(IncrementalBuildCache);
		expect(Object.prototype.toString.call(cache)).toBe('[object IncrementalBuildCache]');
		expect(cache.isValid()).toBe(true);
	});

	describe('manifest', () => {
		it('round-trips declarations and the input manifest', async () => {
			vol.mkdirSync(join(projectRoot, 'src'), { recursive: true });
			vol.writeFileSync(inputPath, 'export const value = 1;');
			const stat = vol.statSync(inputPath);
			const manifest = manifestFor('key-1', [[inputPath, stat.mtimeMs, stat.size]]);
			const source = new Map<string, CachedDeclaration>([[inputPath, cachedDeclaration]]);
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.save(source, 'fingerprint', manifest);

			const restored = new IncrementalBuildCache(projectRoot);
			const target = new Map<string, CachedDeclaration>();
			await restored.restore(target);
			expect(target.get(inputPath)).toEqual(cachedDeclaration);
			expect(await restored.upToDateManifest('key-1')).toEqual(manifest);
			expect(await restored.fingerprintMatches('fingerprint')).toBe(true);
		});

		it('returns undefined for absent manifests and mismatched keys', async () => {
			const empty = new IncrementalBuildCache(projectRoot);
			expect(await empty.upToDateManifest('key')).toBeUndefined();
			await empty.save(new Map(), 'fingerprint', manifestFor('stored-key'));
			const restored = new IncrementalBuildCache(projectRoot);
			expect(await restored.upToDateManifest('other-key')).toBeUndefined();
		});

		it('invalidates a manifest when an input mtime or size changes', async () => {
			vol.mkdirSync(join(projectRoot, 'src'), { recursive: true });
			vol.writeFileSync(inputPath, 'content');
			const stat = vol.statSync(inputPath);
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.save(new Map(), 'fingerprint', manifestFor('key', [[inputPath, stat.mtimeMs + 1, stat.size]]));
			expect(await new IncrementalBuildCache(projectRoot).upToDateManifest('key')).toBeUndefined();

			await cache.save(new Map(), 'fingerprint', manifestFor('key', [[inputPath, stat.mtimeMs, stat.size + 1]]));
			expect(await new IncrementalBuildCache(projectRoot).upToDateManifest('key')).toBeUndefined();
		});

		it('invalidates missing inputs and records whose mtime is -1', async () => {
			vol.mkdirSync(join(projectRoot, 'src'), { recursive: true });
			vol.writeFileSync(inputPath, 'content');
			const stat = vol.statSync(inputPath);
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.save(new Map(), 'fingerprint', manifestFor('key', [[inputPath, -1, stat.size]]));
			expect(await new IncrementalBuildCache(projectRoot).upToDateManifest('key')).toBeUndefined();
			await cache.save(new Map(), 'fingerprint', manifestFor('key', [['/project/missing.ts', -1, 0]]));
			expect(await new IncrementalBuildCache(projectRoot).upToDateManifest('key')).toBeUndefined();
		});

		it('accepts a matching manifest with no inputs and skips checks after invalidation', async () => {
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.save(new Map(), 'fingerprint', manifestFor('key'));
			expect(await cache.upToDateManifest('key')).toEqual(manifestFor('key'));
			cache.invalidate();
			expect(await cache.upToDateManifest('key')).toBeUndefined();
		});
	});

	describe('restore and cache loading', () => {
		it('restores multiple files and tolerates a missing cache', async () => {
			const source = new Map<string, CachedDeclaration>([
				['/project/src/a.d.ts', cachedDeclaration],
				['/project/src/b.d.ts', { ...cachedDeclaration, code: 'declare const other: number;' }],
			]);
			await new IncrementalBuildCache(projectRoot).save(source, 'fingerprint');
			const target = new Map<string, CachedDeclaration>();
			await new IncrementalBuildCache(projectRoot).restore(target);
			expect(target.size).toBe(2);
			expect(target.get('/project/src/b.d.ts')?.code).toContain('other');
			await new IncrementalBuildCache(projectRoot).restore(new Map());
		});

		it('skips restore after invalidation', async () => {
			await new IncrementalBuildCache(projectRoot).save(new Map([['file.d.ts', cachedDeclaration]]), 'fingerprint');
			const cache = new IncrementalBuildCache(projectRoot);
			cache.invalidate();
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);
			expect(target.size).toBe(0);
		});

		it.each([
			['wrong version', { version: dtsCacheVersion - 1, files: new Map() }],
			['wrong files type', { version: dtsCacheVersion, files: [] }],
			['non-array artifacts', { version: dtsCacheVersion, files: new Map(), outputArtifacts: 'bad' }],
			['non-string artifacts', { version: dtsCacheVersion, files: new Map(), outputArtifacts: ['ok', 1] }],
		])('ignores a cache payload with %s', async (_label, payload) => {
			await Files.writeCompressed(Paths.join(projectRoot, '.tsbuild', dtsCacheFile), payload);
			const cache = new IncrementalBuildCache(projectRoot);
			expect(await cache.fingerprintMatches('fingerprint')).toBe(false);
			expect(await cache.expectedOutputsExist()).toBe(false);
			const target = new Map<string, CachedDeclaration>();
			await cache.restore(target);
			expect(target.size).toBe(0);
		});

		it('handles unreadable compressed cache contents', async () => {
			vol.mkdirSync(join(projectRoot, '.tsbuild'), { recursive: true });
			vol.writeFileSync(join(projectRoot, '.tsbuild', dtsCacheFile), 'invalid brotli data');
			const cache = new IncrementalBuildCache(projectRoot);
			expect(await cache.fingerprintMatches('fingerprint')).toBe(false);
			await expect(cache.restore(new Map())).resolves.toBeUndefined();
		});
	});

	describe('expected outputs', () => {
		it('checks the latest saved artifacts on the same cache instance, including deletions', async () => {
			vol.fromJSON({ '/project/dist/first.js': '', '/project/dist/next.js': '' });
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.restore(new Map());
			cache.setExpectedOutputArtifacts(['/project/dist/first.js' as AbsolutePath]);
			await cache.save(new Map(), 'first');
			expect(await cache.expectedOutputsExist()).toBe(true);

			cache.setExpectedOutputArtifacts(['/project/dist/next.js' as AbsolutePath]);
			await cache.save(new Map(), 'next');
			vol.unlinkSync('/project/dist/first.js');
			expect(await cache.expectedOutputsExist()).toBe(true);
			expect(await cache.fingerprintMatches('next')).toBe(true);
			expect(await cache.fingerprintMatches('first')).toBe(false);
			vol.unlinkSync('/project/dist/next.js');
			expect(await cache.expectedOutputsExist()).toBe(false);
		});

		it('returns true when each persisted artifact exists', async () => {
			const cache = new IncrementalBuildCache(projectRoot);
			cache.setExpectedOutputArtifacts(['/project/dist/index.js' as AbsolutePath, '/project/dist/index.d.ts' as AbsolutePath]);
			await cache.save(new Map(), 'fingerprint');
			vol.mkdirSync(join(projectRoot, 'dist'), { recursive: true });
			vol.writeFileSync('/project/dist/index.js', '');
			vol.writeFileSync('/project/dist/index.d.ts', '');
			expect(await new IncrementalBuildCache(projectRoot).expectedOutputsExist()).toBe(true);
		});

		it('returns false for absent or missing artifacts, draining only the submitted batch', async () => {
			const noArtifacts = new IncrementalBuildCache(projectRoot);
			await noArtifacts.save(new Map(), 'fingerprint');
			expect(await new IncrementalBuildCache(projectRoot).expectedOutputsExist()).toBe(false);
			const cache = new IncrementalBuildCache(projectRoot);
			const paths = Array.from({ length: 130 }, (_, i) => `/project/dist/${i}.js` as AbsolutePath);
			cache.setExpectedOutputArtifacts(paths);
			await cache.save(new Map(), 'fingerprint');
			const restored = new IncrementalBuildCache(projectRoot);
			const exists = vi.spyOn(Files, 'exists');
			try {
				expect(await restored.expectedOutputsExist()).toBe(false);
				expect(exists).toHaveBeenCalledTimes(64);
				expect(exists.mock.calls.map(([path]) => path)).toEqual(paths.slice(0, 64));
			} finally { exists.mockRestore() }
		});

		it('bounds live artifact checks and checks every artifact on each call', async () => {
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.restore(new Map());
			const paths = Array.from({ length: 150 }, (_, i) => `/project/dist/${i}.js` as AbsolutePath);
			cache.setExpectedOutputArtifacts(paths);
			let active = 0, peak = 0;
			const exists = vi.spyOn(Files, 'exists').mockImplementation(async () => {
				peak = Math.max(peak, ++active);
				await new Promise<void>((resolve) => setImmediate(resolve));
				active--;
				return true;
			});
			try {
				expect(await cache.expectedOutputsExist()).toBe(true);
				expect(peak).toBe(64);
				expect(active).toBe(0);
				expect(exists.mock.calls.map(([path]) => path)).toEqual(paths);
				exists.mockClear();
				expect(await cache.expectedOutputsExist()).toBe(true);
				expect(exists).toHaveBeenCalledTimes(paths.length);
			} finally { exists.mockRestore() }
		});

		it.each([false, true])('preserves ordered missing/access-error results (error first: %s)', async (errorFirst) => {
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.restore(new Map());
			cache.setExpectedOutputArtifacts(['/project/dist/first.js' as AbsolutePath, '/project/dist/second.js' as AbsolutePath]);
			const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
			let active = 0;
			const exists = vi.spyOn(Files, 'exists').mockImplementation(async (path) => {
				active++;
				await new Promise<void>((resolve) => setImmediate(resolve));
				active--;
				if ((path === '/project/dist/first.js') === errorFirst) { throw error }
				return false;
			});
			try {
				if (errorFirst) { await expect(cache.expectedOutputsExist()).rejects.toBe(error) }
				else { expect(await cache.expectedOutputsExist()).toBe(false) }
				expect(active).toBe(0);
			} finally { exists.mockRestore() }
		});

		it('accepts an explicitly empty artifact set without filesystem checks', async () => {
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.restore(new Map());
			cache.setExpectedOutputArtifacts([]);
			const exists = vi.spyOn(Files, 'exists');
			try {
				expect(await cache.expectedOutputsExist()).toBe(true);
				expect(exists).not.toHaveBeenCalled();
			} finally { exists.mockRestore() }
		});

		it('returns false after invalidation', async () => {
			const cache = new IncrementalBuildCache(projectRoot);
			cache.setExpectedOutputArtifacts(['/project/dist/index.js' as AbsolutePath]);
			await cache.save(new Map(), 'fingerprint');
			const restored = new IncrementalBuildCache(projectRoot);
			restored.invalidate();
			expect(await restored.expectedOutputsExist()).toBe(false);
		});
	});

	describe('invalidate and validity', () => {
		it('removes the cache directory and marks the cache invalid', async () => {
			await new IncrementalBuildCache(projectRoot).save(new Map(), 'fingerprint');
			const cache = new IncrementalBuildCache(projectRoot);
			cache.invalidate();
			expect(cache.isValid()).toBe(false);
			expect(vol.existsSync(join(projectRoot, '.tsbuild'))).toBe(false);
		});
		it('does not throw when the cache directory does not exist', () => {
			expect(() => new IncrementalBuildCache(projectRoot).invalidate()).not.toThrow();
		});
	});

	describe('fingerprint matching', () => {
		it('matches saved and restored fingerprints and rejects mismatches', async () => {
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.save(new Map(), 'fingerprint-v1');
			expect(await cache.fingerprintMatches('fingerprint-v1')).toBe(true);
			expect(await cache.fingerprintMatches('fingerprint-v2')).toBe(false);
			const restored = new IncrementalBuildCache(projectRoot);
			expect(await restored.fingerprintMatches('fingerprint-v1')).toBe(true);
			expect(await restored.fingerprintMatches('missing')).toBe(false);
		});
		it('rejects fingerprints after invalidation', async () => {
			const cache = new IncrementalBuildCache(projectRoot);
			await cache.save(new Map(), 'fingerprint');
			cache.invalidate();
			expect(await cache.fingerprintMatches('fingerprint')).toBe(false);
		});
	});
});
