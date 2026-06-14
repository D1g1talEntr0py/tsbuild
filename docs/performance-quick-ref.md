# Performance Monitoring Quick Reference

**For:** tsbuild development team
**Purpose:** Quick checks for performance regressions
**Last Updated:** 2026-06-13

---

## Baseline Snapshot

| Scenario | Time | Status | Notes |
|----------|------|--------|-------|
| Cold build (fresh .tsbuild) | **528ms** | ✓ Baseline | Type-checking dominates (80%) |
| Incremental (no changes) | **5ms** | ✓ Baseline | Instant exit via TS incremental |
| Incremental (source change) | **460ms** | ✓ Baseline | 13% faster than cold |
| Watch rebuild (single file) | **~300-500ms** | Estimated | Not yet measured |

**Regression Threshold:** Any single phase >20% slower = investigate immediately.

---

## How to Test

### Cold Build
```bash
rm -rf .tsbuild dist
pnpm build
# Expected: ~520-550ms total
```

### Incremental Build (No Changes)
```bash
pnpm build
# Expected: ~5ms total
```

### Incremental Build (With Changes)
```bash
echo "// Change" >> src/logger.ts
pnpm build
git checkout src/logger.ts
# Expected: ~450-480ms total (≈13% faster than cold)
```

### Watch Mode Rebuild
```bash
pnpm build:watch
# In another terminal:
echo "// Change" >> src/type-script-project.ts
# Expected: ~300-500ms until "Completed in Xms"
git checkout src/type-script-project.ts
```

---

## Default Strategy

Use a low-overhead, trigger-based approach by default:

- Do not add broad new metrics or instrumentation when baseline checks are healthy.
- Keep existing cold/incremental checks as the standard guardrail.
- Add targeted measurements only when a trigger is observed (for example, >20% phase slowdown, repeated developer-reported slowness, or missed build-time expectations).
- If you add any metric, document maintenance cost and expected diagnostic value first.

---

## What to Watch For

### Performance Improvement Opportunities
These have >5ms overhead and could be tuned:

1. **Declaration Bundling (21ms)** — 4% of cold build
   - Module graph traversal in `declaration-bundler.ts`
   - Opportunity: Profile with large declaration trees

2. **Emit Phase (415ms)** — 79% of type-check
   - This is TypeScript's own emit cost — mostly unavoidable
   - Opportunity: Test with smaller projects to establish baseline scaling

3. **Transpile Plugin Pipeline (100ms)** — 19% of cold build
   - esbuild + plugins (external modules, SWC decorator metadata, custom resolve)
   - Opportunity: Measure per-plugin cost breakdown

### Regression Red Flags
Stop and investigate if you see:

- **Total build >600ms** (cold) — indicates new overhead
- **Type-check phase >500ms** — TypeScript regression (usually TS version, not our code)
- **Transpile >150ms** (cold) — plugin overhead explosion
- **Incremental speedup <40%** — cache invalidation issue
- **"Diagnostics" step missing from output** — indicates logging bug

---

## Code Changes That Require Testing

Test performance BEFORE submitting PR if you change:

- [ ] `type-script-project.ts` — Main orchestrator; affects all phases
- [ ] `declaration-bundler.ts` — Module graph traversal; affects bundle time
- [ ] `file-manager.ts` — In-memory storage and incremental cache
- [ ] `plugins/*` — esbuild plugin pipeline affects transpile time
- [ ] `decorators/performance-logger.ts` — Measurement itself (avoid overhead)
- [ ] `incremental-build-cache.ts` — Brotli serialization affects incremental speed
- [ ] dependency updates (TypeScript, esbuild) — Can have major impact

---

## How Phase Breakdown Works

The `@logPerformance` decorator logs time automatically. Read it like:

```
✓ Type-checking (424ms)          ← Total time for this phase
  └─ Emit 416ms                  ← Sub-step timing
  └─ Finalize 8ms                ← Sub-step timing
✓ Transpile (100ms)              ← Total time for transpile
✓ Bundle Declarations (21ms)     ← Total time for bundling
────────────────────────────────────
✓ Completed in 528ms             ← Grand total
```

**Key Insight:** If type-check shows 424ms but sub-steps only sum to 424ms, another step (Diagnostics) ran but wasn't logged. Check [performance-baseline.md](./performance-baseline.md#sub-step-tracking) for details.

---

## Measurement Accuracy Notes

### Variance Sources
- **System load** — Background processes affect timing ±50ms
- **Disk cache** — First run may be slower; warm cache improves ±30ms
- **Node.js JIT** — First execution slower; subsequent runs faster ±20ms
- **esbuild cache** — File-based cache improves transpile speed ±30ms

### Best Practices
1. **Take 3 measurements**, use middle value to avoid outliers
2. **Run on quiet system** if possible
3. **Test both cold and incremental** — regressions may only appear in one
4. **Compare on same hardware** — CPU matters for build speed

---

## Historical Performance Log

See [performance-measurements.json](./performance-measurements.json) for detailed measurement history:
- Dates and environments of all tests
- Phase breakdown for each measurement
- Speedup calculations
- Regression status

Add new measurements here when:
- Creating a new tsbuild release
- After significant optimization work
- If suspicious of regression

---

Future enhancement: Could add performance test to CI:

```typescript
// vitest performance test (sketch)
it('build completes in acceptable time', async () => {
  const start = performance.now();
  await new TypeScriptProject('.').build();
  const elapsed = performance.now() - start;

  // Warn if >20% slower than baseline
  expect(elapsed).toBeLessThan(528 * 1.2);
});
```

Currently **not implemented** — performance tests still manual.

---

## Questions?

- **General performance approach** → See [performance-baseline.md](./performance-baseline.md)
- **How decorators work** → See [src/decorators/performance-logger.ts](../src/decorators/performance-logger.ts)
- **What phases run** → See [src/type-script-project.ts](../src/type-script-project.ts) build() method
- **Historical data** → See [performance-measurements.json](./performance-measurements.json)
