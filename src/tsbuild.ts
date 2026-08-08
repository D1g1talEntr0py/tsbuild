#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { BuildError } from './errors';
import type { TypeScriptOptions } from './@types';

const options = {
	help: { type: 'boolean', default: undefined, short: 'h', description: 'Show this help message' },
	version: { type: 'boolean', default: undefined, short: 'v', description: 'Show version number' },
	force: { type: 'boolean', default: false, short: 'f', description: 'Force a full rebuild' },
	watch: { type: 'boolean', default: false, short: 'w', description: 'Watch for changes and rebuild' },
	project: { type: 'string', default: process.cwd(), short: 'p', description: 'Project directory (defaults to current directory)' },
	noEmit: { type: 'boolean', default: undefined, short: 'n', description: 'Do not emit output files' },
	clearCache: { type: 'boolean', default: false, short: 'c', description: 'Clear the cache before the build' },
	minify: { type: 'boolean', default: false, short: 'm', description: 'Minify the output' }
} as const;

const { values: { help, version, ...args } } = parseArgs({ options });

// Handle help option
if (help) {
	console.log('\ntsbuild - TypeScript build tool\n');
	console.log('Usage: tsbuild [options]\n');
	console.log('Options:');

	for (const [ long, { short, description } ] of Object.entries(options)) {
		console.log(`  ${`-${short}, --${long}`.padEnd(20)} ${description}`);
	}

	console.log();
	process.exitCode = 0;
} else if (version) {
	// Handle version option
	console.log(import.meta.env?.tsbuild_version ?? process.env['npm_package_version']);
	process.exitCode = 0;
} else {
	const typeScriptOptions = {
		clearCache: args.clearCache,
		compilerOptions: { ...(args.noEmit !== undefined ? { noEmit: args.noEmit } : {}) },
		tsbuild: { force: args.force, watch: { enabled: args.watch }, minify: args.minify }
	} satisfies TypeScriptOptions;

	try {
		const { TypeScriptProject } = await import('./type-script-project');
		await new TypeScriptProject(args.project, typeScriptOptions).build();
	} catch (error) {
		if (error instanceof BuildError) {
			console.error(error.message);
			process.exitCode = error.code;
		} else if (error instanceof Error) {
			console.error(error);
			process.exitCode = 1;
		} else {
			console.error(error);
			process.exitCode = 1;
		}
	}
}