import { Json } from '../json';
import { format } from '../constants';
import type { CompilerOptions } from 'typescript';
import type { Pattern, ProjectBuildConfiguration } from '../@types';

const serializePattern = (pattern: Pattern): string => pattern instanceof RegExp ? `/${pattern.source}/${pattern.flags}` : pattern;

/**
 * Computes a deterministic fingerprint of the build configuration.
 * Fingerprint mismatch on the next build forces a full rebuild.
 * @param buildConfig - The resolved build configuration
 * @param compilerOptions - The resolved compiler options
 * @returns A deterministic JSON string representing the build configuration
 */
function buildFingerprint(buildConfig: ProjectBuildConfiguration, compilerOptions: CompilerOptions): string {
	return Json.serialize({
		minify: buildConfig.minify,
		iife: buildConfig.iife,
		declaration: compilerOptions.declaration,
		emitDeclarationOnly: compilerOptions.emitDeclarationOnly,
		bundle: buildConfig.bundle,
		splitting: buildConfig.splitting,
		format,
		target: buildConfig.target,
		platform: buildConfig.platform,
		sourceMap: buildConfig.sourceMap,
		banner: buildConfig.banner,
		footer: buildConfig.footer,
		noExternal: buildConfig.noExternal.map(serializePattern),
		dtsResolve: buildConfig.dts.resolve,
		dtsEntryPoints: buildConfig.dts.entryPoints,
		env: buildConfig.env
	});
}

export { buildFingerprint };