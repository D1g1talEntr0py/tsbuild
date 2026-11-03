#!/usr/bin/env node
/**
 * Declaration-quality benchmark: one build per library, compared structurally and semantically to regular tsc emit.
 * Run with pnpm bench:dts [-- --scenario=small] [--no-save].
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { API } from 'typescript/sync';
import { version } from 'typescript';
import { SCENARIOS, TOOL_VERSIONS, ensureTsbuildBuilt, resetForTool, execTool, toolsForMode } from './benchmark';
import { compareDeclarations, declarationMetrics, type DeclarationComparison } from './declaration-comparison';
import { generateDeclarationFixture } from './declaration-fixture';

const root = fileURLToPath(new URL('../..', import.meta.url));

function report(tool: string, result: DeclarationComparison): void {
	console.log(`\n${tool}: ${!result.valid ? 'FAIL' : result.structuralDifferences.length > 0 ? 'REVIEW' : 'PASS'}`);
	console.log(`  Entries: ${result.expectedEntries} expected, ${result.missingEntries.length} missing; ${result.checkedEntries} declaration variants checked`);
	console.log(`  Exports: ${result.publicExports} expected in the public entry set; ${result.missingExports.length} missing, ${result.extraExports.length} unexpected`);
	console.log(`  Structures: ${result.structuresMatched} match tsc; ${result.structuralDifferences.length} differ`);
	console.log(`  Types: ${result.typeDifferences.length} consumer inconsistencies; ${result.declarationErrors.length} declaration compiler errors`);
	console.log(`  References: ${result.missingReferences.length} unresolved imports / type or file references`);
	console.log('  Files:');
	for (const file of result.files) { console.log(`    ${file.path}: ${file.bytes} bytes`) }
	for (const duplication of result.duplications) {
		const descriptions = {
			'alternate-variant': `alternate declaration formats (${duplication.identical ? 'identical declaration tokens' : 'different declaration tokens'}); not duplicate declarations in one module`,
			'repeated-file': 'identical declarations under different paths; possible redundant output',
			'repeated-declaration': 'duplicate declaration/member in the same scope',
			'cross-file-copy': 'declaration copied across modules; may be intentional for independent entry bundles',
		};
		console.log(`  ${duplication.files.join(' + ')}: ${descriptions[duplication.kind]}`);
		for (const reference of duplication.references ?? []) {
			console.log(`    ${reference.file} imports/re-exports: ${reference.specifiers.join(', ') || '(none)'}`);
		}
		if (duplication.declaration) { console.log(`    ${duplication.declaration}`) }
	}
	if (result.duplications.length === 0) { console.log('  Duplications: none detected') }
	for (const name of result.missingExports) { console.log(`  MISSING: ${name}`) }
	for (const name of result.extraExports) { console.log(`  UNEXPECTED: ${name}`) }
	for (const difference of result.structuralDifferences) {
		console.log(`  STRUCTURE ${difference.entry} :: ${difference.symbol}\n    tsc: ${difference.expected}\n    tool: ${difference.actual}`);
	}
	for (const difference of result.typeDifferences) { console.log(`  TYPE ${difference.entry} :: ${difference.check}\n${difference.diagnostic}`) }
	for (const error of result.declarationErrors) { console.log(`  DECLARATION ERROR\n${error}`) }
	for (const error of result.errors) {
		if (!error.includes('error TS')) { console.log(`  ERROR ${error}`) }
	}
}

const requested = process.argv.find(argument => argument.startsWith('--scenario='))?.slice('--scenario='.length);
const scenarios = requested === undefined ? SCENARIOS.filter(scenario => scenario.id === 'small' || scenario.id === 'multi-entry') : SCENARIOS.filter(scenario => scenario.id === requested);
if (scenarios.length === 0) { throw new Error(`Unknown scenario '${requested}'. Choose ${SCENARIOS.map(scenario => scenario.id).join(', ')}.`) }
ensureTsbuildBuilt(true);
const directory = mkdtempSync(join(tmpdir(), 'tsbuild-declarations-'));
const results: Array<{ scenario: string; tool: string; comparison?: DeclarationComparison; buildError?: string }> = [];
let invalid = false;
try {
	using api = new API({ cwd: directory });
	console.log(`Declaration-quality benchmark: regular tsc ${version} reference; no performance sampling`);
	console.log('Structural differences are reported separately from compiler/type failures. Formatting, export placement, and bundle-local names are normalized.');
	for (const scenario of scenarios) {
		const entries = generateDeclarationFixture(directory, scenario);
		const reference = join(directory, 'tsc-reference');
		rmSync(reference, { recursive: true, force: true });
		const emitted = spawnSync(process.execPath, [
			join(root, 'node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json'),
			'--declaration', '--emitDeclarationOnly', '--rootDir', join(directory, 'src'),
			'--outDir', reference, '--skipLibCheck', 'false',
		], { cwd: directory, encoding: 'utf8' });
		if (emitted.status !== 0 || emitted.error) { throw new Error(`tsc reference emit failed: ${emitted.error?.message ?? ''}\n${emitted.stdout}\n${emitted.stderr}`) }
		console.log(`\n=== ${scenario.label} ===`);
		const baseline = compareDeclarations(api, reference, reference, entries);
		if (!baseline.valid || baseline.structuralDifferences.length > 0) { throw new Error(`tsc self-comparison failed: ${JSON.stringify(baseline)}`) }
		console.log(`tsc baseline: ${declarationMetrics(reference).files.length} unbundled files; ${baseline.expectedExports} public exports`);
		for (const tool of toolsForMode(true)) {
			resetForTool(directory, tool, scenario);
			try {
				execTool(tool, directory, scenario);
			} catch (error) {
				const buildError = error instanceof Error ? error.message : String(error);
				console.error(`\n${tool.id}: BUILD FAILED\n${buildError}`);
				results.push({ scenario: scenario.id, tool: tool.id, buildError });
				invalid = true;
				continue;
			}
			const comparison = compareDeclarations(api, reference, join(directory, tool.outDir), entries);
			report(tool.id, comparison);
			results.push({ scenario: scenario.id, tool: tool.id, comparison });
			invalid ||= !comparison.valid;
		}
	}
	if (!process.argv.includes('--no-save')) {
		const destination = join(root, 'docs/declaration-measurements.json');
		const existing: unknown = existsSync(destination) ? JSON.parse(readFileSync(destination, 'utf8')) : [];
		if (!Array.isArray(existing)) { throw new Error(`Expected an array of declaration measurements in ${destination}`) }
		writeFileSync(destination, JSON.stringify([...existing, {
			timestamp: new Date().toISOString(), typescript: version, node: process.version, toolVersions: TOOL_VERSIONS, results,
		}], null, 2));
		console.log('\nSaved declaration measurements to docs/declaration-measurements.json');
	}
	if (invalid) { throw new Error('Declaration-quality benchmark found inconsistencies; see the findings above.') }
} finally {
	rmSync(directory, { recursive: true, force: true });
}
