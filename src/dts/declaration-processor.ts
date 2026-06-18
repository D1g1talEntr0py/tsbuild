import ts, {
	canHaveModifiers,
	forEachChild,
	isClassDeclaration,
	isEmptyStatement,
	isEnumDeclaration,
	isExportDeclaration,
	isExportSpecifier,
	isFunctionDeclaration,
	isIdentifier,
	isImportDeclaration,
	isImportTypeNode,
	isInterfaceDeclaration,
	isLiteralTypeNode,
	isModuleBlock,
	isModuleDeclaration,
	isNamedExports,
	isNamespaceExport,
	isStringLiteral,
	isTypeAliasDeclaration,
	isVariableStatement,
	ModifierFlags,
	NodeFlags,
	SyntaxKind,
	getCombinedModifierFlags,
	type Node,
	type ModuleDeclaration,
	type FileReference,
	type SourceFile,
	type Declaration,
} from 'typescript';
import MagicString from 'magic-string';
import { UnsupportedSyntaxError } from 'src/errors';
import { FileExtension, newLine, typeMatcher } from 'src/constants';
import type { NameRange, PreProcessOutput } from './@types';

const commaCharacter = 44;

/**
 * Processes TypeScript declaration files before and after bundling.
 *
 * Pre-processing prepares individual declaration files for bundling by:
 * - Removing export/default modifiers and adding declare modifiers
 * - Splitting compound variable statements
 * - Removing triple-slash directives
 * - Creating synthetic names for default exports
 * - Resolving inline import() statements
 * - Consolidating export statements
 *
 * Post-processing cleans up bundled declaration files by:
 * - Fixing import/export paths: `.d.ts` → `.js` for multi-chunk builds
 * - Removing empty statements (spurious semicolons)
 * - Removing redundant exports like `{ Foo as Foo }` within namespaces
 */
export class DeclarationProcessor {
	private constructor() {}

