import { Paths } from 'src/paths.js';
import { FileExtension, format } from 'src/constants.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AbsolutePath, IifeOptions, WrittenFile } from '../@types/index.js';
import type { BuildOptions, BuildResult, OutputFile, Plugin } from 'esbuild';

/** Result of creating an IIFE plugin, providing both the esbuild plugin and collected output file info */
export interface IifePluginInstance {
	readonly plugin: Plugin;
	readonly files: WrittenFile[];
}

const namespace = 'iife';
const fileExtensionRegex = /\.[^.]+$/;
const textDecoder = new TextDecoder();

/**
 * esbuild plugin that produces additional IIFE output alongside the primary ESM build.
 * Runs a secondary esbuild build with `format: 'iife'` and `splitting: false`, using the
 * primary build's output files as input via a virtual loader. This inlines all dynamic imports
 * for self-contained browser/CDN usage. Output is written to an `iife` subdirectory.
 * @param options - IIFE plugin options
 */
export function iifePlugin(options?: IifeOptions): IifePluginInstance {
	const files: WrittenFile[] = [];

	return {
		files,
		plugin: {
			name: 'esbuild:iife',
			/**
			 * Configures the esbuild build instance to produce IIFE output.
			 * @param build The esbuild plugin build object.
			 */
			setup(build) {
				const outdir = build.initialOptions.outdir;
				if (!outdir) { return }

				// Force write:false so we can reuse primary build buffers in-memory for the IIFE
				// rebuild (avoiding a wasteful readFile of files esbuild just wrote) and overlap
				// writing primary outputs to disk with the secondary build.
				build.initialOptions.write = false;

				const sourcemap = build.initialOptions.sourcemap;
				const minify = build.initialOptions.minify;
				const entryPointNames = extractEntryNames(build.initialOptions.entryPoints);

				build.onEnd(async ({ outputFiles }: BuildResult) => {
					if (!outputFiles || outputFiles.length === 0 || entryPointNames.length === 0) { return }

					files.push(...(await buildIife(outputFiles, entryPointNames, outdir, options?.globalName, sourcemap, minify)));
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
function extractEntryNames(entryPoints: BuildOptions['entryPoints']) {
	if (!entryPoints) { return [] }

	if (Array.isArray(entryPoints)) {
		const names: string[] = [];
		for (const entry of entryPoints) {
			if (typeof entry === 'string') {
				names.push(basename(entry).replace(fileExtensionRegex, ''));
			} else {
				names.push(entry.out ?? basename(entry.in).replace(fileExtensionRegex, ''));
			}
		}

		return names;
	}

	return Object.keys(entryPoints);
}

/**
 * Wraps bundled ESM text in an IIFE and assigns exported names to globalThis.
 * Strips the trailing `export { ... }` block and replaces it with an Object.assign call.
 * Handles both formatted (`export { Name }`) and (`export{ Foo as Bar }`) syntax.
 * @param text The ESM module text to wrap
 * @param globalName Optional namespace — if set, assigns `globalThis.Name = { exports }`
 * @returns The wrapped IIFE text
 */
function wrapAsIife(text: string, globalName?: string) {
	const exportStart = text.lastIndexOf('export');

	if (exportStart === -1) { return text }

	const openBrace = text.indexOf('{', exportStart + 6);
	const closeBrace = text.indexOf('}', openBrace + 1);

	if (openBrace === -1 || closeBrace === -1 || text.slice(exportStart + 6, openBrace).trim() !== '') { return text }

	let exportEnd = closeBrace + 1;
	while (exportEnd < text.length && /[ \t]/.test(text[exportEnd] ?? '')) { exportEnd += 1 }

	if (text[exportEnd] === ';') { exportEnd += 1 }

	const properties: string[] = [];
	for (const rawMember of text.slice(openBrace + 1, closeBrace).split(',')) {
		const member = rawMember.trim();

		if (!member) { continue }

		const asIndex = member.indexOf(' as ');
		if (asIndex <= 0) {
			properties.push(member);
			continue;
		}

		const localName = member.slice(0, asIndex).trim();
		const exportName = member.slice(asIndex + 4).trim();
		properties.push(localName && exportName ? `${exportName}: ${localName}` : member);
	}

	if (properties.length === 0) { return text }

	const exportedObject = properties.join(', ');
	const assignment = globalName ? `globalThis.${globalName} = { ${exportedObject} };` : `Object.assign(globalThis, { ${exportedObject} });`;

	return `(() => {\n${text.slice(0, exportStart)}\n\t${assignment}\n})();${text.slice(exportEnd)}`;
}

/**
 * Runs a secondary esbuild build to produce IIFE output from the primary ESM output.
 * Uses a virtual loader to serve pre-built ESM content from memory, avoiding TypeScript
 * re-transpilation. With splitting disabled, all dynamic imports are inlined into each
 * entry point for self-contained browser/CDN usage.
 *
 * Primary outputs (forced write:false by this plugin) are written to disk in parallel
 * with the secondary IIFE build, so the secondary work overlaps the I/O of the primary.
 *
 * @param primaryOutputs The in-memory outputs from the primary build (write:false was forced in setup)
 * @param entryPointNames The configured entry point output names
 * @param outdir The primary build's output directory
 * @param globalName Optional global variable name override; otherwise derived from each entry name
 * @param sourcemap The primary build's source map setting
 * @param minify The primary build's minify setting
 * @returns An array of written IIFE output files
 */
async function buildIife(primaryOutputs: OutputFile[], entryPointNames: string[], outdir: string, globalName: string | undefined, sourcemap: BuildOptions['sourcemap'], minify: BuildOptions['minify']): Promise<WrittenFile[]> {
	const { build: esbuild } = await import('esbuild');
	const fileContents = new Map<string, string>();
	const primaryWrites: Promise<void>[] = [];
	const ensuredDirs = new Map<string, Promise<string | undefined>>();

	// Decode JS outputs once for the IIFE virtual loader; kick off primary disk writes in parallel.
	for (const file of primaryOutputs) {
		const absolute = resolve(file.path);
		if (absolute.endsWith(FileExtension.JS)) { fileContents.set(absolute, file.text) }

		const dir = dirname(absolute);
		let dirReady = ensuredDirs.get(dir);
		if (dirReady === undefined) {
			dirReady = mkdir(dir, { recursive: true });
			ensuredDirs.set(dir, dirReady);
		}
		primaryWrites.push(dirReady.then(() => writeFile(absolute, file.contents)));
	}

	const validEntries: Array<{ name: string; path: AbsolutePath }> = [];
	for (const name of entryPointNames) {
		const path = Paths.absolute(outdir, name + FileExtension.JS);
		if (fileContents.has(path)) {
			validEntries.push({ name, path });
		}
	}

	if (validEntries.length === 0) {
		await Promise.all(primaryWrites);
		return [];
	}

	const sourcemapValue = sourcemap !== undefined && sourcemap !== false ? 'external' : false;
	const plugins = [ virtualLoaderPlugin(fileContents) ];
	const iifeOutdir = join(outdir, namespace);

	await mkdir(iifeOutdir, { recursive: true });

	const results = await Promise.all(validEntries.map(({ name, path }) => {
		return esbuild({
			entryPoints: { [name]: path },
			bundle: true,
			format,
			splitting: false,
			outdir: iifeOutdir,
			sourcemap: sourcemapValue,
			minify,
			write: false,
			logLevel: 'warning',
			plugins
		});
	}));

	const written: WrittenFile[] = [];
	const writes: Promise<void>[] = [];
	const cwd = process.cwd();

	for (const { outputFiles } of results) {
		const outputFilePaths = new Set(outputFiles.map(({ path }) => path));

		for (const { path, contents } of outputFiles) {
			let text, size = contents.byteLength;
			if (path.endsWith(FileExtension.JS)) {
				text = wrapAsIife(textDecoder.decode(contents), globalName);

				// esbuild does not add //# sourceMappingURL= to outputFiles when write:false;
				// append it manually when the map file is present in the result.
				if (outputFilePaths.has(`${path}.map`)) {
					text += `\n//# sourceMappingURL=${basename(path)}.map`;
					size = Buffer.byteLength(text);
				}
			} else {
				text = contents;
			}

			writes.push(writeFile(path, text));
			written.push({ path: Paths.relative(cwd, path), size });
		}
	}

	// Wait for both the IIFE writes and the parallel primary writes before returning.
	await Promise.all([ ...writes, ...primaryWrites ]);

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

				return fileContents.has(resolved) ? { path: resolved, namespace } : { external: true };
			});

			build.onLoad({ filter: /.*/, namespace }, (args) => {
				const contents = fileContents.get(args.path);

				return contents === undefined ? null : { contents, loader: 'js', resolveDir: dirname(args.path) };
			});
		}
	};
}
