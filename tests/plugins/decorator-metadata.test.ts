import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { swcDecoratorMetadataPlugin } from '../../src/plugins/decorator-metadata';
import type { OnLoadArgs, OnLoadResult, PluginBuild } from 'esbuild';
import * as swc from '@swc/core';
import { Encoding } from '../../src/constants';
import { TestHelper } from '../scripts/test-helper';

vi.mock('@swc/core');

describe('swcDecoratorMetadataPlugin', () => {
	let mockBuild: PluginBuild;
	let onLoadCallback: (args: OnLoadArgs) => Promise<OnLoadResult>;

	beforeEach(async () => {
		await TestHelper.setupMemfs();
		// Reset mocks
		vi.resetAllMocks();

		// Mock esbuild's PluginBuild object
		const build: Partial<PluginBuild> = {
			initialOptions: {},
			onLoad: vi.fn((options, callback) => {
				onLoadCallback = callback;
			}),
		};
		mockBuild = build as PluginBuild;
	});

	afterEach(() => {
		TestHelper.teardownMemfs();
	});

	it('should have the correct name', () => {
		expect(swcDecoratorMetadataPlugin.name).toBe('esbuild:swc-decorator-metadata');
	});

	it('should set keepNames to true and register onLoad callback', () => {
		swcDecoratorMetadataPlugin.setup(mockBuild);
		expect(mockBuild.initialOptions.keepNames).toBe(true);
		expect(mockBuild.onLoad).toHaveBeenCalledWith({ filter: expect.any(RegExp) }, expect.any(Function));
	});

	describe('onLoad callback', () => {
		const mockFilePath = '/path/to/file.ts';

		beforeEach(() => {
			swcDecoratorMetadataPlugin.setup(mockBuild);
		});

		it('should transform file with SWC and return code', async () => {
			const mockTransformedCode = 'transformed code;';
			vi.mocked(swc.transformFile).mockResolvedValue({
				code: mockTransformedCode,
				map: undefined,
			});

			const result = await onLoadCallback({ path: mockFilePath });

			expect(swc.transformFile).toHaveBeenCalledWith(mockFilePath, {
				jsc: {
					parser: { syntax: 'typescript', decorators: true },
					transform: { legacyDecorator: true, decoratorMetadata: true },
					keepClassNames: true,
					target: 'esnext',
				},
				sourceMaps: true,
				configFile: false,
				swcrc: false,
			});
			expect(result.contents).toBe(mockTransformedCode);
		});

		it('should process and append sourcemap when available', async () => {
			const mockFilePath = '/path/to/file.ts';
			const mockTransformedCode = 'transformed code;';
			const mockSourceMap = {
				sources: ['/path/to/source1.ts', '/path/to/relative/source2.ts'],
			};
			const mockSourceMapString = JSON.stringify(mockSourceMap);

			vi.mocked(swc.transformFile).mockResolvedValue({
				code: mockTransformedCode,
				map: mockSourceMapString,
			});

			const result = await onLoadCallback({ path: mockFilePath });

			const sourceMapComment = '//# sourceMappingURL=data:application/json;base64,';
			expect(result.contents.startsWith(mockTransformedCode + sourceMapComment)).toBe(true);

			const base64Map = result.contents.slice(mockTransformedCode.length + sourceMapComment.length);
			const decodedMap = JSON.parse(Buffer.from(base64Map, 'base64').toString(Encoding.utf8));

			// It should make the absolute paths relative to the file being processed
			expect(decodedMap.sources).toEqual(['source1.ts', 'relative/source2.ts']);
		});
	});
});
