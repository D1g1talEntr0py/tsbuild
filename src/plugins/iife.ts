import { Paths } from 'src/paths.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AbsolutePath, IifeOptions, WrittenFile } from '../@types/index.js';
import type { BuildOptions, BuildResult, Plugin } from 'esbuild';

/** Result of creating an IIFE plugin, providing both the esbuild plugin and collected output file info */
export interface IifePluginInstance {
	readonly plugin: Plugin;
	readonly files: WrittenFile[];
}

const textDecoder = new TextDecoder();
const jsExtension = '.js';

/**
 * esbuild plugin that produces additional IIFE output alongside the primary ESM build.
 * Runs a secondary esbuild build with `format: 'iife'` and `splitting: false`, using the
 * primary build's output files as input via a virtual loader. This inlines all dynamic imports
 * for self-contained browser/CDN usage. Output is written to an `iife` subdirectory.
 * @param options IIFE plugin options
 * @returns An object containing the esbuild Plugin and a files array populated after the build
 */
export function iifePlugin(options?: IifeOptions): IifePluginInstance {
	const globalName = options?.globalName;
	const files: WrittenFile[] = [];

	return {
		files,
		plugin: {
			name: 'esbuild:iife',
			/**
			 * Configures the esbuild build instance to produce IIFE output
			 * @param build The esbuild build instance
			 */
			setup(build): void {
				const outdir = build.initialOptions.outdir;
				if (!outdir) { return }

				const sourcemap = build.initialOptions.sourcemap;
				const entryPointNames = extractEntryNames(build.initialOptions.entryPoints);

				build.onEnd(async ({ metafile }: BuildResult): Promise<void> => {
					if (!metafile || entryPointNames.length === 0) { return }

					const written = await buildIife(metafile.outputs, entryPointNames, outdir, globalName, sourcemap);
					files.push(...written);
				});
			}
		}
	};
}

/**
 * Extracts output names from esbuild's entryPoints configuration.
 * Handles both object form `{ name: path }` and array form `[path]` or `[{ in, out }]`.
 * @param entryPoints The esbuild entryPoints configuration
 * @returns An array of entry point output names
 */
function extractEntryNames(entryPoints: BuildOptions['entryPoints']): string[] {
	if (!entryPoints) { return [] }

	if (Array.isArray(entryPoints)) {
		const names: string[] = [];
		for (const entry of entryPoints) {
			if (typeof entry === 'string') {
				names.push(basename(entry).replace(/\.[^.]+$/, ''));
			} else {
				names.push(entry.out ?? basename(entry.in).replace(/\.[^.]+$/, ''));
			}
		}

		return names;
	}

	return Object.keys(entryPoints);
}

// Matches the export block: handles both formatted (`export {lName\n}`) and
// (`export {e as Name}`) output. [^}]* matches newlines too.
const exportRegex = /export\s*\{([^}]*)\};?/g;
const exportAliasRegex = /^(\w+)\s+as\s+(\w+)$/;
const namespace = 'iife';

/**
 * Wraps bundled ESM text in an IIFE and assigns exported names to globalThis.
 * Strips the trailing `export { ... }` block and replaces it with an Object.assign call.
 * Handles both formatted (`export { Name }`) and minified (`export{e as Name}`) output.
 * @param text The ESM module text to wrap
 * @param globalName Optional namespace — if set, assigns `globalThis.Name = { exports }`
 * @returns The wrapped IIFE text
 */
function wrapAsIife(text: string, globalName?: string): string {
	const exportIndex = text.lastIndexOf('export');
	if (exportIndex === -1) { return text }

	exportRegex.lastIndex = exportIndex;
	const last = exportRegex.exec(text);

	if (!last) { return text }

	const props: string[] = [];
	for (const raw of last[1].split(',')) {
		const trimmed = raw.trim();
		if (!trimmed) { continue }
		const m = exportAliasRegex.exec(trimmed);
		props.push(m ? `${m[2]}: ${m[1]}` : trimmed);
	}

	if (props.length === 0) { return text }

	const assignment = globalName	? `globalThis.${globalName} = { ${props.join(', ')} };` : `Object.assign(globalThis, { ${props.join(', ')} });`;
	const body = text.slice(0, last.index);
	const after = text.slice(last.index + last[0].length);

	return `(() => {\n${body}\n\t${assignment}\n})();${after}`;
}

