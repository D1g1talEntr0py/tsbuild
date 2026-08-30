#!/usr/bin/env tsx
/**
 * Runs the full test suite against multiple TypeScript versions.
 *
 * Usage:
 *   tsx tests/scripts/test-ts-compat.ts [--versions N] [--target VERSION]
 *
 * Options:
 *   --versions N       Number of recent minor versions to test (default: 3)
 *   --target VERSION   Test a specific TypeScript version (e.g., 5.5.4)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Strip leading '--' that pnpm injects when forwarding args
const args = process.argv.slice(2).filter((arg) => arg !== '--');

const { values } = parseArgs({
	args,
	options: {
		versions: { type: 'string', short: 'v', default: '3' },
		target: { type: 'string', short: 't' },
	},
	strict: true,
});

const run = (command: string) => execSync(command, { encoding: 'utf8', stdio: 'pipe' }).trim();
const installedTypeScriptVersion = () => run(`node --input-type=module -e "import('typescript').then(({ version }) => console.log(version))"`);
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies?: Record<string, string> };
const originalTypeScriptSpecifier = packageJson.devDependencies?.['typescript'];
if (originalTypeScriptSpecifier === undefined) { throw new Error('package.json must define devDependencies.typescript') }

// Capture the currently installed version so we can restore it
const currentVersion = installedTypeScriptVersion();
console.log(`Current TypeScript version: ${currentVersion}\n`);

let targetVersions: string[];

if (values.target) {
	targetVersions = [values.target];
} else {
	const count = Number(values.versions);
	if (!Number.isInteger(count) || count < 1) {
		console.error('--versions must be a positive integer');
		process.exit(1);
	}

	// Query npm for all stable TypeScript versions
	// TS 7+ ships an entirely new API; exclude until the legacy-compatible API is available (expected 7.1+)
	const allVersions: string[] = JSON.parse(run('npm view typescript versions --json'));
	const stable = allVersions.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && Number(v.split('.')[0]) < 7);

	// Deduplicate by major.minor, keeping the latest patch for each
	const latestByMinor = new Map<string, string>();
	for (const version of stable) {
		const minor = version.split('.').slice(0, 2).join('.');
		latestByMinor.set(minor, version);
	}

	const minorKeys = [...latestByMinor.keys()];
	const targetMinors = minorKeys.slice(-count);
	targetVersions = targetMinors.map((m) => latestByMinor.get(m)!);
}

console.log(`Testing against ${targetVersions.length} versions: ${targetVersions.join(', ')}\n`);

const results: Array<{ version: string; passed: boolean; output: string }> = [];

for (const version of targetVersions) {
	console.log(`${'─'.repeat(60)}`);
	console.log(`Installing TypeScript ${version}...`);

	try {
		run(`pnpm add -D "typescript@npm:typescript@${version}" --save-exact`);
		const installed = installedTypeScriptVersion();
		if (installed !== version) { throw new Error(`Installed TypeScript ${installed}, expected ${version}`) }
		console.log(`Running compatibility tests against TypeScript ${installed}...`);

		const output = run('pnpm test 2>&1');
		console.log(`✓ TypeScript ${version} — PASSED`);
		results.push({ version, passed: true, output });
	} catch (error) {
		const output = (error as { stdout?: string; stderr?: string }).stdout ?? (error as { stderr?: string }).stderr ?? String(error);
		console.log(`✗ TypeScript ${version} — FAILED`);
		console.log(output);
		results.push({ version, passed: false, output });
	}
}

// Restore original version
console.log(`\n${'─'.repeat(60)}`);
console.log(`Restoring TypeScript ${currentVersion}...`);
run(`pnpm add -D "typescript@${originalTypeScriptSpecifier}"`);

// Summary
console.log(`\n${'═'.repeat(60)}`);
console.log('COMPATIBILITY TEST SUMMARY');
console.log('═'.repeat(60));

for (const { version, passed } of results) {
	console.log(`  TypeScript ${version.padEnd(10)} ${passed ? '✓ PASSED' : '✗ FAILED'}`);
}

const failed = results.filter((r) => !r.passed);
if (failed.length > 0) {
	console.log(`\n${failed.length} version(s) failed.`);
	process.exit(1);
} else {
	console.log(`\nAll ${results.length} versions passed.`);
}
