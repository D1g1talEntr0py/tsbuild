# tsbuild Performance Baseline

**Updated:** 2026-10-25
**Version:** 3.0.3
**Environment:** Linux x64, Node.js 26.12.1, pnpm 12.15.0, TypeScript 7.1.0-beta, esbuild 0.28.2

This document records the TS 7 performance sprint and the final integrated
measurement. Timings are single-host evidence, not service-level targets.
Synthetic workloads and exact raw samples are retained in the local session
evidence directory for the sprint.

## Current architecture

1. **Configuration and compilation.** The TypeScript API configures the
   project, checks inputs, and emits declarations to the in-memory
   `FileManager`. Compilation is sequential and remains the dominant cold-build
   cost for the largest fixture.
2. **Output phases.** Declaration bundling and esbuild run concurrently when
   both are required. The declaration bundler walks modules breadth-first and
   parses/releases source-file leases in bounded batches of 32. While
   transpilation is active, it yields between units of work after an
   approximately 10 ms main-thread budget, allowing esbuild callbacks and
   writes to progress. Declaration-only builds do not schedule event-loop
   turns.
3. **Project-lifetime syntax reuse.** Bundled project declarations retain
   detached ASTs keyed by absolute path and exact preprocessed text. Changed
   text replaces the tree; removed paths are pruned; external declarations and
   resolution state remain build-scoped. The cache is cleared after build and
   cleanup work drains on close.
4. **Output validation and shutdown.** Expected artifacts are checked on every
   reuse candidate, in batches of at most 64, preserving input-order
   missing/error precedence. Close drains async cleanup and accounts for
   synchronous disposal failures; declaration bundling drains every output
   write before reporting a write failure. These checks do not bypass
   canonical-path or symlink safety.
5. **Runtime defaults.** The sprint found no evidence supporting a universal
   thread cap or a cache-retention change. Preserve runtime defaults and
   measure the deployment environment before applying external limits.

## Final uninstrumented CLI profile

The final profile used a freshly generated split ESM CLI from current
`src/tsbuild.ts`, without profiling instrumentation. Each workload had five
cold/no-op pairs in fresh CLI processes; cold runs removed only the copied
fixture's `dist` and `.tsbuild`. Artifact hashes were checked for each cold and
no-op pair. The no-op invocation is a new process using the cache created by
the preceding cold build.

The original column is the original uninstrumented `cli-results.json` captured
before stage 1. The final column comes from the isolated stage-6 harness. The
original fixture copies are no longer retained, so this is a labeled workload
comparison rather than a byte-for-byte replay of those original fixture trees.
The current tree also contains an unrelated concurrent `src/tsbuild.ts` CLI
edit; it was preserved and is not part of the performance changes.

| Workload | Original cold → final cold (ms) | Original no-op → final no-op (ms) | Final artifacts |
|---|---:|---:|---:|
| Self | 278.8 → 277.4 (−0.5%) | 87.0 → 88.5 (+1.7%) | 4 |
| 100 modules | 242.2 → 191.3 (−21.0%) | 86.1 → 86.6 (+0.5%) | 2 |
| 1,000 modules | 1,183.9 → 729.4 (−38.4%) | 112.9 → 113.0 (+0.1%) | 2 |
| 300 modules / 20 entries | 493.8 → 327.1 (−33.8%) | 102.4 → 101.2 (−1.2%) | 40 |

Final cold and no-op artifact sets had identical SHA-256 digests within each
workload. Cold samples agreed on the emitted artifact set. No-op results do
not show a general speedup; the main cold-build reductions align with the
bounded batching and within-entry scheduling stages.

The same final CLI ran a real 1,000-module watch fixture through ten sequential
edits. Each edit's JavaScript output was verified after a successful rebuild:
median edit-to-verified-output latency was **508.6 ms** (492.0–532.5 ms).
There is no comparable uninstrumented original CLI watch series, so this is a
current reference, not a claimed watch speedup.

## Stage evidence and tradeoffs

- **Bounded parse/release batches:** 1,000-module instrumented cold build
  measured 1,120.6 → 691.2 ms; API round trips fell 4,012 → 138. Results are
  from the stage-1 harness and are not directly comparable to the uninstrumented
  final CLI table.
- **AST reuse:** on a 1,000-module watch fixture, declaration-phase median was
  124.1 → 63.2 ms and edit-to-output latency 593.1 → 535.1 ms. Median live
  heap increased by about 12 MiB in that earlier watch measurement. Later
  60-edit forced-GC diagnostics found a bounded project cache and no
  demonstrated unbounded retention; they do not prove the absence of all
  workload-specific leaks.
- **Event-loop scheduling:** uninstrumented stage-3 cold medians were
  772.7 → 736.9 ms (1,000 modules), 206.2 → 195.9 ms (100 modules), and
  353.0 → 333.6 ms (20 entries). The largest measured improvement was reduced
  serialization of declaration bundling behind esbuild callbacks.
- **Output checks and lifecycle:** the current artifact set is checked rather
  than stale constructor-loaded state. Bounded checks retain all outputs and
  preserve first-result precedence; cleanup failures are surfaced by `close()`.
- **Resource controls:** no default thread or runtime concurrency setting was
  changed. Forced-GC heap, native process-tree RSS, and live leases were
  measured separately; RSS alone is not treated as evidence of a leak.

See `docs/architecture.md` for ownership and lifecycle details. Tooling
validation at this baseline: full tests and type-check passed; ESLint did not
start because the installed `typescript-eslint` 8.72.0 rejects TypeScript 7.
No dependency change was made to mask that compatibility limitation.

