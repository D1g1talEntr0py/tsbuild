import { extname } from 'node:path';
import { Files } from 'src/files';
import { FileExtension } from 'src/constants';
import type { BuildOptions, BuildResult, OutputFile, Plugin } from 'esbuild';

type PluginOptions = BuildOptions & { write: false };

const FileMode = { READ_WRITE: 0o666, READ_WRITE_EXECUTE: 0o755 } as const;

/**
 * Maps esbuild output files to disk, preserving shebangs for JavaScript files.
 * @param outputFile The output file from esbuild
 * @returns A promise that resolves when the file is written
 */
async function fileMapper({ path, contents }: OutputFile): Promise<void> {
	// Check for shebang in first two bytes: #! (0x23 0x21)
	const mode = extname(path) === FileExtension.JS && contents[0] === 0x23 && contents[1] === 0x21 ? FileMode.READ_WRITE_EXECUTE : FileMode.READ_WRITE;

	return Files.write(path, contents, { mode });
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