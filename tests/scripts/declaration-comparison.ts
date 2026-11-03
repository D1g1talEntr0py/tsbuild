import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { ScriptTarget, isClassDeclaration, isInterfaceDeclaration, isTypeAliasDeclaration } from 'typescript/ast';
import { DiagnosticCategory, ModuleKind, ModuleResolutionKind, SymbolFlags, formatDiagnostics, type API, type Symbol } from 'typescript/sync';
import { declarationDuplications, declarationSymbol, declarationText, structuralSignature, type DeclarationDuplication, type StructuralDifference } from './declaration-structure';

/** One entry in the synthetic benchmark, including the modules it publicly re-exports. */
export interface DeclarationEntry {
	name: string;
	moduleIds: string[];
	additionalExports?: string[];
	additionalChecks?: string[];
}

/** Declaration-only artifact metadata; the digest includes relative paths and exact file contents. */
export interface DeclarationMetrics {
	files: Array<{ path: string; bytes: number; lines: number; digest: string }>;
	bytes: number;
	lines: number;
	digest: string;
}

/** Public API validation against ordinary, unbundled tsc declarations for the synthetic fixture. */
export interface DeclarationComparison extends DeclarationMetrics {
	valid: boolean;
	checkedEntries: number;
	expectedEntries: number;
	publicExports: number;
	missingEntries: string[];
	expectedExports: number;
	missingExports: string[];
	extraExports: string[];
	errors: string[];
	structuralDifferences: StructuralDifference[];
	structuresMatched: number;
	typeDifferences: Array<{ entry: string; check: string; diagnostic: string }>;
	duplications: DeclarationDuplication[];
	declarationErrors: string[];
	missingReferences: string[];
}

/** Measures all declaration files, including shared chunks and .d.mts/.d.cts variants. */
export function declarationMetrics(directory: string): DeclarationMetrics {
	const files: DeclarationMetrics['files'] = [];
	const digest = createHash('sha256');
	function visit(dir: string): void {
		if (!existsSync(dir)) { return }
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) { visit(path) }
			else if (/\.d\.(?:ts|mts|cts)$/.test(name)) {
				const content = readFileSync(path);
				const text = content.toString('utf8');
				files.push({
					path: relative(directory, path),
					bytes: content.length,
					lines: text === '' ? 0 : text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0),
					digest: createHash('sha256').update(content).digest('hex'),
				});
				digest.update(JSON.stringify([relative(directory, path), content.length]));
				digest.update(content);
			}
		}
	}
	visit(directory);
	return {
		files,
		bytes: files.reduce((total, file) => total + file.bytes, 0),
		lines: files.reduce((total, file) => total + file.lines, 0),
		digest: digest.digest('hex'),
	};
}

function importPath(from: string, path: string): string {
	const specifier = relative(from, path).replace(/\.d\.(ts|mts|cts)$/, (_, extension: string) =>
		extension === 'ts' ? '.js' : extension === 'mts' ? '.mjs' : '.cjs');
	return JSON.stringify(specifier.startsWith('.') ? specifier : `./${specifier}`);
}

function consumerChecks(entry: DeclarationEntry, reference: string, actual: string, directory: string): string {
	const checks = [
		`import * as Reference from ${importPath(directory, reference)};`,
		`import * as Actual from ${importPath(directory, actual)};`,
		'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
		'type Assert<T extends true> = T;',
		'type PublicShape<T> = { [K in keyof T]: T[K] };',
	];
	for (const id of entry.moduleIds) {
		const assertions = [
			`Equal<typeof Reference.value${id}, typeof Actual.value${id}>`,
			`Equal<Reference.Item${id}, Actual.Item${id}>`,
			`Equal<typeof Reference.make${id}, typeof Actual.make${id}>`,
			`Equal<typeof Reference.transform${id}, typeof Actual.transform${id}>`,
			`Equal<ConstructorParameters<typeof Reference.Aggregator${id}>, ConstructorParameters<typeof Actual.Aggregator${id}>>`,
			`Equal<Omit<typeof Reference.Aggregator${id}, 'prototype'>, Omit<typeof Actual.Aggregator${id}, 'prototype'>>`,
			`Equal<keyof Reference.Aggregator${id}, keyof Actual.Aggregator${id}>`,
			`Equal<Omit<Reference.Aggregator${id}, 'add'>, Omit<Actual.Aggregator${id}, 'add'>>`,
			`Equal<Parameters<Reference.Aggregator${id}['add']>, Parameters<Actual.Aggregator${id}['add']>>`,
			`Equal<ReturnType<Reference.Aggregator${id}['add']>, Reference.Aggregator${id}>`,
			`Equal<ReturnType<Actual.Aggregator${id}['add']>, Actual.Aggregator${id}>`,
			`Equal<PublicShape<Reference.Aggregator${id}> extends Reference.Aggregator${id} ? true : false, PublicShape<Actual.Aggregator${id}> extends Actual.Aggregator${id} ? true : false>`,
		];
		// Comparing unrelated classes directly would reject correctly preserved private fields.
		for (const [index, assertion] of assertions.entries()) {
			checks.push(`export type Check${id}_${index} = Assert<${assertion}>;`);
		}
		checks.push(`export const aggregator${id} = new Actual.Aggregator${id}();`);
		checks.push(`export const chained${id}: typeof aggregator${id} = aggregator${id}.add(Actual.make${id}(1, 'tag'));`);
		checks.push(`declare class Derived${id} extends Actual.Aggregator${id} { readonly __benchmarkSubtype: 'derived'; }`);
		checks.push(`declare const derived${id}: Derived${id};`);
		checks.push(`export const chainedDerived${id}: Derived${id} = derived${id}.add(Actual.make${id}(1));`);
	}
	checks.push(...entry.additionalChecks ?? []);
	return checks.join('\n');
}