## Re-measurement guidance

### Bundler declaration comparison

`pnpm bench:dts` is a separate declaration-quality benchmark; `pnpm bench`
remains the performance runner. The declaration runner force-builds the local
CLI and emits ordinary, unbundled declarations with the repository's installed
`tsc` (the exact version is reported). It builds each pinned library once.
By default it checks small and multi-entry fixtures; use
`pnpm bench:dts -- --scenario=small --no-save` for a focused run.

The report checks:

- Public value and type-only exports: missing and unexpected names per entry.
- Declaration AST structures: properties, optional/readonly flags, signatures,
  overloads, generics, recursive types, and referenced local declarations.
  Bundle-local declaration names, comments, whitespace, export/declare placement,
  and interface member ordering are normalized. Structural differences show
  the affected symbol and concrete `tsc`/tool signatures, not a byte delta.
- Consumer type equivalence: record shapes, factories, generic transforms,
  mapped/conditional/union type applications, overloads, class properties,
  constructors, fluent returns, and private/unique-symbol branding.
- Shared identity across entries: incompatible copies of a class or branded
  type fail even when each individual bundle's structure matches `tsc`.
  Uninstantiated generic parameters are not directly compared across entries;
  the fixture's consumer checks compare representative applications instead.
- Compiler errors and missing references with `skipLibCheck: false`, including
  declarations that incorrectly resolve back to original implementation files.
- Exact repeated declarations/members in one scope, repeated files, and copies
  across bundles. Distinct overloads and interface merging are not automatically
  duplicates. Cross-file copies are informational unless they break identity.

All declaration variants and shared chunks are inspected. In the tested
unbuild single-entry output, `.d.ts` and `.d.mts` are alternate declaration
formats with identical declaration tokens. Multi-entry variants reference
format-specific shared chunks. Equal sizes are not counted as accidental
duplicate declarations. The report names the files, compares their tokens,
and shows differing import/re-export targets.

Findings are saved separately to `docs/declaration-measurements.json`, unless
`--no-save` is given. Build failures, missing exports, type inconsistencies,
compiler errors, and duplicate declarations cause a nonzero exit after all
tools are reported. Structural representation differences are shown separately:
they do not alone prove a type error. This is evidence for the synthetic
contracts tested, not a general proof of declaration equivalence.

- Use a fresh split ESM CLI built from the current source; do not profile a
  stale `dist` bundle.
- Use isolated copies of fixed fixtures and clear only their output/cache
  directories. Do not edit or clean the working project as a benchmark setup.
- Run CPU-heavy samples sequentially; report sample count, median, range,
  versions, artifact hashes, and whether instrumentation is present.
- Keep fresh-process CLI time, `build()` phase time, close time, and component
  instrumentation distinct. Do not add overlapping phase durations.
- For watch measurements, wait for a successful rebuild and verify the
  corresponding output after every edit.
- Inspect any profiling runner's destinations before use. Do not run the
  repository self-hosting profiler destructively against the working tree.
- Investigate repeatable changes outside sample variability; do not use a
  single-host synthetic median as a hard performance threshold.

## Shared declaration identity across bundled entries (2026-10-31)

An independent reproduction confirms the shared-identity finding for the current
working-tree build, not just the benchmark's TypeScript API comparison. Two
package subpaths re-export a shared class with a private field, a `unique symbol`,
and an interface branded by that symbol. Consumers receive only `package.json`
and emitted outputs, not the library's TypeScript implementation files.

Regular `tsc` **7.1.0-beta and 5.7.2**, both in **NodeNext and Bundler** resolution
modes with `strict: true` and `skipLibCheck: false`, agree on these results:

| Output configuration | Each entry used separately | Cross-entry assignments | Runtime identity |
|---|---|---|---|
| Regular unbundled `tsc` output | Pass | Pass | Shared |
| Default tsbuild output | Pass | Fail | Shared |
| tsbuild with `splitting: false` | Pass | Fail | Independent |
| Default tsbuild JavaScript with regular `tsc` declarations | Pass | Pass | Shared |

Before the fix, the failing assignments produced TS2322 (different private
class members), TS2719 (unrelated unique-symbol types), and TS2741 (missing
symbol-keyed brand). The declaration files were individually well-formed, but
their duplicated nominal types incorrectly rejected values that interoperate at
runtime.

[Configuration](../src/project/configuration.ts) enables JavaScript splitting
by default for bundled builds, so both entry outputs import the same runtime
class and symbol from a shared chunk. The declaration bundler now detects
compiler-emitted declaration modules shared by multiple entries and writes each
once: a shared module that is itself an entry point stays in that entry's
declaration file, and any other shared module is written at its mirrored source
path (for example `src/@types/index.ts` becomes `@types/index.d.ts`). Entry
bundles import from those files. Entry-specific declarations remain bundled,
and JavaScript output is unchanged.

The regression is checked against an actual temporary package build. A
source-free consumer assigns the private-field class and unique-symbol-branded
interface across both package subpaths, and regular `tsc` passes with
`skipLibCheck: false` in NodeNext resolution mode. The declaration-bundler unit
test also checks the same identities with the TypeScript API.

The current package's published single-entry API also passes a source-free
consumer check with TypeScript 7.1.0-beta in both resolution modes. These checks
confirm the specific multi-entry defect and its fix; they do not prove that
every possible declaration shape is correct.
