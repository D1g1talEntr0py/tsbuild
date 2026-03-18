import { extname } from 'node:path';
import { Files } from 'src/files';
import { FileExtension } from 'src/constants';
import type { BuildOptions, BuildResult, OutputFile, Plugin } from 'esbuild';

type PluginOptions = BuildOptions & { write: false };

const FileMode = { READ_WRITE: 0o666, READ_WRITE_EXECUTE: 0o755 } as const;

const relativeSpecifierPattern = /(from\s+['"])(\.\.?\/[^'"]*?)(['"])/g;

/**
 * Rewrites extension-less relative specifiers in emitted JS/DTS output to include `.js`.
 * TypeScript source files with `moduleResolution: "Bundler"` use extension-less imports,
 * but emitted ESM output requires explicit extensions for Node resolution.
 * @param code The emitted file content to rewrite.
 * @returns The content with `.js` appended to bare relative specifiers.
 */
export function rewriteRelativeSpecifiers(code: string): string {
	return code.replace(relativeSpecifierPattern, (_, before: string, path: string, after: string) => {
		if (/\.[a-z]+$/i.test(path)) return before + path + after;
		return `${before}${path}.js${after}`;
	});
}

/**
 * Maps esbuild output files to disk, preserving shebangs for JavaScript files.
 * @param outputFile The output file from esbuild
 * @returns A promise that resolves when the file is written
 */
async function fileMapper({ path, contents }: OutputFile): Promise<void> {
	const isJs = extname(path) === FileExtension.JS;
	// Check for shebang in first two bytes: #! (0x23 0x21)
	const mode = isJs && contents[0] === 0x23 && contents[1] === 0x21 ? FileMode.READ_WRITE_EXECUTE : FileMode.READ_WRITE;
	const finalContents = isJs
		? new TextEncoder().encode(rewriteRelativeSpecifiers(new TextDecoder().decode(contents)))
		: contents;

	return Files.write(path, finalContents, { mode });
}

/**
 * Processes the output from esbuild and writes the files to the output directory
 * @returns The esbuild plugin for handling output files
 */
export const outputPlugin = (): Plugin => {
	return {
		name: 'esbuild:output-plugin',
		/**
		 * Configures the esbuild build instance to write output files to disk
		 * @param build The esbuild build instance
		 */
		setup(build): void {
			build.onEnd(async ({ outputFiles }: BuildResult<PluginOptions>): Promise<void> => void await Promise.all(outputFiles.map(fileMapper)));
		}
	};
};