	/**
	 * Pre-processes a declaration file before bundling.
	 *
	 * The pre-process step has the following goals:
	 * - Fixes the "modifiers", removing any `export` modifier and adding any missing `declare` modifier
	 * - Splits compound `VariableStatement` into its parts
	 * - Moves declarations for the same "name" to be next to each other
	 * - Removes any triple-slash directives and records them
	 * - Creates a synthetic name for any nameless "export default"
	 * - Resolves inline `import()` statements and generates top-level imports for them
	 * - Generates a separate `export {}` statement for any item which had its modifiers rewritten
	 * - Duplicates the identifiers of a namespace `export`, so that renaming does not break it
	 *
	 * @param sourceFile The source file to process
	 * @returns The pre-processed output, which includes the modified code, type references, and file references
	 */
	static preProcess(sourceFile: SourceFile): PreProcessOutput {
		const code = new MagicString(sourceFile.getFullText());
		// All the names that are declared in the `SourceFile`
		const declaredNames = new Set<string>();
		// All the names that are exported
		const exportedNames = new Set<string>();
		// The name of the default export
		let defaultExport = '';
		// Inlined exports from `fileId` -> <synthetic name>
		const inlineImports = new Map<string, string>();
		// The ranges that each name covers, for re-ordering
		const nameRanges = new Map<string, NameRange[]>();

		/**
		 * Checks if there is a newline at the given position.
		 * @param node The node to check.
		 * @param pos The position to check.
		 * @returns True if there is a newline at the given position, false otherwise.
		 */
		function newlineAt(node: Node, pos: number) {
			return node.getSourceFile().getFullText()[pos] === newLine;
		}

		/**
		 * Gets the start position of a node.
		 * @param node The node to get the start position for.
		 * @returns The start position of the node.
		 */
		function getStart(node: Node) {
			const start = node.getFullStart();
			return start + (newlineAt(node, start) ? 1 : 0);
		}

		/**
		 * Gets the end position of a node.
		 * @param node The node to get the end position for.
		 * @returns The end position of the node.
		 */
		function getEnd(node: Node) {
			const end = node.getEnd();
			return end + (newlineAt(node, end) ? 1 : 0);
		}

		/**
		 * Parses the reference directives from the source file and returns a Set of file names.
		 * @param fileReferences The file references to parse.
		 * @returns A Set of file names.
		 */
		function parseReferenceDirectives(fileReferences: readonly FileReference[]) {
			const referenceDirectives = new Set<string>();
			const lineStarts = sourceFile.getLineStarts();

			for (const { fileName, pos } of fileReferences) {
				referenceDirectives.add(fileName);

				let end = sourceFile.getLineEndOfPosition(pos);
				if (code.slice(end, end + 1) === newLine) { end += 1 }

				code.remove(lineStarts[sourceFile.getLineAndCharacterOfPosition(pos).line], end);
			}

			return referenceDirectives;
		}

		/**
		 * Creates a NameRange for the given node.
		 * @param node The node to create the NameRange for.
		 * @returns The created NameRange.
		 */
		function createNameRange(node: ts.Statement): NameRange {
			return [ getStart(node), getEnd(node) ] as NameRange;
		}

		/**
		 * Recursively checks the node for inline imports and replaces them with namespace imports.
		 * @param node The node to check.
		 */
		function checkInlineImport(node: Node) {
			forEachChild(node, checkInlineImport);

			if (isImportTypeNode(node)) {
				if (!isLiteralTypeNode(node.argument) || !isStringLiteral(node.argument.literal)) {
					throw new UnsupportedSyntaxError(node, 'inline imports should have a literal argument');
				}

				const children = node.getChildren();
				const token = children.find(({ kind }) => kind === SyntaxKind.DotToken || kind === SyntaxKind.LessThanToken);

				code.overwrite(children.find(({ kind }) => kind === SyntaxKind.ImportKeyword)!.getStart(), token === undefined ? node.getEnd() : token.getStart(), createNamespaceImport(node.argument.literal.text));
			}
		}

		/**
		 * Creates a namespace import for the given file ID.
		 * @param fileId The file ID to create a namespace import for.
		 * @returns The name of the created namespace import.
		 */
		function createNamespaceImport(fileId: string) {
			let importName = inlineImports.get(fileId);

			if (importName === undefined) {
				// Replace non-identifier characters with underscores (faster than regex)
				const chars: string[] = [];
				for (let i = 0; i < fileId.length; i++) {
					const char = fileId[i];
					const code = char.charCodeAt(0);
					// a-z: 97-122, A-Z: 65-90, 0-9: 48-57, _: 95, $: 36
					chars.push((code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95 || code === 36 ? char : '_');
				}
				importName = generateUniqueName(chars.join(''));
				inlineImports.set(fileId, importName);
			}

			return importName;
		}

		/**
		 * Generates a unique name based on the given hint.
		 * @param hint The hint to base the unique name on.
		 * @returns The generated unique name.
		 */
		function generateUniqueName(hint: string) {
			while (declaredNames.has(hint)) { hint = `_${hint}` }

			declaredNames.add(hint);

			return hint;
		}

		/**
		 * Pushes a named node into the name ranges map.
		 * @param name The name of the node.
		 * @param range The range of the node.
		 */
		function pushNamedNode(name: string, range: NameRange) {
			const nodes = nameRanges.get(name);

			if (nodes === undefined) {
				nameRanges.set(name, [ range ]);
			} else {
				const last = nodes[nodes.length - 1];
				if (last[1] === range[0]) {
					last[1] = range[1];
				} else {
					nodes.push(range);
				}
			}
		}

		/**
		 * Fixes the modifiers of a node.
		 * @param node The node to fix.
		 */
		function fixModifiers(node: Node) {
			// remove the `export` and `default` modifier, add a `declare` if its missing.
			if (!canHaveModifiers(node)) { return }

			let hasDeclare = false;

			for (const modifier of node.modifiers ?? []) {
				if (modifier.kind === SyntaxKind.DefaultKeyword || modifier.kind === SyntaxKind.ExportKeyword) {
					code.remove(modifier.getStart(), modifier.getEnd() + getTrailingWhitespaceLength(modifier.getEnd(), node.getEnd()));
				} else if (modifier.kind === SyntaxKind.DeclareKeyword) {
					hasDeclare = true;
				}
			}

			const needsDeclare = isEnumDeclaration(node) || isClassDeclaration(node) || isFunctionDeclaration(node) || isModuleDeclaration(node) || isVariableStatement(node);

			if (needsDeclare && !hasDeclare) {
				code.appendRight(node.getStart(), 'declare ');
			}
		}

		/**
		 * Duplicates the exports of a namespace module declaration.
		 * @param module The module declaration to process.
		 */
		function duplicateExports(module: ModuleDeclaration) {
			if (!module.body || !isModuleBlock(module.body)) { return }

			for (const node of module.body.statements) {
				if (isExportDeclaration(node) && node.exportClause && !isNamespaceExport(node.exportClause)) {
					for (const { name, propertyName } of node.exportClause.elements) {
						if (propertyName === undefined) {
							code.appendLeft(name.getEnd(), ` as ${name.getText()}`);
						}
					}
				}
			}
		}

		/**
		 * Gets the length of the whitespace starting at the given position.
		 * @param start The start position to check for whitespace.
		 * @param end The maximum end position.
		 * @returns The length of the whitespace.
		 */
		function getTrailingWhitespaceLength(start: number, end: number) {
			let length = 0;
			while (start + length < end) {
				const char = code.original[start + length];
				if (char === ' ' || char === '\t' || char === newLine || char === '\r') {
					length++;
				} else {
					break;
				}
			}
			return length;
		}

		// Pass 1: Walk through all statements and process them
		for (const node of sourceFile.statements) {
			if (isExportDeclaration(node)) {
				// Handle export declarations
				// Check if this is an empty export (export {};) - these are module markers from TypeScript
				// We should remove them since we generate our own consolidated export statement
				if (node.exportClause && isNamedExports(node.exportClause) && node.exportClause.elements.length === 0 && !node.moduleSpecifier) {
					// Remove empty export statements
					code.remove(getStart(node), getEnd(node));
				}
				// Handle 'export type' declarations - keep them but strip the 'type' keyword
				else if (node.isTypeOnly) {
					// Find the 'type' keyword position (after 'export' and before the export clause or 'from')
					const exportKeywordEnd = node.getStart() + 'export'.length;
					const nextTokenStart = node.exportClause?.getStart() ?? node.moduleSpecifier?.getStart() ?? node.getEnd();
					const typeMatch = code.slice(exportKeywordEnd, nextTokenStart).match(typeMatcher);

					if (typeMatch?.index !== undefined) {
						const typeKeywordStart = exportKeywordEnd + typeMatch.index;
						const typeKeywordEnd = typeKeywordStart + 'type'.length;
						// Remove 'type' keyword and any trailing whitespace
						const afterType = code.slice(typeKeywordEnd, nextTokenStart);
						code.remove(typeKeywordStart, typeKeywordEnd + afterType.length - afterType.trimStart().length);
					}
				}
			} else if (isEnumDeclaration(node) || isFunctionDeclaration(node) || isInterfaceDeclaration(node) || isClassDeclaration(node) || isTypeAliasDeclaration(node) || isModuleDeclaration(node)) {
				// collect the declared name
				if (node.name) {
					const name = node.name.getText();
					declaredNames.add(name);

					// collect the exported name, maybe as `default`.
					if (DeclarationProcessor.#matchesModifier(node, ModifierFlags.ExportDefault)) {
						defaultExport = name;
					} else if (DeclarationProcessor.#matchesModifier(node, ModifierFlags.Export)) {
						exportedNames.add(name);
					}

					if (!(node.flags & NodeFlags.GlobalAugmentation)) {
						pushNamedNode(name, createNameRange(node));
					}
				}

				// duplicate exports of namespaces
				if (isModuleDeclaration(node)) { duplicateExports(node) }

				fixModifiers(node);
			} else if (isVariableStatement(node)) {
				// collect all the names
				for (const { name } of node.declarationList.declarations) {
					if (isIdentifier(name)) {
						const nameText = name.getText();
						declaredNames.add(nameText);

						// collect the exported name for variable statements
						// For variable statements, we need to check modifiers on the statement directly
						if (node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.DefaultKeyword)) {
							/* v8 ignore next */
							defaultExport = nameText;
						} else if (node.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword)) {
							exportedNames.add(nameText);
						}
					}
				}

				fixModifiers(node);

				const { declarations } = node.declarationList;

				// collect the ranges for re-ordering
				if (declarations.length === 1) {
					const [{ name }] = declarations;
					if (isIdentifier(name)) {
						pushNamedNode(name.getText(), createNameRange(node));
					}
				} else {
					// we do reordering after splitting
					const decls = declarations.slice();
					const first = decls.shift()!;
					pushNamedNode(first.name.getText(), [ getStart(node), first.getEnd() ] as NameRange);
					for (const declaration of decls) {
						if (isIdentifier(declaration.name)) {
							pushNamedNode(declaration.name.getText(), [ declaration.getFullStart(), declaration.getEnd() ] as NameRange);
						}
					}
				}

				// split the variable declaration into different statements
				const { flags } = node.declarationList;
				const prefix = `declare ${flags & NodeFlags.Let ? 'let' : flags & NodeFlags.Const ? 'const' : 'var'} `;

				// Walk declarations directly via AST instead of token-level getChildren() (~2x faster).
				// Find each comma between consecutive declarations by scanning source text.
				const sourceText = sourceFile.text;
				for (let i = 1; i < declarations.length; i++) {
					const prev = declarations[i - 1];
					const curr = declarations[i];

					// Find comma token between prev.end and curr.getStart()
					let commaPos = -1;
					const limit = curr.getStart();
					for (let p = prev.end; p < limit; p++) {
						if (sourceText.charCodeAt(p) === commaCharacter /* , */) { commaPos = p; break }
					}
					if (commaPos === -1) { continue }

					code.remove(commaPos, commaPos + 1);
					code.appendLeft(commaPos, `;${newLine}`);

					const start = curr.getFullStart();
					const slice = sourceText.substring(start, curr.getStart());
					const whitespace = slice.length - slice.trimStart().length;

					if (whitespace) {
						code.overwrite(start, start + whitespace, prefix);
					} else {
						code.appendLeft(start, prefix);
					}
				}
			}
		}