/**
 * Runs a secondary esbuild build to produce IIFE output from the primary ESM output.
 * Uses a virtual loader to serve pre-built ESM content from memory, avoiding TypeScript
 * re-transpilation. With splitting disabled, all dynamic imports are inlined into each
 * entry point for self-contained browser/CDN usage.
 * @param outputs The metafile outputs from the primary build
 * @param entryPointNames The configured entry point output names
 * @param outdir The primary build's output directory
 * @param globalName Optional global variable name override; otherwise derived from each entry name
 * @param sourcemap The primary build's source map setting
 * @returns An array of written IIFE output files
 */
async function buildIife(outputs: Record<string, { entryPoint?: string }>, entryPointNames: string[], outdir: string, globalName: string | undefined, sourcemap: BuildOptions['sourcemap']): Promise<WrittenFile[]> {
	const { build: esbuild } = await import('esbuild');
	const fileContents = new Map<string, string>();
	for (const outputPath of Object.keys(outputs)) {
		if (outputPath.endsWith(jsExtension)) {
			fileContents.set(resolve(outputPath), await readFile(outputPath, 'utf8'));
		}
	}

	const validEntries: Array<{ name: string; path: AbsolutePath }> = [];
	for (const name of entryPointNames) {
		const path = Paths.absolute(outdir, name + jsExtension);
		if (fileContents.has(path)) {
			validEntries.push({ name, path });
		}
	}

	if (validEntries.length === 0) { return [] }

	const hasSourceMap = sourcemap !== undefined && sourcemap !== false;
	const plugins = [ virtualLoaderPlugin(fileContents) ];

	const iifeOutdir = await mkdir(join(outdir, namespace), { recursive: true });

	const results = await Promise.all(validEntries.map(({ name, path }) => {
		return esbuild({
			entryPoints: { [name]: path },
			bundle: true,
			format: 'esm',
			splitting: false,
			outdir: iifeOutdir,
			sourcemap: hasSourceMap ? 'external' : false,
			write: false,
			logLevel: 'warning',
			plugins
		});
	}));

	const written: WrittenFile[] = [];
	const writes: Promise<void>[] = [];
	const cwd = process.cwd();
	for (const { outputFiles: iifeFiles } of results) {
		for (const { path, contents } of iifeFiles) {
			if (path.endsWith(jsExtension)) {
				const text = wrapAsIife(textDecoder.decode(contents), globalName);
				writes.push(writeFile(path, text));
				written.push({ path: Paths.relative(cwd, path), size: Buffer.byteLength(text) });
			} else {
				writes.push(writeFile(path, contents));
				written.push({ path: Paths.relative(cwd, path), size: contents.byteLength });
			}
		}
	}
	await Promise.all(writes);

	return written;
}

/**
 * Creates a virtual loader plugin that serves pre-built ESM content from memory.
 * Resolves relative imports within the output files; bare specifiers are marked external.
 * @param fileContents Map of absolute file paths to their JavaScript content
 * @returns An esbuild Plugin for virtual file loading
 */
function virtualLoaderPlugin(fileContents: Map<string, string>): Plugin {
	return {
		name: 'iife:virtual-loader',
		/**
		 * Registers onResolve and onLoad hooks for virtual file loading
		 * @param build The esbuild build instance
		 */
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') {
					return { path: args.path, namespace };
				}

				if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
					return { external: true };
				}

				const resolved = resolve(args.resolveDir, args.path);
				if (fileContents.has(resolved)) {
					return { path: resolved, namespace };
				}

				return { external: true };
			});

			build.onLoad({ filter: /.*/, namespace }, (args) => {
				const contents = fileContents.get(args.path);

				return contents === undefined ? null : { contents, loader: 'js', resolveDir: dirname(args.path) };
			});
		}
	};
}
