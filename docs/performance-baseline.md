# tsbuild Performance Baseline Log

**Created:** 2026-04-12
**Updated:** 2026-09-05
**Version:** 2.5.1
**Node.js:** 26.8.1
**pnpm:** 12.3.4
**Purpose:** Track performance metrics to identify regressions and optimize critical paths.

---

## Executive Summary

tsbuild's `TypeScriptProject.build()` runs in three stages, the middle one parallelized:

1. **Type Checking Phase** (`#typeCheck()`, sequential, always first) — TypeScript API validates types and emits `.d.ts`/`.js` to memory via `FileManager`. Transpile and declaration bundling both depend on this phase's output, so it cannot overlap with them.
2. **Declaration Bundling + Transpile Phase** (parallel) — `#processDeclarations()` (custom dts bundler) and `#transpile()` (esbuild) are both pushed onto a `processes` array and awaited together via `Promise.allSettled(processes)`. Each only runs if emission is required for that artifact (`compilerOptions.declaration` / `!compilerOptions.emitDeclarationOnly`).
3. **Finalize Phase** (`#finalizeBuildArtifacts()`) — persists the Brotli-compressed `.tsbuildinfo`/dts cache. This is deliberately deferred until *after* the parallel phase completes (compressing during transpile was measured to inflate esbuild's wall time by 50-70ms via libuv threadpool contention). Stale-output cleanup and manifest persistence are fire-and-forget here and never inflate the critical path.

Performance optimization focuses on the critical path: **total build time**, with type-checking as the dominant cost and the declaration/transpile phase retained in parallel. Runtime optimization requires repeatable measurements before code changes.

---

## Performance Architecture

### Measured Phases (via `@logPerformance`)

All major phases are already instrumented with decorators that use Node.js `perf_hooks`:

| Phase | Method | Decorator | Runs | Result Logging |
|-------|--------|-----------|------|-----------------|
| **Build** | `TypeScriptProject.build()` | `@logPerformance('Build')` | Always (top-level) | No |
| **Type-checking/Emit** | `TypeScriptProject.#typeCheck()` | `@logPerformance('Type-checking/Emit')` | Sequential, always first | No |
| **Bundle Declarations** | `TypeScriptProject.#processDeclarations()` | `@logPerformance('Bundle Declarations')` | Parallel (only if `compilerOptions.declaration`) | Yes, when written files exist |
| **Transpile** | `TypeScriptProject.#transpile()` | `@logPerformance('Transpile')` | Parallel (only if `!compilerOptions.emitDeclarationOnly`) | Yes, when written files exist |

`@logPerformance` takes a single message argument; result-file logging is automatic whenever the measured method resolves with a non-empty `WrittenFile[]`, not a second decorator flag.

### No Sub-Step Tracking

`#typeCheck()` is measured as one unified phase. Diagnostics collection and TypeScript's `emit()` call happen inline; they are not reported as separate performance steps.

---

### Baseline Metrics

Measured 2026-09-05 on Linux with Node 26.8.1, pnpm 12.3.4, TypeScript 7.0.2, and esbuild 0.28.2. Synthetic projects were isolated under `/tmp`; values are medians from repeated samples, not hard performance targets.

| Scenario | Samples | Median | p95 | Notes |
|----------|---------|--------|-----|-------|
| Cold build, 120 modules | 7 | 594 ms | 601 ms | Fresh project/cache |
| Warm no-op, 300 modules | 9 | 496 ms | 500 ms | Includes fresh CLI startup |
| One-file rebuild, 120 modules | 7 | 577 ms | 618 ms | CV 7.2% |
| Multi-entry DTS, 300 modules, no `rootDir` | 5 | 716 ms | 723 ms | Path scan not material at this size |
| Multi-entry DTS, explicit `rootDir` | 5 | 710 ms | 721 ms | 0.8% median difference |
| Nested output names, 180 modules | 5 | 644 ms | 650 ms | Declaration output paths |
| CLI `--help` | 9 | 20.3 ms | 21.2 ms | Lazy import path |
| CLI `--version` | 9 | 19.6 ms | 20.3 ms | Lazy import path |

### Historical Self-Hosting Reference

The following older self-hosting values remain historical context only and are not directly comparable to the synthetic measurements above.

### Cold Build (`rm -rf .tsbuild dist && pnpm build`)
```
Build Total:            486ms
├─ Type-checking/Emit:  453ms  (93%)
├─ Bundle Declarations:  15ms  (3%, parallel with Transpile)
└─ Transpile:            30ms  (6%, parallel with Bundle Declarations)
```

### Incremental Build, no changes (`pnpm build` again)
```
Build Total:            9ms
└─ Type-checking/Emit:  1ms  (TypeScript incremental short-circuit; transpile/dts skipped entirely)
```

### Incremental Build, one-file change (append a comment to `src/logger.ts`, a non-entry-point file)
```
Build Total:            445ms  (8% faster than cold — type-checking dominates either way)
├─ Type-checking/Emit:  415ms  (93%)
├─ Bundle Declarations:  16ms  (4%, parallel with Transpile)
└─ Transpile:            24ms  (5%, parallel with Bundle Declarations)
```

### CLI `--help` Path
```
~20ms  (3 runs: 22.8ms, 19.3ms, 20.0ms)
```
This stays fast only because `src/errors.ts` avoids a top-level `import ... from 'typescript'` — see the "Known Performance Sensitivities" section below. If `--help` regresses toward ~150ms, that import likely came back.

### Notes on Baselines
- **Actual times vary by:**
  - Source file size and complexity
  - Number of type errors to diagnose
  - Entry point configuration and bundling strategy
  - System load and disk I/O stalls
  - Plugin execution overhead (e.g., decorator metadata plugins, if enabled)

- **These are NOT hard targets** — tsbuild's own `src/` is a small, single-package project.
  - Larger codebases will have proportionally longer type-checking (the dominant cost)
  - Incremental no-op builds should be near-instant (TypeScript's own incremental short-circuit)
  - The parallel phase (bundle declarations + transpile) is small relative to type-checking on this codebase; it becomes more significant on projects with many entry points or a large declaration graph

---

## Critical Path Analysis

### Hot Paths (Ordered by Expected Impact on Total Time)

1. **TypeScript Type Checking** (60% of cold build)
   - `typeCheck()` orchestrates: diagnostics collection → emit → cache finalize
   - Sub-path: `builderProgram.getSemanticDiagnostics()` — highest allocation cost
   - Measurement: Logged via `@logPerformance('Type-checking/Emit')`

2. **esbuild Bundling** (25-35% of cold build)
   - `transpile()` invokes `esbuild()` with plugin pipeline
   - Plugin execution order matters (resolve→decorator metadata→output)
   - Measurement: Logged via `@logPerformance('Transpile')`

3. **Declaration Processing/Bundling** (5-15% of cold build)
   - `processDeclarations()` → `bundleDeclarations()` or direct file write
   - Hot path: Module graph traversal in `declaration-bundler.ts`
   - Sub-path: `collectIdentifiers()` with WeakMap caching
   - Measurement: Logged via `@logPerformance('Bundle Declarations')`

4. **File I/O** (2-5% of cold build)
   - `FileManager.writeFiles()` — disk I/O for declarations and build info
   - Incremental cache save in `IncrementalBuildCache` — Brotli compression
   - Watch mode file scanning in `Watchr`

5. **Plugin Pipeline** (variable, typically <5%)
   - `externalModulesPlugin` — pattern matching on resolved modules
   - Custom resolve plugins — loaded only when configured
   - Custom resolve plugins — deduped via resolution cache

### Watch Mode Specific

**Rebuild Trigger Path:**
```
Watchr detects change
└─ validate (skip zero-byte events, check build dependencies)
   └─ enqueue in pendingChanges[]
      └─ rename-timeout dispatch  [coalesces rapid changes]
         └─ recreate TypeScript Program with updated rootNames
            └─ run full build() (but TypeScript incremental optimization kicks in)
```

**Performance Note:** Watch rebuilds reuse the prior builder program and cached source files where possible. No watch-retention regression was observed in the current integration suite.

---

## Metrics to Monitor

### 1. Total Build Time (Primary)
**Why:** Developers see this metric. Regressions here directly impact DX.
```
Tracked as: @logPerformance('Build')
Baseline: See the measured workload table above.
Action: Investigate repeatable regressions outside measurement variability.
```

### 2. Phase Breakdown (Type-check → Transpile → Bundle)
**Why:** Isolates which phase regresses.
```
Tracked as: Individual @logPerformance decorators
Baseline: See the measured workload table above.
Action: Compare paired runs on the same environment before investigating.
```

### 3. Incremental Build Speedup
**Why:** Cache effectiveness impacts watch mode DX.
```
Metric: (cold_build_ms - incremental_build_ms) / cold_build_ms
Baseline: Not established across project sizes.
Action: Measure cold, warm no-op, and changed-file runs together.
```

### 4. Watch Mode Rebuild Latency
**Why:** Developers expect fast feedback loops.
```
Tracked as: @logPerformance('Build') called from triggerRebuild()
Baseline: Not established independently of the build process.
Action: Measure watch latency separately before attributing cost to plugins or resolution.
```

### 5. Allocation/Memory Efficiency
**Why:** Long-running watch mode sessions should not accumulate garbage.
```
Not currently tracked. See "Future Monitoring" below.
```

### 6. Declaration Bundling Graph Traversal
**Why:** Large projects with deep dependency graphs can stall here.
```
Tracked within: @logPerformance('Bundle Declarations')
Baseline: Not established independently of the full build.
Action: Profile larger declaration graphs before optimizing.
```

---

## Known Performance Sensitivities

### File Watcher (Watchr)
- Zero-byte file events are **filtered out** (ignore meaningless writes)
- `buildDependencies` Set tracks only transpiled entry points (not all TS source files in noEmit mode)
- Watch rename timeout batches rapid file changes to prevent rebuild thrashing

### TypeScript Incremental Compilation
- `createIncrementalProgram()` is called **per rebuild** with new root files
- `.tsbuildinfo` file persistence enables detection of unchanged files
- Cache invalidation is handled by TypeScript's `incremental` flag in config
- **Risk:** User-side issues with `incremental: false` will show no speedup

### Declaration Bundler
- Module graph built from imports/exports via TypeScript's `resolveModuleName()`
- **Caching:** `collectIdentifiers()` uses WeakMap to avoid reparsing same SourceFiles
- **Risk:** If module graph is circular or deeply nested, topological sort could become expensive

### esbuild Plugin Pipeline
- Plugins run in **registration order**
- `externalModulesPlugin` only added if `noExternal` array has patterns
- Custom plugins are loaded only when configured
- Plugin resolution cache is **per-bundler instance** (per build)

---

## Regression Detection Strategy

### 1. Establish Baseline (You Are Here)
Create performance baseline for reference builds. Document:
- Cold build time
- Incremental build time
- watch mode rebuild latency
- Platform and tool versions, including Node.js 26.8.1, pnpm 12.3.4, TypeScript 7.0.2, and esbuild 0.28.2

### 2. Periodic Re-measurement
After significant code changes (especially in `declaration-bundler.ts`, `type-script-project.ts`, or plugins), measure:
```bash
# Cold build (clear cache first)
rm -rf .tsbuild/
pnpm build

# Incremental (with cache)
touch src/tsbuild.ts  # Change a timestamp
pnpm build

# Watch mode
pnpm build:watch  # Manually edit a file, check rebuild time in log output
```

### 3. Investigate Regressions
If any phase shows **>20% slowdown**:
1. Check if new logic was added (imports, loops, allocations)
2. Profile with Node.js: `node --prof src/tsbuild.ts && node --prof-process isolate-*.log | head -50`
3. Review recent commits affecting that phase
4. Check if TypeScript or esbuild version changed (can have significant impact)

### 4. Document Changes
When optimizing, update this log with:
- **Before:** The problematic behavior/time
- **After:** The optimized time
- **Method:** What was changed and why
- **Impact:** Percentage improvement

---

## Future Monitoring Opportunities

### 1. Allocation Churn Tracking
Currently **not tracked**. Could be added with:
```javascript
import { performance } from 'perf_hooks';
performance.measureMemory(); // Chrome DevTools protocol, requires --expose-gc
```

**Why useful:** Detects memory leaks in long-running watch mode.
**Implementation:** Measure heap before/after each build phase; flag if heap doesn't shrink post-GC.

### 2. Plugin Execution Times
Currently **lumped into "Transpile"**. Could be improved with:
- esbuild's `onResolve`/`onLoad` hooks recording timing
- Per-plugin performance measurement

**Why useful:** Identifies expensive custom plugins.

### 3. File I/O Metrics
Currently **unmeasured**. Could track:
- Time spent in `Files.writeFile()` (disk I/O)
- Brotli compression time in `IncrementalBuildCache`
- File descriptor churn in Watchr

**Why useful:** Identifies I/O bottlenecks on slower systems.

### 4. Type Diagnostics Breakdown
Currently **not separately instrumented**. Could split:
- Syntactic diags (`getSyntacticDiagnostics`)
- Semantic diags (`getSemanticDiagnostics`)
- Declaration diags (`getDeclarationDiagnostics`)

**Why useful:** Identifies whether time is spent in parsing, type-checking, or emit validation.

### 5. Watch Mode Statistics
Could track:
- File change detection latency (Watchr → callback)
- Debounce effectiveness (files batched per rebuild)
- Rebuild frequency (builds/minute during active editing)

**Why useful:** Identifies if watch mode is spamming reruns or missing changes.

---

## Testing Performance Regressions

### Unit Test Considerations
- Tests use mocked `FileManager` and `esbuild` — **not realistic for perf**
- Perf tests should use **real** TS/esbuild instead of mocks
- Consider integration test suite for end-to-end timing

### Integration Test Template
```typescript
import { TypeScriptProject } from './type-script-project';

describe('Performance', () => {
  it('cold build completes in <1500ms', async () => {
    const start = performance.now();
    await new TypeScriptProject('/path/to/test-project').build();
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1500);
  });

  it('incremental rebuild is >50% faster', async () => {
    const project = new TypeScriptProject('/path/to/test-project');
    const cold = await measureBuild(project);
    // Simulate file change
    await project.build();
    const warm = await measureBuild(project);
    expect(warm).toBeLessThan(cold * 0.5);
  });
});
```

---

## Summary Checklist

- [ ] Baseline recorded: Cold build, incremental, watch mode
- [ ] All major phases already instrumented with `@logPerformance`
- [ ] Type-check sub-steps tracked separately (not currently implemented)
- [ ] Critical paths identified and documented
- [ ] Regression detection strategy defined
- [ ] Future monitoring opportunities noted
- [ ] Known performance sensitivities documented
- [ ] Ready to detect >20% regressions via periodic testing

---

## References

- **Performance Decorator:** `src/decorators/performance-logger.ts`
- **Main Build Orchestrator:** `src/type-script-project.ts` (all `@logPerformance` decorators)
- **esbuild Integration:** `TypeScriptProject.transpile()` method
- **DTS Bundler:** `src/dts/declaration-bundler.ts` (module graph traversal)
- **File Manager:** `src/file-manager.ts` (in-memory storage + incremental cache)
- **Watch Mode:** `TypeScriptProject.build()` + watcher queue dispatch in `src/type-script-project.ts`
