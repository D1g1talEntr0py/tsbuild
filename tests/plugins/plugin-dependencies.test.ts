import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath } from 'src/@types';
import { discoverLocalDependencies } from 'src/plugins/plugin-dependencies';

const mockState = vi.hoisted(() => ({ resolvedDependency: '' }));

vi.mock('typescript', async (importOriginal) => {
	const typeScript = await importOriginal<typeof import('typescript')>();
	return {
		...typeScript,
		resolveModuleName: vi.fn(() => ({ resolvedModule: { resolvedFileName: mockState.resolvedDependency } }))
	};
});

describe('discoverLocalDependencies', () => {
	it('excludes dependencies resolved through a node_modules path', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'tsbuild-plugin-dependencies-'));
		const entryFile = join(directory, 'plugin.ts');
		const nodeModulesDependency = join(directory, 'node_modules', 'package', 'index.ts');

		try {
			await writeFile(entryFile, "import 'package';\n");
			mockState.resolvedDependency = nodeModulesDependency;
			expect(discoverLocalDependencies(entryFile as AbsolutePath, {})).toEqual(new Set([ entryFile ]));
		} finally {
			mockState.resolvedDependency = '';
			await rm(nodeModulesDependency, { force: true });
			await rm(directory, { recursive: true, force: true });
		}
	});
});