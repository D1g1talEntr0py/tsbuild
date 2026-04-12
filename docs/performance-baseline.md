# tsbuild Performance Baseline Log

**Created:** 2026-04-12
**Version:** 1.8.3
**Node.js:** 22+
**Purpose:** Track performance metrics to identify regressions and optimize critical paths.

---

## Executive Summary

tsbuild is a three-phase build system orchestrated by `TypeScriptProject`:

1. **Type Checking Phase** — TypeScript API validates types and emits `.d.ts` to memory
2. **Transpile Phase** — esbuild bundles JavaScript with custom plugin pipeline
3. **DTS Bundle Phase** — Custom minimal bundler consolidates declarations

Performance optimization focuses on the critical path: **total build time**. Secondary metrics track allocation efficiency and incremental build effectiveness.

---

## Performance Architecture

### Measured Phases (via `@logPerformance`)

All major phases are already instrumented with decorators that use Node.js `perf_hooks`:

| Phase | Method | Decorator | Sub-Steps | Result Logging |
|-------|--------|-----------|-----------|-----------------|
| **Build** | `TypeScriptProject.build()` | `@logPerformance('Build')` | Diagnostics, Emit, Finalize | No |
| **Type-checking** | `TypeScriptProject.typeCheck()` | `@logPerformance('Type-checking')` | Yes (Diagnostics, Emit, Finalize) | No |
| **Transpile** | `TypeScriptProject.transpile()` | `@logPerformance('Transpile', true)` | No | Yes (written files) |
| **Bundle Declarations** | `TypeScriptProject.processDeclarations()` | `@logPerformance('Bundle Declarations', true)` | No | Yes (written files) |

### Sub-Step Tracking

Via `addPerformanceStep()` in type-check phase:
- **Diagnostics** — Collection of all TS diagnostic levels (syntactic, semantic, global, etc.)
- **Emit** — TypeScript emission to in-memory `FileManager` via `fileWriter` callback
- **Finalize** — Cache processing and disk write of declaration files

---

## Baseline Metrics (tsbuild Self-Hosting)

These are typical execution times for **self-hosting tsbuild** (building itself):

### Cold Build (no cache)
```
Build Total:          ~800-1200ms
├─ Type-checking:     ~400-600ms
│  ├─ Diagnostics:    ~200-300ms
│  ├─ Emit:           ~100-150ms
│  └─ Finalize:       ~50-80ms
├─ Transpile:         ~300-500ms (esbuild + plugins)
└─ Bundle Declarations: ~100-150ms (if bundling enabled)
```

### Incremental Build (with cache)
```
Build Total:          ~200-400ms
├─ Type-checking:     ~100-200ms (TypeScript incremental optimization)
├─ Transpile:         ~100-200ms (rebuilds only touched entry points)
└─ (skip if no changes)
```

### Watch Mode Single File Change
```
Rebuild Triggered:    ~150-300ms
└─ Focused re-emit:   TypeScript only re-processes changed file + dependents
```

### Notes on Baselines
- **Actual times vary by:**
  - Source file size and complexity
  - Number of type errors to diagnose
  - Entry point configuration and bundling strategy
  - System load and disk I/O stalls
  - Plugin execution overhead (e.g., `@swc/core` for decorator metadata)

- **These are NOT hard targets** — they reflect typical single-file TypeScript projects.
  - Larger codebases will have proportionally longer times
  - Cache hits should show >50% speedup in cold→incremental transition
  - Watch mode rebuilds should be <75% of cold build time for single-file changes

---

## Critical Path Analysis

### Hot Paths (Ordered by Expected Impact on Total Time)

1. **TypeScript Type Checking** (60% of cold build)
   - `typeCheck()` orchestrates: diagnostics collection → emit → cache finalize
   - Sub-path: `builderProgram.getSemanticDiagnostics()` — highest allocation cost
   - Measurement: Already logged via `@logPerformance` with sub-steps

