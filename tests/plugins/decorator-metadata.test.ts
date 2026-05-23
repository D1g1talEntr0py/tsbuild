import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OnLoadArgs, OnLoadResult, PluginBuild } from 'esbuild';
import { Encoding } from 'src/constants';

vi.mock('@swc/core', () => ({
	transformFile: vi.fn(),
}));

const swc = await import('@swc/core');
const { swcDecoratorMetadataPlugin } = await import('src/plugins/decorator-metadata');

describe('swcDecoratorMetadataPlugin', () => {
	let onLoadCallback: (args: OnLoadArgs) => Promise<OnLoadResult>;

	beforeEach(() => {
		vi.resetAllMocks();

		const build: Partial<PluginBuild> = {
			initialOptions: {},
			onLoad: vi.fn((_options, callback) => { onLoadCallback = callback }),
		};
		swcDecoratorMetadataPlugin.setup(build as PluginBuild);
	});

	it('has the correct name', () => {
		expect(swcDecoratorMetadataPlugin.name).toBe('esbuild:swc-decorator-metadata');
	});

	it('sets keepNames to true', () => {
		const build: Partial<PluginBuild> = {
			initialOptions: {},
			onLoad: vi.fn(),
		};
		swcDecoratorMetadataPlugin.setup(build as PluginBuild);
		expect(build.initialOptions!.keepNames).toBe(true);
	});

	it('registers onLoad with TypeScript extension filter', () => {
		const build: Partial<PluginBuild> = {
			initialOptions: {},
			onLoad: vi.fn(),
		};
		swcDecoratorMetadataPlugin.setup(build as PluginBuild);
		expect(build.onLoad).toHaveBeenCalledWith({ filter: expect.any(RegExp) }, expect.any(Function));
	});

	describe('onLoad callback', () => {
		it('transforms file with SWC and returns code', async () => {
			vi.mocked(swc.transformFile).mockResolvedValue({ code: 'transformed;', map: undefined });

			const result = await onLoadCallback({ path: '/src/file.ts' } as OnLoadArgs);

			expect(swc.transformFile).toHaveBeenCalledWith('/src/file.ts', expect.objectContaining({
				jsc: expect.objectContaining({
					parser: { syntax: 'typescript', decorators: true },
					transform: { legacyDecorator: true, decoratorMetadata: true },
					keepClassNames: true,
					target: 'esnext',
				}),
				sourceMaps: true,
			}));
			expect(result.contents).toBe('transformed;');
		});

		it('handles undefined source map', async () => {
			vi.mocked(swc.transformFile).mockResolvedValue({ code: 'code;', map: undefined });

			const result = await onLoadCallback({ path: '/src/file.ts' } as OnLoadArgs);
			expect(result.contents).toBe('code;');
		});

		it('appends inline base64 source map with relative paths', async () => {
			const sourceMap = JSON.stringify({
				sources: ['/path/to/source1.ts', '/path/to/sub/source2.ts'],
			});
			vi.mocked(swc.transformFile).mockResolvedValue({ code: 'code;', map: sourceMap });

			const result = await onLoadCallback({ path: '/path/to/file.ts' } as OnLoadArgs);

			const prefix = '//# sourceMappingURL=data:application/json;base64,';
			expect(result.contents).toContain(prefix);

			const base64 = (result.contents as string).split(prefix)[1];
			const decoded = JSON.parse(Buffer.from(base64, Encoding.base64).toString(Encoding.utf8));
			expect(decoded.sources).toEqual(['source1.ts', 'sub/source2.ts']);
		});
	});
});
