# Build Architecture

## Public Boundary

[TypeScriptProject](../src/type-script-project.ts) remains the public project API.
Its constructor, `build()`, `clean()`, `close()`, and async disposal
coordinate internal components without exposing them through package exports.
[The CLI](../src/tsbuild.ts) loads the project dynamically after handling help
and version requests. Internal modules must not add compiler loading to those
short paths.

The CLI applies `--noEmit` through constructor compiler options and calls
`build()` without an argument. Configuration is already resolved at that point,
so `build()` reads the merged `compilerOptions.noEmit` without a per-call override.
Check-only builds share diagnostics, error handling and shutdown tracking with
emitting builds, but skip output-path validation, artifact checks, cleaning and
bundling. The compiler options participate in the cache fingerprint and input
manifest key, keeping check-only and emitting configurations distinct.
`build()` returns the project for `await using` outside watch mode, or `null`
to keep a watch project alive. Watch rebuilds read the same resolved configuration;
changing emission mode or reloading configuration requires a new project instance.

## Ownership

| Module | Owns |
| --- | --- |
| [Configuration](../src/project/configuration.ts) | JSON key validation, option precedence, platform inference, resolved configuration and cache construction |
| [Diagnostics](../src/project/diagnostics.ts) | Diagnostic deduplication, formatting, summaries and type-check errors |
| [Entry points](../src/entry-points.ts) | Package inference, normalization, filesystem expansion and rename updates |
| [Output paths](../src/project/output-paths.ts) | Canonical output safety checks and cached protected inputs; no deletion |
| [Build fingerprint](../src/project/build-fingerprint.ts) | Deterministic serialization of the existing output-affecting options |
| [Compilation context](../src/project/compilation-context.ts) | Incremental compiler state, source-file identity cache, dependency snapshots and diagnostics |
| [esbuild runner](../src/project/esbuild-runner.ts) | esbuild options, plugin scopes, output collection and reusable context |
| [Project watcher](../src/watch/project-watcher.ts) | Watchr targets, ignore policy, readiness, reconciliation and observation shutdown |
| [Rebuild queue](../src/watch/rebuild-queue.ts) | Event deduplication, versions, content snapshots, rename suppression and serial dispatch |
| [File manager](../src/file-manager.ts) | Declaration emission buffers, preprocessing, output writes and cache handoff |
| [Incremental cache](../src/incremental-build-cache.ts) | Persistent declarations, fingerprints and expected-output metadata |

The project owns build decisions, phase ordering, the mutable entry-point map,
source/plugin event eligibility, exit-code handling and resource shutdown.
Components do not import the project or share a mutable project-state object.
Compiler dependency sets are read-only snapshots; rename application copies a
snapshot once per batch before updating it.

## Build Ordering

Built-in performance labels are defined by `PerformancePhase` in
[constants](../src/constants.ts). Instrumentation, report phase lookup and tests
use these constants so changing a display label requires only one edit.
`Transpile` measures the esbuild output phase; it runs alongside
`Process Declarations` under `Bundle` and supplies the report's JavaScript outputs.

1. Resolve configuration and invalidate a forced or cleared cache before
   constructing the compiler session, which can read TypeScript build info.
2. Validate output paths and decide whether artifacts need rebuilding.
3. Initialize the file manager before TypeScript diagnostics and emission;
   finalize emission before considering downstream phases.
4. When required, clean the validated output directory, then process declarations
   and transpile independently using `Promise.allSettled`.
5. Invalidate cache state on phase failure. Otherwise record written artifacts
   and persist cache data after the parallel phases settle.
6. In watch mode, refresh dependencies from the current compiler program and
   reconcile watcher targets even after a failed build.

The project retains detached declaration-bundler syntax trees only for current
project declaration paths and exact preprocessed text. This bounded cache avoids
re-parsing unchanged declarations across watch rebuilds; each bundler still
resolves imports and reads external declarations per build. Project shutdown
clears the syntax cache after active builds and cleanup have drained.

Plugin ordering remains IIFE, external-module handling, user plugins, then
output writing. Plugin scopes remain active through esbuild completion, including
`onEnd`; dependency snapshots are collected on success and failure. Reusable
esbuild contexts are limited to watch builds without IIFE or user plugins.

## Watch And Shutdown

The watcher forwards eligible events to the rebuild queue. The queue filters
metadata/content churn and awaits one project rebuild callback at a time. That
callback invalidates changed compiler sources, applies entry/root-name changes,
recreates the compiler builder using the previous builder, and runs `build()`.
`markApplied()` acknowledges rename or root-unlink changes at the point where
their content state was previously updated inside the project.

