# tsbuild - AI Coding Agent Instructions

> **Note**: All AI coding agents working on this project must also read and follow the guidelines in `AGENTS.md`, which defines core principles, coding standards, testing protocols, and workflow requirements.

## Project Overview
tsbuild is a self-hosting TypeScript build tool that combines three systems: **TypeScript API** (type checking + declarations), **esbuild** (bundling), and **SWC** (decorator metadata). **ESM-only by design** - no CommonJS support. Targets Node.js 20.16.0+ with pnpm 9+.

## Core Architecture

### The Big Picture
tsbuild orchestrates a three-phase build process:

1. **Type Checking Phase** - TypeScript compiler validates types and emits `.d.ts` files into memory (not disk)
2. **Transpile Phase** - esbuild bundles JavaScript with custom plugins for module resolution and output formatting
3. **DTS Bundle Phase** - Custom minimal bundler combines declaration files through dependency graph traversal and AST transformation

The separation of concerns is critical: TypeScript handles correctness, esbuild handles speed, and the custom bundler handles declaration consolidation without creating duplicate TypeScript Programs.

### Key Components

**`TypeScriptProject`** (`src/type-script-project.ts`) - Central orchestrator
- Uses `@closeOnExit`, `@logPerformance`, and `@debounce` decorators for lifecycle management
- Maintains in-memory declaration cache via `FileManager`
- Supports incremental builds with `.tsbuildinfo` persistence
- Critical override: `compilerOptionOverrides` in `constants.ts` forces specific TS compiler behavior
- **Watch Mode**: Tracks dependencies in `buildDependencies` Set with proper cleanup on rebuild

**`FileManager`** (`src/file-manager.ts`) - In-memory `.d.ts` storage
- Uses `Map<string, string>` to avoid disk I/O during compilation
- Supports serialization/restoration for incremental builds via `IncrementalBuildCache`
- Pre-processes declarations with `DeclarationProcessor` for cleaner output
- Provides `fileWriter` callback for TypeScript's `program.emit()`

**`IncrementalBuildCache`** (`src/incremental-build-cache.ts`) - Persistent cache for incremental builds
- Handles Brotli-compressed cache storage at `.tsbuild/dts_cache.v8.br`
- Cache invalidation relies on TypeScript's incremental compilation - TypeScript re-emits only changed files, which overwrite cached entries

**Plugin System** (`src/plugins/`)
- `external-modules.ts` - Pattern-based external resolution. Bare specifiers (e.g., `lodash`) default to external; use `noExternal` array to force bundling
- `output.ts` - Sets executable permissions (0o755) for CLI entry points with shebang (`#!/usr/bin/env node`)
- `decorator-metadata.ts` - Optional SWC transform when `emitDecoratorMetadata: true` (requires `@swc/core`)
- **Plugin Order**: esbuild runs plugin hooks in registration order; order matters when multiple plugins register the same hook type (e.g., `onResolve`).

**DTS Bundling System** (`src/dts/`)
Custom minimal bundler that avoids Rollup dependency:
1. **Module Graph Building** (`declaration-bundler.ts`) - Traverses import/export statements to build dependency graph, resolving module specifiers using TypeScript's resolution algorithm
2. **Dependency Sorting** - Topologically sorts modules to ensure declarations appear in correct order
3. **Code Combination** - Strips imports/exports while preserving external references and re-exports used symbols
4. **Pre/Post Processing** (`declaration-processor.ts`) - Cleans up triple-slash directives, splits compound declarations, fixes modifiers, and normalizes exports
The bundler works entirely with in-memory declaration files, avoiding duplicate TypeScript Program creation.

**Bundler Features**:
- WeakMap caching for `collectIdentifiers` results to avoid re-parsing same SourceFiles
- Module resolution cache per bundler instance
- Identifier rename tracking to handle name collisions across modules

**Decorator System** (`src/decorators/`)
- `@closeOnExit` - Auto-registers instances with `ProcessManager` for cleanup on exit/SIGINT
- `@logPerformance` - Wraps async methods with performance timing using Node.js Performance API
- `@debounce` - Rate-limits method calls (used for watch mode rebuild triggering)
- Applied to `TypeScriptProject` and related classes

