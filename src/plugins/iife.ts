import { basename, dirname, join, relative, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { build as esbuild } from 'esbuild';
import type { BuildOptions, BuildResult, OutputFile, Plugin } from 'esbuild';
import type { IifeOptions, RelativePath, WrittenFile } from '../@types/index.js';

type WriteDisabledBuild = BuildOptions & { write: false };

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

				build.onEnd(async ({ outputFiles }: BuildResult<WriteDisabledBuild>): Promise<void> => {
					if (!outputFiles?.length || entryPointNames.length === 0) { return }

					const written = await buildIife(outputFiles, entryPointNames, outdir, globalName, sourcemap);
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

// Matches the export block: handles both formatted (`export {\n  Name\n}`) and
// minified (`export{e as Name}`) output. [^}]* matches newlines too.
const exportRe = /export\s*\{([^}]*)\};?/g;
const asRe = /^(\w+)\s+as\s+(\w+)$/;

/**
 * Wraps bundled ESM text in an IIFE and assigns exported names to globalThis.
 * Strips the trailing `export { ... }` block and replaces it with an Object.assign call.
 * Handles both formatted (`export { Name }`) and minified (`export{e as Name}`) output.
 * @param text The ESM module text to wrap
 * @param globalName Optional namespace — if set, assigns `globalThis.Name = { exports }`
 * @returns The wrapped IIFE text
 */
function wrapAsIife(text: string, globalName?: string): string {
	let last: RegExpExecArray | null = null;
	let match: RegExpExecArray | null;
	exportRe.lastIndex = 0;
	while ((match = exportRe.exec(text)) !== null) { last = match }
	if (!last) { return text }

	const props: string[] = [];
	for (const raw of last[1].split(',')) {
		const trimmed = raw.trim();
		if (!trimmed) { continue }
		const m = asRe.exec(trimmed);
		props.push(m ? `${m[2]}: ${m[1]}` : trimmed);
	}
	if (props.length === 0) { return text }

	const assignment = globalName
		? `globalThis.${globalName} = { ${props.join(', ')} };`
		: `Object.assign(globalThis, { ${props.join(', ')} });`;

	const body = text.slice(0, last.index);
	const after = text.slice(last.index + last[0].length);
	return `(() => {\n${body}\n\t${assignment}\n})();${after}`;
}

/**
 * Runs a secondary esbuild build to produce IIFE output from the primary ESM output.
 * Uses a virtual loader to serve pre-built ESM content from memory, avoiding TypeScript
 * re-transpilation. With splitting disabled, all dynamic imports are inlined into each
 * entry point for self-contained browser/CDN usage.
 * @param outputFiles The primary build's output files
 * @param entryPointNames The configured entry point output names
 * @param outdir The primary build's output directory
 * @param globalName Optional global variable name override; otherwise derived from each entry name
 * @param sourcemap The primary build's source map setting
 * @returns An array of written IIFE output files
 */
async function buildIife(outputFiles: OutputFile[], entryPointNames: string[], outdir: string, globalName: string | undefined, sourcemap: BuildOptions['sourcemap']): Promise<WrittenFile[]> {
	const fileContents = new Map<string, string>();
	for (const file of outputFiles) {
		if (file.path.endsWith(jsExtension)) {
			fileContents.set(file.path, textDecoder.decode(file.contents));
		}
	}

	const validEntries: Array<{ name: string; absPath: string }> = [];
	for (const name of entryPointNames) {
		const absPath = join(outdir, name + jsExtension);
		if (fileContents.has(absPath)) {
			validEntries.push({ name, absPath });
		}
	}

	if (validEntries.length === 0) { return [] }

	const hasSourceMap = sourcemap !== undefined && sourcemap !== false;
	const iifeOutdir = join(outdir, 'iife');
	const loaderPlugin = virtualLoaderPlugin(fileContents);

	await mkdir(iifeOutdir, { recursive: true });

	const results = await Promise.all(validEntries.map(({ name, absPath }) =>
		esbuild({
			entryPoints: { [name]: absPath },
			bundle: true,
			format: 'esm',
			splitting: false,
			outdir: iifeOutdir,
			sourcemap: hasSourceMap ? 'external' : false,
			write: false,
			logLevel: 'warning',
			plugins: [loaderPlugin],
		})
	));

	const written: WrittenFile[] = [];
	const writes: Promise<void>[] = [];
	for (const { outputFiles: iifeFiles } of results) {
		for (const file of iifeFiles) {
			if (file.path.endsWith(jsExtension)) {
				const text = wrapAsIife(textDecoder.decode(file.contents), globalName);
				writes.push(writeFile(file.path, text));
				written.push({ path: relative(process.cwd(), file.path) as RelativePath, size: Buffer.byteLength(text) });
			} else {
				writes.push(writeFile(file.path, file.contents));
				written.push({ path: relative(process.cwd(), file.path) as RelativePath, size: file.contents.byteLength });
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
		setup(build): void {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') {
					return { path: args.path, namespace: 'iife' };
				}
				if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
					return { external: true };
				}
				const resolved = resolve(args.resolveDir, args.path);
				if (fileContents.has(resolved)) {
					return { path: resolved, namespace: 'iife' };
				}
				return { external: true };
			});

			build.onLoad({ filter: /.*/, namespace: 'iife' }, (args) => {
				const contents = fileContents.get(args.path);
				if (contents !== undefined) {
					return { contents, loader: 'js', resolveDir: dirname(args.path) };
				}
				return null;
			});
		}
	};
}
