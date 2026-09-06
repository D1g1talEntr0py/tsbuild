import { describe, expect, it } from 'vitest';
import { buildFingerprint } from '../../src/project/build-fingerprint';
import { Paths } from '../../src/paths';
import type { ProjectBuildConfiguration } from '../../src/@types';

function configuration(overrides: Partial<ProjectBuildConfiguration> = {}): ProjectBuildConfiguration {
	return {
		entryPoints: Promise.resolve({ index: Paths.absolute('/project/src/index.ts') }),
		outDir: Paths.absolute('/project/dist'),
		target: 'ES2022',
		minify: false,
		force: false,
		bundle: true,
		splitting: true,
		platform: 'node',
		sourceMap: false,
		noExternal: [],
		dts: { resolve: false },
		watch: { enabled: false, recursive: true, persistent: true, ignoreInitial: true },
		...overrides
	};
}

describe('buildFingerprint', () => {
	it('preserves exact serialized bytes and field order', () => {
		const config = configuration({ iife: { globalName: 'Library' }, sourceMap: 'external', banner: { js: 'banner', css: 'style' }, footer: { js: 'footer' }, noExternal: [ 'package', /^@scope\//gi ], dts: { resolve: true, entryPoints: [ 'second', 'first' ] }, env: { SECOND: '2', FIRST: '1' } });
		expect(buildFingerprint(config, { declaration: true, emitDeclarationOnly: false })).toBe('{"minify":false,"iife":{"globalName":"Library"},"declaration":true,"emitDeclarationOnly":false,"bundle":true,"splitting":true,"format":"esm","target":"ES2022","platform":"node","sourceMap":"external","banner":{"js":"banner","css":"style"},"footer":{"js":"footer"},"noExternal":["package","/^@scope\\\\//gi"],"dtsResolve":true,"dtsEntryPoints":["second","first"],"env":{"SECOND":"2","FIRST":"1"}}');
	});

	it('omits undefined fields without changing the remaining order', () => {
		expect(buildFingerprint(configuration(), {})).toBe('{"minify":false,"bundle":true,"splitting":true,"format":"esm","target":"ES2022","platform":"node","sourceMap":false,"noExternal":[],"dtsResolve":false}');
	});

	const changes: Partial<ProjectBuildConfiguration>[] = [
		{ minify: true }, { iife: false }, { iife: { globalName: 'Library' } }, { bundle: false }, { splitting: false },
		{ target: 'ESNext' }, { platform: 'browser' }, { sourceMap: 'inline' }, { banner: { js: 'banner' } },
		{ footer: { css: 'footer' } }, { noExternal: [ /package/i ] }, { dts: { resolve: true } },
		{ dts: { resolve: false, entryPoints: [] } }, { env: { VALUE: 'changed' } }
	];

	it.each(changes)('changes when a fingerprinted build option changes: %j', (change) => {
		expect(buildFingerprint(configuration(change), {})).not.toBe(buildFingerprint(configuration(), {}));
	});

	it.each([ { declaration: true }, { declaration: false }, { emitDeclarationOnly: true }, { emitDeclarationOnly: false } ])('tracks compiler emission flags: %j', (compilerOptions) => {
		expect(buildFingerprint(configuration(), compilerOptions)).not.toBe(buildFingerprint(configuration(), {}));
	});

	it('ignores non-fingerprinted options and entry promise identity', () => {
		const config = configuration({ force: true, clean: false, packages: 'bundle', plugins: [], outDir: Paths.absolute('/elsewhere'), entryPoints: Promise.resolve({ other: Paths.absolute('/other.ts') }), watch: { enabled: true, recursive: false, persistent: false, ignoreInitial: false } });
		expect(buildFingerprint(config, { strict: true, noEmit: true })).toBe(buildFingerprint(configuration(), {}));
	});

	it('ignores resolved entry point contents', () => {
		const first = configuration({ entryPoints: Promise.resolve({ first: Paths.absolute('/first.ts') }) });
		const second = configuration({ entryPoints: Promise.resolve({ second: Paths.absolute('/second.ts') }) });
		expect(buildFingerprint(first, {})).toBe(buildFingerprint(second, {}));
	});

	it('serializes equivalent regexp instances equally and ignores lastIndex', () => {
		const pattern = /package/gi;
		pattern.lastIndex = 4;
		expect(buildFingerprint(configuration({ noExternal: [ pattern ] }), {})).toBe(buildFingerprint(configuration({ noExternal: [ new RegExp('package', 'ig') ] }), {}));
		expect(buildFingerprint(configuration({ noExternal: [ pattern ] }), {})).not.toBe(buildFingerprint(configuration({ noExternal: [ /package/g ] }), {}));
		expect(buildFingerprint(configuration({ noExternal: [ pattern ] }), {})).not.toBe(buildFingerprint(configuration({ noExternal: [ /other/gi ] }), {}));
	});

	it('retains array and nested object insertion order', () => {
		expect(buildFingerprint(configuration({ noExternal: [ 'first', 'second' ] }), {})).not.toBe(buildFingerprint(configuration({ noExternal: [ 'second', 'first' ] }), {}));
		expect(buildFingerprint(configuration({ dts: { resolve: false, entryPoints: [ 'first', 'second' ] } }), {})).not.toBe(buildFingerprint(configuration({ dts: { resolve: false, entryPoints: [ 'second', 'first' ] } }), {}));
		expect(buildFingerprint(configuration({ env: { FIRST: '1', SECOND: '2' } }), {})).not.toBe(buildFingerprint(configuration({ env: { SECOND: '2', FIRST: '1' } }), {}));
	});
});