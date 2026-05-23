import { chmod, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { FileExtension } from 'src/constants';
import type { BuildResult, Plugin } from 'esbuild';

/**
 * Sets executable permissions on a file if it starts with a shebang (#!).
 * Reads only the first 2 bytes to minimize I/O.
 * @param filePath The path to the output file.
 */
async function setShebangPermissions(filePath: string): Promise<void> {
	const handle = await open(filePath, 'r');

	try {
		const buf = Buffer.alloc(2);

		await handle.read(buf, 0, 2, 0);

		if (buf[0] === 0x23 && buf[1] === 0x21) { await chmod(filePath, 0o755) }
	} finally {
		await handle.close();
	}
}

/**
 * Post-processes esbuild output to set executable permissions on JS entry points with shebangs.
 * Designed for use with esbuild's `write: true` mode where files are already written to disk.
 */
export const outputPlugin = (): Plugin => {
	return {
		name: 'esbuild:output-plugin',
		/**
		 * Checks JS entry points for shebangs and sets executable permissions.
		 * @param build The esbuild plugin build object.
		 */
		setup(build): void {
			build.onEnd(async ({ metafile }: BuildResult): Promise<void> => {
				if (!metafile) { return }

				const tasks: Promise<void>[] = [];
				for (const [ outputPath, { entryPoint } ] of Object.entries(metafile.outputs)) {
					if (entryPoint && extname(outputPath) === FileExtension.JS) {
						tasks.push(setShebangPermissions(outputPath));
					}
				}

				if (tasks.length > 0) { await Promise.all(tasks) }
			});
		}
	};
};