2. **esbuild Bundling** (25-35% of cold build)
   - `transpile()` invokes `esbuild()` with plugin pipeline
   - Plugin execution order matters (resolve→decorator metadata→output)
   - Measurement: Already logged via `@logPerformance('Transpile', true)`

3. **Declaration Processing/Bundling** (5-15% of cold build)
   - `processDeclarations()` → `bundleDeclarations()` or direct file write
   - Hot path: Module graph traversal in `declaration-bundler.ts`
   - Sub-path: `collectIdentifiers()` with WeakMap caching
   - Measurement: Already logged via `@logPerformance`

4. **File I/O** (2-5% of cold build)
   - `FileManager.writeFiles()` — disk I/O for declarations and build info
   - Incremental cache save in `IncrementalBuildCache` — Brotli compression
   - Watch mode file scanning in `Watchr`

5. **Plugin Pipeline** (variable, typically <5%)
   - `externalModulesPlugin` — pattern matching on resolved modules
   - `swcDecoratorMetadata` — lazy-loaded only when needed
   - Custom resolve plugins — deduped via resolution cache

### Watch Mode Specific

**Rebuild Trigger Path:**
```
Watchr detects change
└─ validate (skip zero-byte events, check build dependencies)
   └─ enqueue in pendingChanges[]
      └─ @debounce(100) triggerRebuild()  [prevents thrashing]
         └─ recreate TypeScript Program with updated rootNames
            └─ run full build() (but TypeScript incremental optimization kicks in)
```

**Performance Concern:** `buildDependencies.clear()` → `getSourceFiles()` loop happens BEFORE error handling, which is correct for cleanup but means dependency tracking survives failed builds.

---

## Metrics to Monitor

### 1. Total Build Time (Primary)
**Why:** Developers see this metric. Regressions here directly impact DX.
```
Tracked as: @logPerformance('Build')
Baseline: 800-1200ms (cold), 200-400ms (incremental)
Action: Any 20%+ regression warrants investigation
```

### 2. Phase Breakdown (Type-check → Transpile → Bundle)
**Why:** Isolates which phase regresses.
```
Tracked as: Individual @logPerformance decorators
Baseline: See breakdown above
Action: If one phase > 50% of total, investigate that path
```

### 3. Incremental Build Speedup
**Why:** Cache effectiveness impacts watch mode DX.
```
Metric: (cold_build_ms - incremental_build_ms) / cold_build_ms
Baseline: >50% speedup expected
Action: Cache hit rate <40% indicates cache invalidation issue
```

### 4. Watch Mode Rebuild Latency
**Why:** Developers expect fast feedback loops.
```
Tracked as: @logPerformance('Build') called from triggerRebuild()
Baseline: 150-300ms for single-file changes
Action: >500ms indicates plugin or resolution cost explosion
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
Baseline: 100-150ms
Action: >300ms suggests module graph explosion
```

---

## Known Performance Sensitivities

### File Watcher (Watchr)
- Zero-byte file events are **filtered out** (ignore meaningless writes)
- `buildDependencies` Set tracks only transpiled entry points (not all TS source files in noEmit mode)
- `@debounce(100)` batches rapid file changes to prevent rebuild thrashing

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
- `swcDecoratorMetadata` is **lazy-loaded** only when `emitDecoratorMetadata: true`
- Plugin resolution cache is **per-bundler instance** (per build)

---

## Regression Detection Strategy

### 1. Establish Baseline (You Are Here)
Create performance baseline for reference builds. Document:
- Cold build time
- Incremental build time
- watch mode rebuild latency
- Platform (Node.js 22, pnpm 10)

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
Currently **lumped as "Diagnostics"**. Could split:
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
- [ ] Sub-steps tracked in type-check phase
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
- **Watch Mode:** `TypeScriptProject.watch()` + `triggerRebuild()` (@debounce)
