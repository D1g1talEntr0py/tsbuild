import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fs, vol } from 'memfs';
import { formatDiagnostics } from 'typescript/sync';
import { ScriptTarget } from 'typescript/ast';
import { defaultCommandLineOptions, resolveConfiguration } from '../../src/project/configuration';
import { diagnosticsHost } from '../../src/project/diagnostics';
import { compilerOptionOverrides, defaultEntryFile, defaultSourceDirectory } from '../../src/constants';
import { ConfigurationError } from '../../src/errors';
import { IncrementalBuildCache } from '../../src/incremental-build-cache';
import { Logger } from '../../src/logger';
import { Paths } from '../../src/paths';
import { TestHelper } from '../scripts/test-helper';
import type { RelativePath } from '../../src/@types';

vi.mock('node:fs', async () => (await import('memfs')).fs);
vi.mock('node:fs/promises', async () => (await import('memfs')).fs.promises);

const projectDirectory = Paths.absolute('/project');
const configFilePath = Paths.join(projectDirectory, 'tsconfig.json');

function writeConfig(config: Record<string, unknown> = {}): void {
	vol.writeFileSync(configFilePath, JSON.stringify({ files: [ 'src/index.ts' ], ...config }));
}

beforeEach(() => {
	vol.fromJSON({ '/project/src/index.ts': 'export const value = 1;' });
	vi.spyOn(fs, 'readFileSync');
	writeConfig();
});

afterEach(() => {
	vi.restoreAllMocks();
	vol.reset();
});