**Error System** (`src/errors.ts`) - Custom error classes with exit codes
- `BuildError` (base class, exit code 1)
- `TypeCheckError` (exit code 1, includes diagnostics)
- `BundleError` (exit code 2)
- `ConfigurationError` (exit code 3)
- `UnsupportedSyntaxError` (for DTS processing)

**ProcessManager** (`src/process-manager.ts`) - Global cleanup coordinator
- Handles SIGINT with exit code 130 (standard Unix convention)
- Calls `close()` on all registered `Closable` instances
- Single global instance exported as `processManager`
- Handles uncaught exceptions with exit code 99

## Critical Development Patterns

### Configuration
- Build config lives in `tsconfig.json` under `tsbuild` property (validated against `schema.json`)
- Supports a single `tsbuild` configuration object
- Entry points can be objects `{ name: path }` or will auto-expand directories
- Platform is auto-detected from `lib` setting (DOM = browser, no DOM = node)
- `clean` option defaults to `true` (removes output directory contents before building)
- Example from project's `tsconfig.json`:
  ```json
  "tsbuild": {
    "entryPoints": { "tsbuild": "./src/tsbuild.ts", "index": "./src/index.ts" },
    "env": { "tsbuild_version": "${process.env.npm_package_version}" }
  }
  ```

### Environment Variable Expansion
The `env` configuration option supports `${process.env.VAR}` syntax for injecting environment variables at build time, which become `import.meta.env.*` values in the output.

### Custom `fileWriter` Callback Pattern
`FileManager` provides a `fileWriter` method used as TypeScript's `WriteFileCallback`:
- Allows `.tsbuildinfo` files through to disk (for incremental compilation)
- Captures all `.d.ts` files to in-memory Map
- See `typeCheckAndEmit()` method for usage

### Incremental Build Cache Strategy
- `FileManager.initialize()` restores cache BEFORE emission
- TypeScript's incremental compilation only re-emits changed files
- Changed files overwrite cached entries; unchanged files remain valid
- `FileManager.finalize()` saves updated cache after emission
- Cache is Brotli-compressed for efficiency

### Plugin Testing Pattern
Mock esbuild APIs with Vitest's `vi.fn()`:
```typescript
const mockBuild = {
  onResolve: vi.fn((options, callback) => {
    expect(options.filter).toEqual(/.*/);
    onResolveCallback = callback;
  }),
} as any;
plugin.setup(mockBuild);
```
Then test the callback directly. See `tests/external-modules.test.ts` for examples.
For declaration bundling tests, use `memfs` to mock the file system and provide in-memory declaration files to the bundler.

### Error Handling
- **TypeScript diagnostics**: Use `formatDiagnosticsWithColorAndContext()` with custom `FormatDiagnosticsHost`
- **esbuild errors**: Use `formatMessages()` API with `kind: 'error'` and `color: true`
- **Process cleanup**: All cleanup goes through `ProcessManager` - never use `process.exit()` directly in classes
- **Error casting**: Use `castError()` utility to safely convert unknown exceptions to Error objects

## Development Workflows

### Build Commands
- `pnpm build` - Self-hosting build (uses tsx to run source)
- `pnpm build:watch` - Watch mode
- `pnpm type-check` - Type checking only (no bundling)
- `pnpm test` / `pnpm test:coverage` - Vitest with coverage
- `pnpm lint` - ESLint on source files

### Testing Strategy
- Vitest with `pool: 'vmForks'` and Node environment
- Coverage excludes type definitions: `src/@types/**`, `src/dts/@types/**`, `src/index.ts`, `src/dts/index.ts`
- Mock external dependencies only (TypeScript API, esbuild, fs operations)
- Test files mirror source structure in `tests/`
- Integration tests in `tests/integration/` for full build scenarios

### Watch Mode Behavior
File watching uses `Watchr` with debounced rebuild logic:
- Tracks build dependencies in `buildDependencies` Set
- Only rebuilds when tracked files change (ignores zero-byte file events)
- **Memory Safety**: `buildDependencies.clear()` is called BEFORE populating with new inputs on each build
- Recreates TypeScript `Program` with updated root files
- Uses `createIncrementalProgram` for incremental compilation
- Pending changes are batched and processed together with `@debounce(100)`

## Project-Specific Conventions