		/**
		 * Pass 2:
		 *
		 * Now that we have a Set of all the declared names, we can use that to
		 * generate and de-conflict names for the following steps:
		 *
		 * - Resolve all the inline imports.
		 * - Give any name-less `default export` a name.
		 */
		for (const node of sourceFile.statements) {
			// recursively check inline imports
			checkInlineImport(node);

			// only function and class can be default exported, and be missing a name
			if ((isFunctionDeclaration(node) || isClassDeclaration(node)) && !node.name) {
				if (defaultExport === '') { defaultExport = generateUniqueName('export_default') }

				const children = node.getChildren();
				const index = children.findIndex((node) => node.kind === SyntaxKind.ClassKeyword || node.kind === SyntaxKind.FunctionKeyword);
				const token = children[index];
				const nextToken = children[index + 1];

				if (SyntaxKind.FirstPunctuation <= nextToken.kind && nextToken.kind <= SyntaxKind.LastPunctuation) {
					code.appendLeft(nextToken.getStart(), `${code.slice(token.getEnd(), nextToken.getStart()) !== ' ' ? ' ' : ''}${defaultExport}`);
				} else {
					code.appendRight(token.getEnd(), ` ${defaultExport}`);
				}
			}
		}

		// and re-order all the name ranges to be contiguous
		for (const nameRange of nameRanges.values()) {
			// we have to move all the nodes in front of the *last* one, which is a bit
			// unintuitive but is a workaround for: https://github.com/Rich-Harris/magic-string/issues/180
			const [ start ] = nameRange.pop()!;
			for (const [ rangeStart, rangeEnd ] of nameRange) { code.move(rangeStart, rangeEnd, start) }
		}