describe('resolveConfiguration', () => {
	it('preserves default options, absolute parser paths, and synchronous cache construction', async () => {
		const config = resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions);
		expect(defaultCommandLineOptions).toEqual({ clearCache: false, force: false, watch: false, minify: false });
		expect(config).toMatchObject({ directory: projectDirectory, configFilePath, clean: true, rootNames: [ '/project/src/index.ts' ], configFileParsingDiagnostics: [] });
		expect(config.tsbuild).toMatchObject({ bundle: true, splitting: true, minify: false, force: false, sourceMap: false, outputStyle: 'summary', noExternal: [], packages: 'external', platform: 'node', dts: { resolve: false }, entryPoints: { index: defaultEntryFile }, watch: { enabled: false, recursive: true, emitInitial: false, persistent: true, renameTimeout: 150 } });
		expect(config.compilerOptions).toMatchObject({ ...compilerOptionOverrides, outDir: '/project/dist', rootDir: '/project/src', noEmit: false, sourceMap: false, incremental: true, lib: [], types: [ 'node' ] });
		expect(config.buildCache).toBeInstanceOf(IncrementalBuildCache);
		await config.buildCache?.restore(new Map());
	});

	it('merges defaults, JSON, and API options in order while retaining compiler overrides', () => {
		writeConfig({ compilerOptions: { incremental: false, outDir: './json-dist', sourceMap: true, types: [ 'json', 'shared' ] }, tsbuild: { clean: false, outputStyle: 'pipeline', sourceMap: 'inline', dts: { entryPoints: [ 'index' ], resolve: true }, banner: { js: 'json', css: 'json' }, noExternal: [ 'json' ] } });
		const config = resolveConfiguration(TestHelper.api, projectDirectory, {
			compilerOptions: { outDir: './api-dist', sourceMap: false, types: [ 'shared', 'api' ], allowJs: true, skipLibCheck: false, target: ScriptTarget.ES2015 },
			tsbuild: { clean: true, outputStyle: 'detailed', sourceMap: 'external', dts: { resolve: false }, banner: { js: 'api' }, noExternal: [ /api/ ] }
		}, { clearCache: true, force: true, watch: true, minify: true });
		expect(config.clean).toBe(true);
		expect(config.compilerOptions).toMatchObject({ ...compilerOptionOverrides, outDir: '/project/api-dist', sourceMap: false, types: [ 'node', 'json', 'shared', 'api' ] });
		expect(config.tsbuild).toMatchObject({ force: true, minify: true, outputStyle: 'detailed', sourceMap: 'external', dts: { entryPoints: [ 'index' ], resolve: false }, noExternal: [ /api/ ], watch: { enabled: true } });
		expect(config.tsbuild.banner).toEqual({ js: 'api' });
		expect(config.tsbuild.packages).toBeUndefined();
		expect(config.buildCache).toBeUndefined();
	});

	it.each([ 'dashboard', 'pipeline', 'artifacts', 'summary', 'detailed' ])('applies CLI output style %s over API and JSON configuration', (outputStyle) => {
		writeConfig({ tsbuild: { outputStyle: 'pipeline' } });
		const config = resolveConfiguration(TestHelper.api, projectDirectory, { tsbuild: { outputStyle: 'detailed' } }, { ...defaultCommandLineOptions, outputStyle });

		expect(config.tsbuild.outputStyle).toBe(outputStyle);
	});

	it('rejects an invalid CLI output style', () => {
		expect(() => resolveConfiguration(TestHelper.api, projectDirectory, {}, { ...defaultCommandLineOptions, outputStyle: 'invalid' })).toThrow(/Invalid value for "--outputStyle"/);
	});

	it.each([
		{ lib: [ 'DOM' ], platform: undefined, expectedPlatform: 'browser', packages: 'bundle', resolve: true, types: [] },
		{ lib: [ 'esnext' ], platform: undefined, expectedPlatform: 'node', packages: 'external', resolve: false, types: [ 'node' ] },
		{ lib: [ 'dom' ], platform: 'neutral' as const, expectedPlatform: 'neutral', packages: 'external', resolve: true, types: [] },
		{ lib: [ 'dom' ], platform: 'node' as const, expectedPlatform: 'node', packages: 'external', resolve: false, types: [ 'node' ] }
	])('resolves platform defaults for $expectedPlatform with $lib', ({ lib, platform, expectedPlatform, packages, resolve, types }) => {
		writeConfig({ compilerOptions: { lib, incremental: false } });
		const config = resolveConfiguration(TestHelper.api, projectDirectory, platform === undefined ? {} : { tsbuild: { platform } }, defaultCommandLineOptions);
		expect(config.tsbuild).toMatchObject({ platform: expectedPlatform, packages, dts: { resolve } });
		expect(config.compilerOptions.types).toEqual(types);
	});

	it('preserves explicit undefined API values in the final shallow merge', () => {
		writeConfig({ compilerOptions: { lib: [ 'dom' ], incremental: false } });
		const config = resolveConfiguration(TestHelper.api, projectDirectory, { tsbuild: { platform: undefined } }, defaultCommandLineOptions);
		expect(config.tsbuild).toMatchObject({ platform: undefined, packages: 'bundle', dts: { resolve: true } });
	});

	it('uses inherited libraries in preliminary platform detection', () => {
		vol.writeFileSync('/project/base.json', JSON.stringify({ compilerOptions: { lib: [ 'dom', 'esnext' ] } }));
		writeConfig({ extends: './base.json', compilerOptions: { incremental: false } });
		const config = resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions);
		expect(config.tsbuild.platform).toBe('browser');
		expect(config.compilerOptions.lib).toEqual([ 'lib.dom.d.ts', 'lib.esnext.d.ts' ]);
	});

	it('preserves non-bundled defaults and skips package inference', () => {
		writeConfig({ compilerOptions: { incremental: false }, tsbuild: { bundle: false } });
		vol.writeFileSync('/project/package.json', '{');
		const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
		const config = resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions);
		expect(config.tsbuild).toMatchObject({ bundle: false, splitting: false, entryPoints: { src: defaultSourceDirectory }, dts: { entryPoints: [] } });
		expect(warn).not.toHaveBeenCalled();
		expect(fs.readFileSync).not.toHaveBeenCalledWith('/project/package.json', expect.anything());
	});

	it('infers package entry points using the API output directory', () => {
		writeConfig({ compilerOptions: { incremental: false } });
		vol.writeFileSync('/project/package.json', JSON.stringify({ exports: { '.': './output/index.js', './cli': './output/cli.js' } }));
		const config = resolveConfiguration(TestHelper.api, projectDirectory, { compilerOptions: { outDir: './output' } }, defaultCommandLineOptions);
		expect(config.tsbuild.entryPoints).toEqual({ index: './src/index.ts', cli: './src/cli.ts' });
	});

	it.each([ false, true ])('normalizes explicit entry points and skips inference (API: %s)', (useApi) => {
		const entryPoints = [ './src/index.ts' as RelativePath ];
		writeConfig({ compilerOptions: { incremental: false }, ...(useApi ? {} : { tsbuild: { entryPoints } }) });
		const config = resolveConfiguration(TestHelper.api, projectDirectory, useApi ? { tsbuild: { entryPoints } } : {}, defaultCommandLineOptions);
		expect(config.tsbuild.entryPoints).toEqual({ index: './src/index.ts' });
		expect(fs.readFileSync).not.toHaveBeenCalledWith('/project/package.json', expect.anything());
	});

	it.each([
		[ '{', 'Could not parse package.json at "/project/package.json" while inferring entry points. Configure explicit entryPoints in your tsconfig.json tsbuild configuration.' ],
		[ '{"main":"./elsewhere/index.js"}', 'Could not infer entry points from package.json exports (output paths do not match outDir "dist"). Add explicit entryPoints to your tsconfig.json tsbuild configuration.' ]
	])('preserves inference warning text for %s', (packageJson, message) => {
		writeConfig({ compilerOptions: { incremental: false } });
		vol.writeFileSync('/project/package.json', packageJson);
		const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
		expect(resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions).tsbuild.entryPoints).toEqual({ index: defaultEntryFile });
		expect(warn).toHaveBeenCalledExactlyOnceWith(message);
	});

	it.each([ 'clearCache', 'force', 'minify', 'watch' ])('rejects JSON CLI-only %s before applying API overrides or constructing a cache', (option) => {
		writeConfig({ tsbuild: { [option]: false, unknown: true } });
		expect(() => resolveConfiguration(TestHelper.api, projectDirectory, { tsbuild: {} }, defaultCommandLineOptions)).toThrow(new ConfigurationError(`Configuration option "tsbuild.${option}" is CLI-only; use the "--${option}" command-line option.`));
	});

	it.each([
		{ tsbuild: { typo: true }, path: 'tsbuild.typo', keys: 'entryPoints, platform, bundle, clean, outputStyle, packages, external, noExternal, dts, env, sourceMap, splitting, banner, footer, plugins, iife' },
		{ tsbuild: { dts: { typo: true } }, path: 'tsbuild.dts.typo', keys: 'entryPoints, resolve' },
		{ tsbuild: { banner: { typo: true } }, path: 'tsbuild.banner.typo', keys: 'js, css' },
		{ tsbuild: { footer: { typo: true } }, path: 'tsbuild.footer.typo', keys: 'js, css' },
		{ tsbuild: { iife: { typo: true } }, path: 'tsbuild.iife.typo', keys: 'globalName' }
	])('preserves unknown-key errors at $path', ({ tsbuild, path, keys }) => {
		writeConfig({ tsbuild });
		expect(() => resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions)).toThrow(new ConfigurationError(`Unknown configuration key "${path}". Valid keys: ${keys}`));
	});

	it.each([ 'invalid', 42, null ])('rejects invalid outputStyle %s', (outputStyle) => {
		writeConfig({ tsbuild: { outputStyle } });
		expect(() => resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions)).toThrow(/Invalid value for "tsbuild\.outputStyle"/);
	});

	it.each([ null, false, 0 ])('does not add object-shape validation for tsbuild=%s', (tsbuild) => {
		writeConfig({ compilerOptions: { incremental: false }, tsbuild });
		expect(resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions).tsbuild.bundle).toBe(true);
	});

	it.each([ true, false ])('preserves plain configuration diagnostics for missing=%s', (missing) => {
		if (missing) { vol.unlinkSync(configFilePath) } else { vol.writeFileSync(configFilePath, '{') }
		const { error } = TestHelper.api.readConfigFile(configFilePath);
		expect(error).toBeDefined();
		expect(() => resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions)).toThrow(new ConfigurationError(formatDiagnostics(error === undefined ? [] : [ error ], diagnosticsHost)));
	});

	it('finds an ancestor config while retaining the requested project directory', () => {
		writeConfig({ compilerOptions: { incremental: false } });
		const directory = Paths.join(projectDirectory, 'nested');
		vol.mkdirSync(directory);
		const config = resolveConfiguration(TestHelper.api, directory, {}, defaultCommandLineOptions);
		expect(config.configFilePath).toBe(configFilePath);
		expect(config.directory).toBe(directory);
		expect(config.rootNames).toEqual([ '/project/nested/src/index.ts' ]);
	});

	describe('implicit rootDir', () => {
		it.each([
			{ files: [ 'src/index.ts', 'src/feature/a.ts', 'src/feature/deep/b.ts' ], expected: '/project/src' },
			{ files: [ 'src/index.ts', 'lib/util.ts' ], expected: '/project' },
			{ files: [ 'src/feature/a.ts', 'types/global.d.ts', 'types/env.d.mts', 'types/styles.d.css.ts' ], expected: '/project/src/feature' },
			{ files: [ 'src/index.ts', '../outside.ts' ], expected: '/' }
		])('uses the common directory of source roots for $files', ({ files, expected }) => {
			vol.fromJSON(Object.fromEntries(files.map((file) => [ Paths.join(projectDirectory, file), 'export {};' ])));
			writeConfig({ files, compilerOptions: { incremental: false } });
			expect(resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions).compilerOptions.rootDir).toBe(expected);
		});

		it('keeps an explicit rootDir', () => {
			writeConfig({ compilerOptions: { incremental: false, rootDir: '.' } });
			expect(resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions).compilerOptions.rootDir).toBe('/project');
		});

		it('is not derived when there are no source roots', () => {
			writeConfig({ files: [ 'types/global.d.ts' ], compilerOptions: { incremental: false } });
			vol.fromJSON({ '/project/types/global.d.ts': 'declare const value: number;' });
			expect(resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions).compilerOptions.rootDir).toBeUndefined();
		});
	});

	it('returns parser errors instead of throwing them during resolution', () => {
		writeConfig({ files: [], compilerOptions: { incremental: false, module: 'invalid' } });
		const config = resolveConfiguration(TestHelper.api, projectDirectory, {}, defaultCommandLineOptions);
		expect(config.configFileParsingDiagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining([ 6046, 18002 ]));
		expect(config.rootNames).toEqual([]);
	});
});