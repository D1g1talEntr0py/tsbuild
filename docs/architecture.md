# Build Architecture

## Public Boundary

[TypeScriptProject](../src/type-script-project.ts) remains the public project API.
Its constructor, `build()`, `clean()`, `isWatchMode`, `close()`, and async disposal
coordinate internal components without exposing them through package exports.
[The CLI](../src/tsbuild.ts) loads the project dynamically after handling help
and version requests. Internal modules must not add compiler loading to those
short paths.

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
and observation immediately, waits for active build completion, then flushes
file-manager I/O and disposes the esbuild runner. Retained state clears after
cleanup settles. Timeout reporting does not cancel already-running I/O.

The extraction includes three shutdown safeguards: a context created during an
active build is disposed after that build; a closed watcher cannot restart after
its dynamic import; and hash reads settling after queue stop cannot schedule
rebuilds, repopulate content state or rearm timers. Queue stop does not cancel
an already-started rebuild callback or an operating-system file read.

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