		// render all the inline imports, and all the exports
		if (defaultExport !== '') { code.append(`${newLine}export default ${defaultExport};${newLine}`) }

		if (exportedNames.size) {
			code.append(`${newLine}export { ${[...exportedNames].join(', ')} };${newLine}`);
		}

		for (const [ fileId, importName ] of inlineImports.entries()) {
			code.prepend(`import * as ${importName} from "${fileId}";${newLine}`);
		}

		// and collect/remove all the typeReferenceDirectives
		const typeReferences = parseReferenceDirectives(sourceFile.typeReferenceDirectives);

		// and collect/remove all the fileReferenceDirectives
		const fileReferences = parseReferenceDirectives(sourceFile.referencedFiles);

		return { code: code.toString(), typeReferences, fileReferences };
	}

	/**
	 * Check if a TypeScript declaration has specific modifier flags
	 * @param node - The TypeScript declaration node
	 * @param flags - The modifier flags to check for
	 * @returns True if the node has all the specified flags
	 */
	static #matchesModifier = (node: Declaration, flags: ModifierFlags): boolean => (getCombinedModifierFlags(node) & flags) === flags;

	/**
	 * Post-processes a bundled declaration file to clean up bundling artifacts.
	 *
	 * @param sourceFile The source file to process
	 * @returns The processed source code
	 */
	static postProcess(sourceFile: SourceFile): string {
		const magic = new MagicString(sourceFile.getFullText());

		/**
		 * Visit a node and apply code transformations using MagicString for O(1) edits.
		 * Handles empty statements, import/export path fixes, and redundant namespace export elements.
		 * @param node The AST node to visit
		 */
		function visitNode(node: Node) {
			// Remove empty statements (spurious semicolons)
			if (isEmptyStatement(node)) {
				magic.remove(node.getStart(), node.getEnd());
				return; // nothing else to do for this node
			}

			// Fix import/export paths: .d.ts → .js
			if ((isImportDeclaration(node) || isExportDeclaration(node)) && node.moduleSpecifier && isStringLiteral(node.moduleSpecifier)) {
				const { text } = node.moduleSpecifier;
				if (text.startsWith('.') && text.endsWith(FileExtension.DTS)) {
					// Replace .d.ts or .d.tsx with .js (faster than regex)
					const replacement = text.endsWith('.d.tsx') ? text.slice(0, -6) + FileExtension.JS : text.slice(0, -5) + FileExtension.JS;
					magic.overwrite(node.moduleSpecifier.getStart() + 1, node.moduleSpecifier.getEnd() - 1, replacement);
				}
			}

			// Remove redundant `{ Foo as Foo }` exports from namespaces
			if (isExportSpecifier(node) && node.propertyName && isIdentifier(node.propertyName) && isIdentifier(node.name) && node.propertyName.text === node.name.text) {
				magic.remove(node.propertyName.getStart(), node.name.getStart());
			}

			// Recurse into children for other possible matches deeper in the tree
			forEachChild(node, visitNode);
		}

		visitNode(sourceFile);

		return magic.toString();
	}
}
