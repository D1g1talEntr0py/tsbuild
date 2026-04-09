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

/**
 * Runs a secondary esbuild build to produce IIFE output from the primary ESM output.
 * Uses a virtual loader to serve pre-built ESM content from memory, avoiding TypeScript
 * re-transpilation. With splitting disabled, all dynamic imports are inlined into each
 * entry point for self-contained browser/CDN usage.
 * @param outputFiles The primary build's output files
 * @param entryPointNames The configured entry point output names
 * @param outdir The primary build's output directory
 * @param globalName Optional global variable name for the IIFE bundle
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

	const entryPoints: Record<string, string> = {};
	for (const name of entryPointNames) {
		const absPath = join(outdir, name + jsExtension);
		if (fileContents.has(absPath)) {
			entryPoints[name] = absPath;
		}
	}

	if (Object.keys(entryPoints).length === 0) { return [] }

	const hasSourceMap = sourcemap !== undefined && sourcemap !== false;
	const iifeOutdir = join(outdir, 'iife');

	const { outputFiles: iifeFiles } = await esbuild({
		entryPoints,
		bundle: true,
		format: 'iife',
		globalName,
		splitting: false,
		outdir: iifeOutdir,
		sourcemap: hasSourceMap ? 'external' : false,
		write: false,
		logLevel: 'warning',
		footer: globalName ? { js: `globalThis.${globalName} = ${globalName};` } : undefined,
		plugins: [virtualLoaderPlugin(fileContents)],
	});

	// Only write entry point outputs + their source maps, skip inlined chunks
	const entryOutputs = new Set<string>();
	for (const name of entryPointNames) {
		entryOutputs.add(join(iifeOutdir, name + jsExtension));
	}

	await mkdir(iifeOutdir, { recursive: true });

	const written: WrittenFile[] = [];
	const writes: Promise<void>[] = [];
	for (const file of iifeFiles) {
		const basePath = file.path.endsWith('.map') ? file.path.slice(0, -4) : file.path;
		if (entryOutputs.has(basePath)) {
			writes.push(writeFile(file.path, file.contents));
			written.push({ path: relative(process.cwd(), file.path) as RelativePath, size: file.contents.byteLength });
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
