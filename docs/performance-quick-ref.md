# Performance Monitoring Quick Reference

**For:** tsbuild development team
**Purpose:** Quick checks for performance regressions
**Last Updated:** 2026-09-05

---

## Baseline Snapshot

| Scenario | Time | Status | Notes |
|----------|------|--------|-------|
| Cold build, 120 modules | **594ms median** | ✓ Measured | 7 samples |
| Warm no-op, 300 modules | **496ms median** | ✓ Measured | Includes fresh CLI startup |
| One-file rebuild, 120 modules | **577ms median** | ✓ Measured | 7.2% CV |
| CLI `--help` | **20.3ms median** | ✓ Measured | 9 samples |
| CLI `--version` | **19.6ms median** | ✓ Measured | 9 samples |
| Watch rebuild | Not established | Deferred | Needs a dedicated latency harness |

**Regression Threshold:** Investigate repeatable regressions outside measured sample variability.

---

## How to Test

### Cold Build
```bash
rm -rf .tsbuild dist
pnpm build
# Compare against the current environment; historical synthetic median is 594ms.
```

### Incremental Build (No Changes)
```bash
pnpm build
# Compare against the current environment; fresh CLI startup dominates this measurement.
```

### Incremental Build (With Changes)
```bash
echo "// Change" >> src/logger.ts
pnpm build
git checkout src/logger.ts
# Compare against the current environment; historical synthetic median is 577ms.
```

### Watch Mode Rebuild
```bash
pnpm build:watch
# In another terminal:
echo "// Change" >> src/type-script-project.ts
# No baseline is currently established for watch latency.
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
These areas are candidates for investigation only when profiling shows material cost:

1. **Declaration bundling**
   - Module graph traversal in `declaration-bundler.ts`
   - Opportunity: Profile with large declaration trees

2. **TypeScript emit and checking**
   - This is TypeScript's own emit cost — mostly unavoidable
   - Opportunity: Test with smaller projects to establish baseline scaling

3. **Transpile/plugin pipeline**
   - esbuild + plugins (external modules, SWC decorator metadata, custom resolve)
   - Opportunity: Measure per-plugin cost breakdown

### Regression Red Flags
Stop and investigate if you see:

- Repeatable regression outside measured sample variability
- Missing expected output after a warm no-op build
- Cache invalidation that forces unnecessary full work
- A phase whose cost grows unexpectedly with project size

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
✓ Type-checking/Emit (time)      ← Unified TypeScript phase
✓ Transpile (time)               ← esbuild phase
✓ Bundle Declarations (time)     ← Declaration phase
────────────────────────────────────
✓ Completed in (time)             ← Grand total
```

**Key Insight:** Type-checking/Emit is a unified measurement; diagnostics and emit are not logged as separate sub-steps.

---

## Measurement Accuracy Notes

### Variance Sources
- **System load** — Background processes affect timing ±50ms
- **Disk cache** — First run may be slower; warm cache improves ±30ms
- **Node.js JIT** — First execution slower; subsequent runs faster ±20ms
- **esbuild cache** — File-based cache improves transpile speed ±30ms

### Best Practices
1. Take repeated measurements and report median plus p95 when possible
2. **Run on quiet system** if possible
3. Test cold, warm no-op, changed-file, and multi-entry workloads
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

// Compare repeated runs against a versioned baseline instead of a fixed local SLA.
});
```

Currently **not implemented** — performance tests still manual.

---

## Questions?

- **General performance approach** → See [performance-baseline.md](./performance-baseline.md)
- **How decorators work** → See [src/decorators/performance-logger.ts](../src/decorators/performance-logger.ts)
- **What phases run** → See [src/type-script-project.ts](../src/type-script-project.ts) build() method
- **Historical data** → See [performance-measurements.json](./performance-measurements.json)