`close()` returns the same promise for repeated calls. It stops queue dispatch
and observation immediately, waits for active build completion, then asynchronously
disposes the file manager and esbuild runner in parallel. The project resource
stack owns the watcher and queue; after the asynchronous cleanup settles it
disposes them and the compiler context. Queue disposal cancels timers and clears
retained state but does not await an already-started callback or file read.
Timeout reporting does not cancel already-running I/O or release retained state
before that cleanup settles. The file manager's synchronous `close()` remains a
best-effort process-exit fallback; its `AsyncDisposable` contract waits for cache
writes and releases declaration buffers afterward.

Synchronous stack disposal is included in the shared shutdown outcome and happens
even when asynchronous cleanup fails. If both fail, the first asynchronous
cleanup failure retains precedence; synchronous disposal errors are otherwise
reported by `close()`, not an unobserved side promise.

The logged `Build` measure covers `build()` only. Constructor/configuration and
`close()` are separate costs. Cache persistence is scheduled after output phases
and may still be pending when `build()` resolves; it is drained by `close()`.
End-to-end CLI timing must also include module/process startup and final exit.

Declaration output validation and artifact existence checks submit at most 64
checks at a time. A submitted batch is fully drained, with false/error results
examined in input order before any later batch starts. This preserves the first
failure while allowing later paths in the same batch to perform read-only I/O.
Canonicalization is not skipped or cached for output paths. Protected-input
canonicalization remains shared per validator. The cache checks its current
artifact set (including outputs saved during this project lifetime) on every
build, so missing outputs still force regeneration.

[Process manager](../src/process-manager.ts) owns process listeners through a
`DisposableStack`. Its `close()` and `[Symbol.dispose]()` detach those listeners
and release registrations without closing registered resources. Process shutdown
separately starts all registered cleanup before awaiting completion, retaining
individual unregistration and per-resource error reporting. SIGINT waits up to
five seconds before exiting with code 0; the Node.js `exit` event is only a
synchronous fallback and cannot await asynchronous cleanup.

The extraction includes three shutdown safeguards: a context created during an
active build is disposed after that build; a closed watcher cannot restart after
its dynamic import; and hash reads settling after queue stop cannot schedule
rebuilds, repopulate content state or rearm timers. Queue stop does not cancel
an already-started rebuild callback or an operating-system file read.

### Resource measurement and deployment guidance

Keep Node/libuv and Go runtime concurrency defaults unless measurements of the
deployment workload justify an external limit. `GOMAXPROCS` affects both native
TypeScript and esbuild, not just the compiler. A lower value can reduce live
thread counts without reducing RSS, and can slow individual builds. More libuv
threads are not a remedy for synchronous compiler RPC stalls. Compare repeated,
interleaved single-project and concurrent-project runs before choosing a cap;
tsbuild does not change global thread settings.

For watch memory investigations, sample the entire process tree (Node, native
TypeScript and esbuild), recording simultaneous RSS and live thread counts.
Per-process peaks need not occur together and must not be added as a tree peak.
Record Node heap, external memory and ArrayBuffers separately. RSS growth alone
does not demonstrate a leak: runtime warm-up, allocator high-water marks and
uncollected garbage can all raise it.

Check many real edits, signature changes and source add/delete/rename/re-add
cycles, verifying both JavaScript and declarations after each build. Confirm
that syntax-cache paths track current declarations, replaced texts do not
accumulate, parse leases are released, old snapshots are disposed and project
shutdown clears the cache. A separate forced-GC diagnostic can distinguish live
Node retention from garbage, but forced GC is not a production optimization.
Native allocation attribution requires additional native tooling; a stable
Node heap does not prove native heaps are leak-free. Await `close()` before
assessing disposal, including after asynchronous cleanup errors; a timeout
reports incomplete cleanup rather than authorizing early resource release.

## Tests And Change Boundaries

Direct component tests live under `tests/project/` and `tests/watch/`.
[Project tests](../tests/type-script-project.test.ts) retain public lifecycle
coverage; [watch integration tests](../tests/integration/watch-mode.test.ts)
retain real compiler, filesystem and plugin interactions. Mock external
boundaries rather than internal component methods when adding focused tests.

Run focused tests after each ownership change, followed by `pnpm type-check`,
`pnpm lint`, `pnpm test:coverage`, and `pnpm build` for broad changes. Built CLI
smokes must inspect actual diagnostics as well as exit codes. The coverage
target remains 100%; passing tests alone does not demonstrate that target.

Keep cache formats, fingerprint serialization, compiler overrides, plugin order,
and public exports stable during structural refactors. Treat DTS bundler
decomposition, relocation of existing global types, and changes to scheduling
algorithms as separate work. Reverse only the relevant extraction changes when
rolling back; preserve unrelated worktree edits.