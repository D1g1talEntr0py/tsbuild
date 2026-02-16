import { Json } from 'src/json';
import { Paths } from 'src/paths';
import { dirname } from 'node:path';
import { transformFile, type Options as SwcOptions } from '@swc/core';
import { Encoding, typeScriptExtensionExpression as filter } from 'src/constants';
import type { OnLoadResult, Plugin } from 'esbuild';
import type { RelativePath, JsonString, SourceMap } from 'src/@types';

const swcOptions: SwcOptions = {
	jsc: {
		parser: { syntax: 'typescript', decorators: true },
		transform: { legacyDecorator: true, decoratorMetadata: true },
		keepClassNames: true,
		target: 'esnext'
	},
	sourceMaps: true,
	configFile: false,
	swcrc: false
};

// Use SWC to emit decorator metadata
export const swcDecoratorMetadataPlugin: Plugin = {
	name: 'esbuild:swc-decorator-metadata',
	/**
	 * Setup esbuild to use SWC for transforming TypeScript files with decorator metadata.
	 * This plugin overrides the default TypeScript handling in esbuild to ensure
	 * that decorator metadata is correctly emitted.
	 * @param build The esbuild build instance.
	 */
	setup(build): void {
		// Force esbuild to keep class names as well
		build.initialOptions.keepNames = true;
		build.onLoad({ filter }, async ({ path }): Promise<OnLoadResult> => {
			const result = await transformFile(path, swcOptions);

			if (result.map) {
				const sources: RelativePath[] = [];
				// Convert absolute paths to relative paths for portability
				for (const source of Json.parse(result.map as JsonString<SourceMap>).sources) {
					sources.push(Paths.relative(dirname(path), source));
				}
				result.code += `//# sourceMappingURL=data:application/json;base64,${Buffer.from(Json.serialize({ sources })).toString(Encoding.base64)}`;
			}

			return { contents: result.code };
		});
	}
};