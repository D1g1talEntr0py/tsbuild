#!/usr/bin/env node
import { sys } from 'typescript';
import { parseArgs } from 'node:util';
import { TypeScriptProject } from './type-script-project';
import { BuildError } from './errors';
import type { AbsolutePath, TypeScriptOptions } from './@types';

const options = {
	help: { type: 'boolean', default: undefined, short: 'h', description: 'Show this help message' },
	version: { type: 'boolean', default: undefined, short: 'v', description: 'Show version number' },
	force: { type: 'boolean', default: false, short: 'f', description: 'Force a full rebuild' },
	watch: { type: 'boolean', default: false, short: 'w', description: 'Watch for changes and rebuild' },
	project: { type: 'string', default: sys.getCurrentDirectory(), short: 'p', description: 'Project directory (defaults to current directory)' },
	noEmit: { type: 'boolean', default: undefined, short: 'n', description: 'Do not emit output files' },
	clearCache: { type: 'boolean', default: false, short: 'c', description: 'Clear the cache before the build' },
	minify: { type: 'boolean', default: undefined, short: 'm', description: 'Minify the output' }
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
	process.exit(0);
}

// Handle version option
if (version) {
	console.log(import.meta.env?.tsbuild_version ?? process.env.npm_package_version);
	process.exit(0);
}

const typeScriptOptions = {
	clearCache: args.clearCache,
	compilerOptions: { noEmit: args.noEmit },
	tsbuild: { force: args.force, minify: args.minify, watch: { enabled: args.watch } }
} satisfies TypeScriptOptions;

try {
	await new TypeScriptProject(args.project as AbsolutePath, typeScriptOptions).build();
} catch (error) {
	process.exitCode = error instanceof BuildError ? error.code : 1;
}