### Type Safety
- Strict TypeScript with `isolatedDeclarations` enabled
- `isolatedModules: true` ensures files are independently compilable
- `verbatimModuleSyntax: true` preserves import/export statements
- `rewriteRelativeImportExtensions: true` handles `.ts` → `.js` import rewrites
- Use `.js` extensions for relative imports in source (ESM-only)
- Branded types for paths: `AbsolutePath`, `RelativePath`, `Path`
- JSDoc required for all exported APIs

### File Organization
- Source in `src/`, tests in `tests/` (mirrored structure)
- Type definitions in dedicated `@types/` directories (excluded from coverage)
- DTS-specific types in `src/dts/@types/index.ts`
- Plugin files have clear names: `external-modules.ts`, `decorator-metadata.ts`, `output.ts`

### Code Style
- Use `magic-string` for AST transformations (preserves source positions)
- Resource cleanup via decorator pattern (`@closeOnExit`)
- Performance measurement on async operations (`@logPerformance`)
- Debouncing for rate-limited operations (`@debounce`)
- Exit codes: 1-4 (build errors by type), 130 (SIGINT), 99 (uncaught exception)

### External Module Resolution
- Bare specifiers (no `.`, `/`, or `C:\` prefix) default to external
- Use `noExternal` array in config to force bundling specific packages
- `dependencies` option in `externalModulesPlugin` forces external for patterns
- See `nonNodeModule` regex in `external-modules.ts`

### Utility Classes
- `Files` (`src/files.ts`) - Async file operations with Brotli compression support
- `Paths` (`src/paths.ts`) - Branded path manipulation utilities
- `Json` (`src/json.ts`) - Type-safe JSON parsing and serialization
- `Logger` (`src/logger.ts`) - Colorized console output with formatting
- `TextFormat` (`src/text-formatter.ts`) - ANSI color formatting

## Common Pitfalls

1. **Watch mode dependency tracking** - `buildDependencies` Set is cleared and repopulated on each build to prevent memory leaks. This happens BEFORE error checking to ensure cleanup even on failed builds.

2. **Compiler options are merged, not replaced** - `compilerOptionOverrides` in `constants.ts` forces specific values that override user config. Don't modify these without understanding why they exist.

3. **esbuild plugins run in order** - Order matters when multiple plugins register the same hook type (e.g., `onResolve`).


4. **Custom DTS bundler doesn't use Rollup** - The bundler works directly with TypeScript AST via `ts.createSourceFile()` and uses `magic-string` for efficient code manipulation. No ESTree conversion needed.

5. **FileManager vs IncrementalBuildCache** - `FileManager` handles in-memory storage and file writing; `IncrementalBuildCache` handles persistent Brotli-compressed storage for incremental builds. They work together but have distinct responsibilities.

6. **Parallel processing** - `processDeclarations()` and `transpile()` run in parallel. Both are designed to be independent.

7. **CLI argument handling** - Uses Node.js `parseArgs` with kebab-case to camelCase conversion. Boolean flags are supported; no `--no-` prefix negation. Available CLI options:
   - `-h, --help` - Show help message
   - `-v, --version` - Show version number
   - `-f, --force` - Force a full rebuild (bypasses incremental cache)
   - `-w, --watch` - Watch for changes and rebuild
   - `-p, --project` - Project directory (defaults to current directory)
   - `-n, --noEmit` - Type-check only (no output files)
   - `-c, --clearCache` - Clear the .tsbuild cache before building
   - `-m, --minify` - Minify the output

8. **SWC is lazy-loaded** - The `decorator-metadata.ts` plugin is only imported when `emitDecoratorMetadata: true`. If `@swc/core` is not installed, a helpful error message is thrown.

## Performance Notes

1. **`collectIdentifiers` caching** - Uses WeakMap to cache results keyed by SourceFile objects
2. **Module resolution caching** - Bundler caches resolved module paths per instance
3. **Brotli compression** - Cache files use Brotli for efficient storage
4. **Lazy loading** - SWC is only imported when decorator metadata is needed

## Testing Gaps to Consider

1. **Cache restoration edge cases** - Corrupted cache files, cache format version mismatches
2. **Error recovery in watch mode** - Build failures followed by successful builds
3. **Path edge cases** - Symlinks, case sensitivity, Windows paths

When extending tsbuild, prioritize the plugin architecture for new features, use decorators for cross-cutting concerns, and maintain the clear separation between the three build systems. Always consider the in-memory architecture and avoid unnecessary disk I/O.