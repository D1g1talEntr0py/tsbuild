# Performance Monitoring Quick Reference

**Updated:** 2026-10-25
**Environment:** Linux x64, Node.js 26.12.1, pnpm 12.15.0, TypeScript 7.1.0-beta

## Current reference

These are medians from five uninstrumented fresh-process CLI runs per mode.
Each no-op run followed a cold build on the same isolated fixture, in a new
process. Treat them as same-environment references, not fixed CI thresholds.

| Fixture | Cold build | No-op build | Watch edit-to-verified-output |
|---|---:|---:|---:|
| Self | 277 ms | 89 ms | — |
| 100 modules | 191 ms | 87 ms | — |
| 1,000 modules | 729 ms | 113 ms | 509 ms median, 10 real edits |
| 300 modules / 20 entries | 327 ms | 101 ms | — |

All cold/no-op output hashes matched per fixture. The no-op times include
fresh CLI startup. The watch measurement has no comparable original CLI watch
baseline. For original-to-current comparisons and stage-specific results, see
[performance-baseline.md](./performance-baseline.md).

## Architecture to keep in mind

- TypeScript compilation is sequential and remains a major cold-build cost.
- Declaration bundling runs alongside esbuild when both output phases are
  enabled. Parsing/releasing declaration leases is bounded to batches of 32.
- During parallel transpilation, declaration bundling yields between units of
  work after an approximately 10 ms synchronous budget so esbuild callbacks
  and output writes can progress.
- Unchanged preprocessed project declarations may reuse detached ASTs for the
  lifetime of the owning project. Changed text replaces entries; removed paths
  are pruned; close clears the cache after outstanding work drains.
- Output existence checks run in batches of at most 64 and still validate each
  required output. Canonical-path and symlink protections remain enabled.

## Safe measurement checklist

1. Build a fresh split ESM CLI from current source; do not use a stale bundle.
2. Copy fixed project fixtures to an isolated work directory.
3. Clear only the fixture's `dist` and `.tsbuild` directories for cold runs.
4. Run samples sequentially and record environment, median, range, and sample
   count. Keep uninstrumented CLI, component timings, and memory diagnostics
   separate.
5. Hash expected outputs. For watch runs, verify changed output after each
   successful rebuild.
6. Do not use the working tree or destructive self-hosting profiler as a
   benchmark fixture.

Investigate repeatable regressions outside the measured sample variability.
Do not infer a memory leak from RSS alone; compare live heap after separately
controlled GC diagnostics and observe resource counts across repeated watch
edits.

## Validation note

The current test and type-check suites pass. ESLint currently aborts before
linting because `typescript-eslint` 8.72.0 does not support TypeScript 7; no
dependency workaround is included.
