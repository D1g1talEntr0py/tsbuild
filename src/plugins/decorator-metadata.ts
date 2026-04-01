import { Json } from 'src/json';
import { Paths } from 'src/paths';
import { dirname } from 'node:path';
import { Encoding, typeScriptExtensionExpression as filter } from 'src/constants';
import type { OnLoadResult, Plugin } from 'esbuild';
import type { RelativePath, JsonString, SourceMap } from 'src/@types';

const swcOptions = {
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

// Cached reference to SWC's transformFile — resolved lazily on first use and reused for all subsequent files
let swcTransformFile: typeof import('@swc/core').transformFile | undefined;

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
			swcTransformFile ??= (await import('@swc/core')).transformFile;
			const result = await swcTransformFile(path, swcOptions);

			if (result.map) {
				const map = Json.parse(result.map as JsonString<SourceMap>);
				const sources: RelativePath[] = [];
				// Convert absolute paths to relative paths for portability
				for (const source of map.sources) {
					sources.push(Paths.relative(dirname(path), source));
				}

				map.sources = sources;
				result.code += `//# sourceMappingURL=data:application/json;base64,${Buffer.from(Json.serialize(map)).toString(Encoding.base64)}`;
			}

			return { contents: result.code };
		});
	}
};