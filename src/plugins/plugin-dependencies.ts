import { createSourceFile, forEachChild, isExportDeclaration, isImportDeclaration, isStringLiteral, resolveModuleName, ScriptTarget, sys } from 'typescript';
import { nodeModulesPathPattern } from '../constants';
import type { CompilerOptions, Node } from 'typescript';
import type { AbsolutePath } from '../@types';

const parseableSourceExtensionPattern = /\.[jt]sx?$/;

/**
 * Collects static import and re-export specifiers from a source tree.
 * @param node Current syntax node
 * @param specifiers Destination for discovered specifiers
 */
function collectModuleSpecifiers(node: Node, specifiers: string[]): void {
	if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier !== undefined && isStringLiteral(node.moduleSpecifier)) {
		specifiers.push(node.moduleSpecifier.text);
	}

	forEachChild(node, (child) => collectModuleSpecifiers(child, specifiers));
}

/**
 * Discovers local static imports as a compatibility fallback for tsnode releases
 * where `onImport` was coupled to watch-mode IPC.
 * @param entryFile Plugin entry file
 * @param compilerOptions Project compiler options used to resolve path aliases
 */
export function discoverLocalDependencies(entryFile: AbsolutePath, compilerOptions: CompilerOptions): Set<AbsolutePath> {
	const dependencies = new Set<AbsolutePath>();
	const pending = [ entryFile ];

	for (const file of pending) {
		if (dependencies.has(file) || !sys.fileExists(file)) { continue }

		const source = sys.readFile(file);
		if (source === undefined) { continue }

		dependencies.add(file);
		if (!parseableSourceExtensionPattern.test(file)) { continue }

		const specifiers: string[] = [];
		collectModuleSpecifiers(createSourceFile(file, source, ScriptTarget.Latest, true), specifiers);

		for (const specifier of specifiers) {
			const resolved = resolveModuleName(specifier, file, compilerOptions, sys).resolvedModule?.resolvedFileName as AbsolutePath | undefined;
			if (resolved !== undefined && !nodeModulesPathPattern.test(resolved) && !dependencies.has(resolved)) { pending.push(resolved) }
		}
	}

	return dependencies;
}