import { extname } from 'node:path';
import { chmod, open, readFile, writeFile } from 'node:fs/promises';
import { FileExtension } from 'src/constants';
import type { BuildResult, Plugin } from 'esbuild';

const fromSpecifierPattern = /(\bfrom\s*['"])(\.\.?\/[^'"?#]*)([^'"]*)(['"])/g;
const sideEffectImportPattern = /(\bimport\s*['"])(\.\.?\/[^'"?#]*)([^'"]*)(['"])/g;
const dynamicImportPattern = /(\bimport\(\s*['"])(\.\.?\/[^'"?#]*)([^'"]*)(['"]\s*\))/g;
const fileExtensionPattern = /\.[^./]+$/i;

/**
 * Returns true when the path portion of a specifier already has a file extension.
 * @param path The path portion of an import specifier (no query/hash)
 */
function hasExtension(path: string) {
	const index = path.lastIndexOf('/');
	return fileExtensionPattern.test(index === -1 ? path : path.slice(index + 1));
}

/**
 * Appends `.js` to extension-less relative specifiers while preserving query/hash suffixes.
 * @param path Relative module specifier path (without quote characters)
 * @param suffix Any query/hash suffix captured after the path
 */
function appendJsExtension(path: string, suffix: string) {
	return path.endsWith('/') || hasExtension(path) ? path + suffix : path + FileExtension.JS + suffix;
}

/**
 * Rewrites extension-less relative import/export/dynamic-import specifiers to include `.js`.
 * @param code The JavaScript output content to rewrite
 */
function rewriteRelativeSpecifiers(code: string) {
	const rewrite = (_: string, before: string, path: string, suffix: string, after: string): string => `${before}${appendJsExtension(path, suffix)}${after}`;

	return code
		.replace(fromSpecifierPattern, rewrite)
		.replace(sideEffectImportPattern, rewrite)
		.replace(dynamicImportPattern, rewrite);
}

/**
 * Sets executable permissions on a file if it starts with a shebang (#!).
 * Reads only the first 2 bytes to minimize I/O.
 * @param filePath The path to the output file.
 */
async function setShebangPermissions(filePath: string) {
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
 * Rewrites extension-less relative JS specifiers in an emitted output file.
 * @param filePath The emitted JavaScript file path
 */
async function rewriteOutputSpecifiers(filePath: string) {
	const source = await readFile(filePath, 'utf8');
	const rewritten = rewriteRelativeSpecifiers(source);
	if (rewritten !== source) { await writeFile(filePath, rewritten) }
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
			build.onEnd(async ({ metafile }: BuildResult) => {
				if (!metafile) { return }

				const rewriteTasks: Promise<void>[] = [];
				const chmodTasks: Promise<void>[] = [];
				for (const [ outputPath, { entryPoint } ] of Object.entries(metafile.outputs)) {
					if (extname(outputPath) !== FileExtension.JS) { continue }

					rewriteTasks.push(rewriteOutputSpecifiers(outputPath));

					if (entryPoint) { chmodTasks.push(setShebangPermissions(outputPath)) }
				}

				if (rewriteTasks.length > 0) { await Promise.all(rewriteTasks) }
				if (chmodTasks.length > 0) { await Promise.all(chmodTasks) }
			});
		}
	};
};