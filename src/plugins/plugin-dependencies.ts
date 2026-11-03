import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from 'typescript/ast';
import { nodeModulesPathPattern } from '../constants';
import type { Node } from 'typescript/ast';
import type { API, CompilerOptions } from 'typescript/sync';
import type { AbsolutePath } from '../@types';

const parseableSourceExtensionPattern = /\.[jt]sx?$/;

/**
 * Collects static import and re-export specifiers from a source tree.
 * @param node Current syntax node
 * @param specifiers Destination for discovered specifiers
 */
function collectModuleSpecifiers(node: Node, specifiers: string[]) {
	if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier !== undefined && isStringLiteral(node.moduleSpecifier)) {
		specifiers.push(node.moduleSpecifier.text);
	}

	node.forEachChild((child) => collectModuleSpecifiers(child, specifiers));
}

/**
 * Reads a UTF-8 file, returning undefined when it does not exist or cannot be read.
 * @param file Absolute file path
 */
function readSource(file: AbsolutePath): string | undefined {
	try { return readFileSync(file, 'utf8') } catch { return undefined }
}

/**
 * Discovers local static imports as a compatibility fallback for tsnode releases
 * where `onImport` was coupled to watch-mode IPC.
 * @param api TypeScript API session used to parse sources and resolve specifiers
 * @param entryFile Plugin entry file
 * @param compilerOptions Project compiler options used to resolve path aliases
 */
export function discoverLocalDependencies(api: API, entryFile: AbsolutePath, compilerOptions: CompilerOptions): Set<AbsolutePath> {
	const dependencies = new Set<AbsolutePath>();
	const pending = [ entryFile ];
	using resolver = api.createModuleResolver(compilerOptions);

	for (const file of pending) {
		if (dependencies.has(file)) { continue }

		const source = readSource(file);
		if (source === undefined) { continue }

		dependencies.add(file);
		if (!parseableSourceExtensionPattern.test(file)) { continue }

		const specifiers: string[] = [];
		{
			using retained = api.createSourceFile(file, source);
			collectModuleSpecifiers(retained.sourceFile, specifiers);
		}

		const containingDirectory = dirname(file);
		const resolutions = api.batch(...specifiers.map((specifier) => resolver.resolveModuleName.gen(specifier, containingDirectory)));
		for (const { resolvedModule } of resolutions) {
			const resolved = resolvedModule?.resolvedFileName as AbsolutePath | undefined;
			if (resolved !== undefined && !nodeModulesPathPattern.test(resolved) && !dependencies.has(resolved)) { pending.push(resolved) }
		}
	}

	return dependencies;
}
