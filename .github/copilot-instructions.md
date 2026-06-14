# tsbuild - AI Coding Agent Instructions

## One-Screen Rules
- Prioritize correctness, clarity, and performance; choose the simplest solution that works.
- Strict ESM only (no CommonJS).
- No `any`, no unnecessary line wrapping, preserve existing formatting.
- Use branded types and JSDoc on exported APIs.
- Ask clarifying questions until requirements/constraints are unambiguous.
- Do not commit unless explicitly instructed.

## Project Snapshot
- `tsbuild` = TypeScript type-check + `.d.ts` emit, esbuild bundling, optional SWC decorator metadata.
- Runtime/tooling: Node 22+, pnpm 10+.
- Build pipeline: type-check -> transpile -> declaration bundle.

## Core Architecture
- `TypeScriptProject`: build orchestrator; decorators `@closeOnExit`, `@logPerformance`, `@debounce`; incremental via `.tsbuildinfo`.
- `FileManager`: in-memory `.d.ts` store + write callback; declaration pre-processing.
- `IncrementalBuildCache`: persistent Brotli declaration cache at `.tsbuild/dts_cache.v8.br`.
- DTS bundler (`src/dts/`): TypeScript AST + `magic-string` (not Rollup/ESTree), dependency graph + topo sort, import/export stripping, identifier collision handling, per-instance resolution cache, `collectIdentifiers` WeakMap cache.
- Plugins (`src/plugins/`):
  - `external-modules.ts`: bare specifiers external by default; `noExternal` forces bundling.
  - `output.ts`: applies `0o755` to shebang entry outputs.
  - `decorator-metadata.ts`: lazy-loads SWC only when `emitDecoratorMetadata: true`; throws helpful error if `@swc/core` is missing.
  - `resolve-plugin.ts`, `iife.ts`: resolution/format behavior.

## Behavioral Invariants
- `FileManager.initialize()` restores cache before emission; `finalize()` persists after.
- Watch rebuilds clear/repopulate `buildDependencies` before error checks (prevents leaks on failures).
- `processDeclarations()` and `transpile()` run in parallel and are independent.
- esbuild plugin registration order is significant.
- `compilerOptionOverrides` in `src/constants.ts` are intentional and high-risk to change.

## Config, CLI, Errors
- Config source: `tsbuild` in `tsconfig.json`, validated by `schema.json`.
- Defaults/features: `clean: true`; `env` supports `${process.env.VAR}` -> `import.meta.env.*`; platform auto-detected from `lib`.
- CLI parser: kebab-case -> camelCase via `parseArgs`.
- Supported options: `-h/--help`, `-v/--version`, `-f/--force`, `-w/--watch`, `-p/--project`, `-n/--noEmit`, `-c/--clearCache`, `-m/--minify`.
- Error formatting: TS via `formatDiagnosticsWithColorAndContext()`, esbuild via `formatMessages()`.
- Never call `process.exit()` directly; use `ProcessManager`.
- Exit behavior: build/type-check 1, bundle 2, config 3, uncaught 99, SIGINT 130.

## Testing & Quality Bar
- Test public contracts; only mock external boundaries.
- File-system tests use `memfs`.
- Plugin tests: mock esbuild with `vi.fn()` and test callbacks directly.
- Coverage target: 100%; excluded from coverage: `src/@types/**`, `src/dts/@types/**`, `src/index.ts`, `src/dts/index.ts`.
- Vitest pool: `vmForks`.
- Standard verification commands: `pnpm type-check`, `pnpm lint`, `pnpm test`, `pnpm build`.

## TS/Build Conventions
- Enabled TS options include `isolatedDeclarations`, `isolatedModules`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions`.
- Repo layout: `src/` + mirrored `tests/`.
- Shared utilities: `Files`, `Paths`, `Json`, `Logger`, `TextFormat`.

## Commits (Only When Asked)
- Conventional Commits: `type(scope): lowercase description`.
- Release-impacting: `feat`, `fix`, `refactor`, `perf`, `revert`.
- Other allowed: `docs`, `style`, `test`, `build`, `ci`, `chore`.
- Use `!` for breaking changes; keep related changes grouped; commit body uses real newline-separated bullets (no escaped `\n`).