/** Checks exports and every synthetic public signature, without comparing bundle text to tsc's module layout. */
export function compareDeclarations(api: API, referenceDirectory: string, outputDirectory: string, entries: DeclarationEntry[]): DeclarationComparison {
	const metrics = declarationMetrics(outputDirectory);
	const result: DeclarationComparison = {
		...metrics, valid: false, checkedEntries: 0, expectedExports: 0, missingExports: [], extraExports: [], errors: [],
		structuralDifferences: [], structuresMatched: 0, typeDifferences: [], duplications: [], declarationErrors: [],
		missingReferences: [],
		expectedEntries: entries.length,
		publicExports: entries.reduce((count, entry) => count + entry.moduleIds.length * 5 + (entry.additionalExports?.length ?? 0), 0),
		missingEntries: [],
	};
	if (!existsSync(outputDirectory)) {
		result.missingEntries.push(...entries.map(entry => entry.name));
		result.errors.push(`Missing declaration output directory: ${outputDirectory}`);
		return result;
	}
	const consumers: string[] = [];
	const pairs: Array<{ entry: DeclarationEntry; reference: string; actual: string }> = [];
	const checkDirectory = mkdtempSync(join(outputDirectory, '.declaration-check-'));
	try {
		for (const entry of entries) {
			const reference = join(referenceDirectory, `${entry.name}.d.ts`);
			if (!existsSync(reference)) { throw new Error(`Missing tsc reference declaration: ${reference}`) }
			const candidates = metrics.files.filter(file => basename(file.path).replace(/\.d\.(?:ts|mts|cts)$/, '') === entry.name);
			if (candidates.length === 0) {
				result.missingEntries.push(entry.name);
				result.errors.push(`Missing declaration entry: ${entry.name}`);
			}
			for (const file of candidates) {
				const actual = join(outputDirectory, file.path);
				const consumer = join(checkDirectory, `entry-${consumers.length}.ts`);
				writeFileSync(consumer, consumerChecks(entry, reference, actual, checkDirectory));
				consumers.push(consumer);
				pairs.push({ entry, reference, actual });
			}
		}

		using snapshot = api.createSnapshot({
			createPrograms: [{
				rootFiles: [...consumers, ...metrics.files.map(file => join(outputDirectory, file.path))],
				compilerOptions: {
					target: ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'], module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler,
					strict: true, noEmit: true, skipLibCheck: false, types: [],
				},
			}],
		});
		const program = snapshot.operation.createdPrograms[0];
		const project = snapshot.getProject(program.id);
		if (project === undefined) { throw new Error('Declaration comparison project is missing from the compiler snapshot.') }
		const checker = project.checker;
		const sharedSymbols = new Map<string, { entry: string; symbol: Symbol }>();
		for (const { entry, reference, actual } of pairs) {
			const referenceSymbol = checker.getSymbolOfSourceFile(reference);
			const actualSymbol = checker.getSymbolOfSourceFile(actual);
			if (referenceSymbol === undefined) { throw new Error(`tsc reference is not a module: ${reference}`) }
			const expected = checker.getExportsOfModule(referenceSymbol).map(symbol => symbol.name);
			const supported = [...entry.moduleIds.flatMap(id => [`value${id}`, `Item${id}`, `make${id}`, `Aggregator${id}`, `transform${id}`]), ...entry.additionalExports ?? []];
			if (expected.length !== supported.length || expected.some(name => !supported.includes(name))) {
				throw new Error(`Synthetic entry ${entry.name} has changed exports; update its declaration consumer checks.`);
			}
			const exported = actualSymbol === undefined ? [] : checker.getExportsOfModule(actualSymbol).map(symbol => symbol.name);
			const actualExports = new Map(actualSymbol === undefined ? [] : checker.getExportsOfModule(actualSymbol).map(symbol => [symbol.name, symbol]));
			for (const symbol of checker.getExportsOfModule(referenceSymbol)) {
				const emitted = actualExports.get(symbol.name);
				if (!emitted) { continue }
				if (structuralSignature(checker, symbol, referenceDirectory) === structuralSignature(checker, emitted, outputDirectory)) {
					result.structuresMatched++;
				} else {
					result.structuralDifferences.push({
						entry: relative(outputDirectory, actual), symbol: symbol.name,
						expected: declarationText(api, checker, symbol), actual: declarationText(api, checker, emitted),
					});
				}
				const original = declarationSymbol(checker, symbol);
				const bundled = declarationSymbol(checker, emitted);
				if ((original.flags & SymbolFlags.Class) !== (bundled.flags & SymbolFlags.Class)) {
					result.typeDifferences.push({ entry: relative(outputDirectory, actual), check: `${symbol.name}: declaration kind`, diagnostic: 'Class/value declaration kind differs from tsc.' });
				}
				const identityKey = `${original.id}:${actual.match(/\.d\.(ts|mts|cts)$/)?.[1]}`;
				const previous = sharedSymbols.get(identityKey);
				const label = relative(outputDirectory, actual);
				const generic = original.declarations.some(handle => {
					const node = handle.resolve();
					return node !== undefined && (isClassDeclaration(node) || isInterfaceDeclaration(node) || isTypeAliasDeclaration(node)) && (node.typeParameters?.length ?? 0) > 0;
				});
				// Uninstantiated generic types contain unrelated type parameters; fixture consumers compare their applications.
				if (previous && previous.entry !== label && !generic) {
					const type = original.flags & SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(bundled) : checker.getTypeOfSymbol(bundled);
					const previousType = original.flags & SymbolFlags.Type ? checker.getDeclaredTypeOfSymbol(previous.symbol) : checker.getTypeOfSymbol(previous.symbol);
					if (!checker.isTypeAssignableTo(type, previousType) || !checker.isTypeAssignableTo(previousType, type)) {
						result.typeDifferences.push({
							entry: label, check: `${symbol.name}: shared identity across entries`,
							diagnostic: `tsc re-exports one shared declaration, but ${label} and ${previous.entry} expose incompatible copies of ${symbol.name}.`,
						});
					}
				} else { sharedSymbols.set(identityKey, { entry: label, symbol: bundled }) }
			}
			result.expectedExports += expected.length;
			result.checkedEntries++;
			const label = relative(outputDirectory, actual);
			result.missingExports.push(...expected.filter(name => !exported.includes(name)).map(name => `${label}: ${name}`));
			result.extraExports.push(...exported.filter(name => !expected.includes(name)).map(name => `${label}: ${name}`));
		}
		const diagnostics = api.batch(
			program.getProgramDiagnostics.gen(), program.getSyntacticDiagnostics.gen(),
			program.getGlobalDiagnostics.gen(), program.getSemanticDiagnostics.gen(),
		).flat().filter(diagnostic => diagnostic.category === DiagnosticCategory.Error);
		if (diagnostics.length > 0) {
			result.errors.push(formatDiagnostics(diagnostics, {
				getCurrentDirectory: () => outputDirectory, getCanonicalFileName: path => path, getNewLine: () => '\n',
			}));
			for (const diagnostic of diagnostics) {
				const text = formatDiagnostics([diagnostic], {
					getCurrentDirectory: () => outputDirectory, getCanonicalFileName: path => path, getNewLine: () => '\n',
				});
				const consumer = diagnostic.fileName === undefined ? undefined : consumers.find(path => path === diagnostic.fileName);
				if (consumer) {
					const sourceLine = readFileSync(consumer, 'utf8').split('\n')[diagnostic.startPosition?.line ?? 0] ?? '';
					const match = /Check(\d+)_(\d+)/.exec(sourceLine);
					const labels = ['value type', 'record shape / readonly', 'factory signature', 'generic transform', 'constructor parameters', 'static members', 'instance member names', 'instance properties', 'add parameters', 'reference fluent return', 'emitted fluent return', 'private nominal branding'];
					result.typeDifferences.push({
						entry: relative(outputDirectory, pairs[consumers.indexOf(consumer)].actual),
						check: match ? `module ${match[1]}: ${labels[Number(match[2])]}` : sourceLine,
						diagnostic: text,
					});
				} else {
					result.declarationErrors.push(text);
					if ([2307, 2688, 6053].includes(diagnostic.code)) { result.missingReferences.push(text) }
				}
			}
		}
		result.duplications = declarationDuplications(api, program, checker, outputDirectory, metrics.files.map(file => file.path));
		for (const file of program.getSourceFileNames()) {
			if (!/\.d\.(?:ts|mts|cts)$/.test(file) && !consumers.includes(file)) {
				result.errors.push(`Declaration resolves to source instead of emitted declarations: ${file}`);
			}
		}
		result.valid = result.errors.length === 0 && result.missingExports.length === 0 && result.extraExports.length === 0 &&
			result.typeDifferences.length === 0 && !result.duplications.some(item => item.kind === 'repeated-declaration');
		return result;
	} finally {
		rmSync(checkDirectory, { recursive: true, force: true });
	}
}
