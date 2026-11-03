import { join, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { createScanner, isIdentifier, isPrivateIdentifier, isStringLiteral, isNumericLiteral, isTypeReferenceNode, isParameterDeclaration, isTypeParameterDeclaration, isClassDeclaration, isInterfaceDeclaration, isSourceFile, isModuleBlock, isVariableDeclaration, isVariableDeclarationList, isImportDeclaration, isExportDeclaration, NodeFlags, SyntaxKind, type Node } from 'typescript/ast';
import { SymbolFlags, type Checker, type Symbol, type API, type Program } from 'typescript/sync';

/** A named structural difference, with reference and emitted signatures for inspection. */
export interface StructuralDifference {
	entry: string;
	symbol: string;
	expected: string;
	actual: string;
}

/** Repeated declaration text or alternate declaration formats, not inferred from byte size. */
export interface DeclarationDuplication {
	kind: 'alternate-variant' | 'repeated-file' | 'repeated-declaration' | 'cross-file-copy';
	files: string[];
	declaration?: string;
	identical: boolean;
	references?: Array<{ file: string; specifiers: string[] }>;
}

/** Resolves re-export aliases before inspecting declarations. */
export function declarationSymbol(checker: Checker, symbol: Symbol): Symbol {
	return symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Canonical declaration tokens, ignoring comments and whitespace only. */
export function declarationTokens(text: string): string {
	const scanner = createScanner(true, undefined, text);
	const tokens: string[] = [];
	while (scanner.scan() !== SyntaxKind.EndOfFile) { tokens.push(scanner.getTokenText()) }
	return tokens.join(' ');
}

/** Compares declaration ASTs, following local type references and ignoring bundle-local renaming. */
export function structuralSignature(checker: Checker, symbol: Symbol, directory: string): string {
	const seen = new Map<number, number>();
	const parameters = new Map<number, number>();
	function declaration(current: Symbol): string {
		current = declarationSymbol(checker, current);
		const previous = seen.get(current.id);
		if (previous !== undefined) { return `ref:${previous}` }
		seen.set(current.id, seen.size);
		return current.declarations.map(handle => {
			const node = handle.resolve();
			if (node === undefined) { throw new Error(`Cannot resolve declaration of ${current.name}`) }
			const binding = isVariableDeclaration(node) && isVariableDeclarationList(node.parent)
				? `binding:${node.parent.flags & NodeFlags.BlockScoped}:` : '';
			return binding + visit(node, undefined, node);
		}).join('\n');
	}
	function visit(node: Node, parent: Node | undefined, root: Node): string {
		if (node.kind === SyntaxKind.ExportKeyword || node.kind === SyntaxKind.DeclareKeyword) { return '' }
		if (isTypeReferenceNode(node)) {
			const target = checker.getSymbolAtLocation(node.typeName);
			const resolved = target === undefined ? undefined : declarationSymbol(checker, target);
			const local = resolved?.declarations.some(handle => {
				const path = relative(directory, handle.path);
				return !path.startsWith('../') && path !== '..';
			});
			if (resolved && local) {
				return `TypeReference(${declaration(resolved)};${node.typeArguments?.map(argument => visit(argument, node, root)).join(',') ?? ''})`;
			}
		}
		if (isPrivateIdentifier(node)) { return '#private' }
		if (isIdentifier(node)) {
			const target = checker.getSymbolAtLocation(node);
			if (target?.flags && target.flags & SymbolFlags.TypeParameter) {
				if (!parameters.has(target.id)) { parameters.set(target.id, parameters.size) }
				return `type-parameter:${parameters.get(target.id)}`;
			}
			if (target && parent && (parent.kind === SyntaxKind.ComputedPropertyName || parent.kind === SyntaxKind.TypeQuery)) {
				const resolved = declarationSymbol(checker, target);
				if (resolved.declarations.some(handle => !relative(directory, handle.path).startsWith('../'))) { return declaration(resolved) }
			}
			if (parent === root || (parent && (isParameterDeclaration(parent) || isTypeParameterDeclaration(parent)) && parent.name === node)) { return '$name' }
			return node.text;
		}
		if (isStringLiteral(node) || isNumericLiteral(node)) { return `${SyntaxKind[node.kind]}:${JSON.stringify(node.text)}` }
		const children: string[] = [];
		if (isClassDeclaration(node) || isInterfaceDeclaration(node)) {
			const members = new Set<Node>(node.members);
			node.forEachChild(child => {
				if (!members.has(child)) { const value = visit(child, node, root); if (value !== '') { children.push(value) } }
			});
			// Group members by name before walking referenced types; keep overloads in their original order.
			const ordered = [...node.members].map(member => ({
				member, key: checker.getSymbolOfNode(member)?.name ?? SyntaxKind[member.kind],
			})).sort((left, right) => left.key.localeCompare(right.key));
			children.push(...ordered.map(({ member }) => visit(member, node, root)));
		} else {
			node.forEachChild(child => { const value = visit(child, node, root); if (value !== '') { children.push(value) } });
		}
		return `${SyntaxKind[node.kind]}(${children.join(',')})`;
	}
	return declaration(symbol);
}

/** Prints all declarations of a public symbol for concrete expected/actual diagnostics. */
export function declarationText(api: API, checker: Checker, symbol: Symbol): string {
	return declarationSymbol(checker, symbol).declarations.map(handle => {
		const node = handle.resolve();
		if (!node) { throw new Error(`Cannot resolve declaration of ${symbol.name}`) }
		return api.printer.printNode(isVariableDeclaration(node) && isVariableDeclarationList(node.parent) ? node.parent.parent : node);
	}).join('\n');
}

/** Detects repeated declarations without treating distinct overloads or interface merging as duplicates. */
export function declarationDuplications(api: API, program: Program, checker: Checker, directory: string, files: string[]): DeclarationDuplication[] {
	const findings: DeclarationDuplication[] = [];
	const signatures = new Map<string, string[]>();
	const contents = new Map<string, string>();
	const references = new Map<string, string[]>();
	const mergedMembers = new Map<number, Map<string, string[]>>();
	for (const file of files) {
		const text = declarationTokens(readFileSync(join(directory, file), 'utf8'));
		contents.set(file, text);
		const source = program.getSourceFile(join(directory, file));
		if (!source) { throw new Error(`Declaration file missing from validation program: ${file}`) }
		const specifiers: string[] = [];
		function visit(node: Node): void {
			if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
				specifiers.push(node.moduleSpecifier.text);
			}
			if (isSourceFile(node) || isModuleBlock(node) || isClassDeclaration(node) || isInterfaceDeclaration(node)) {
				const local = new Map<string, number>();
				const declarations = isSourceFile(node) || isModuleBlock(node) ? node.statements : node.members;
				for (const child of declarations) {
					if (child.kind === SyntaxKind.EmptyStatement) { continue }
					const signature = declarationTokens(api.printer.printNode(child));
					local.set(signature, (local.get(signature) ?? 0) + 1);
					if (isInterfaceDeclaration(node)) {
						const id = checker.getSymbolOfDeclaration(node).id;
						const members = mergedMembers.get(id) ?? new Map<string, string[]>();
						members.set(signature, [...members.get(signature) ?? [], file]);
						mergedMembers.set(id, members);
					}
					if (node.kind === SyntaxKind.SourceFile && !signature.startsWith('import ') && !signature.startsWith('export {') && !signature.startsWith('export *')) {
						const locations = signatures.get(signature) ?? [];
						locations.push(file);
						signatures.set(signature, locations);
					}
				}
				for (const [signature, count] of local) {
					if (count > 1 && !isInterfaceDeclaration(node)) { findings.push({ kind: 'repeated-declaration', files: [file], declaration: signature, identical: true }) }
				}
			}
			node.forEachChild(child => { visit(child) });
		}
		visit(source);
		references.set(file, specifiers);
	}
	for (const members of mergedMembers.values()) {
		for (const [signature, locations] of members) {
			if (locations.length > 1) {
				findings.push({ kind: 'repeated-declaration', files: [...new Set(locations)], declaration: signature, identical: true });
			}
		}
	}
	for (let index = 0; index < files.length; index++) {
		for (const right of files.slice(index + 1)) {
			const left = files[index];
			const alternate = left.replace(/\.d\.(?:ts|mts|cts)$/, '') === right.replace(/\.d\.(?:ts|mts|cts)$/, '');
			const identical = contents.get(left) === contents.get(right);
			if (alternate || identical) {
				findings.push({
					kind: alternate ? 'alternate-variant' : 'repeated-file', files: [left, right], identical,
					...(alternate && !identical ? { references: [left, right].map(file => ({ file, specifiers: references.get(file) ?? [] })) } : {}),
				});
			}
		}
	}
	for (const [signature, locations] of signatures) {
		const distinct = [...new Set(locations)];
		if (distinct.length > 1 && new Set(distinct.map(file => file.replace(/\.d\.(?:ts|mts|cts)$/, ''))).size > 1) {
			findings.push({ kind: 'cross-file-copy', files: distinct, declaration: signature, identical: true });
		}
	}
	return findings;
}
