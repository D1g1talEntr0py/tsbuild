# tsbuild

[![npm version](https://img.shields.io/npm/v/@d1g1tal/tsbuild?color=blue)](https://www.npmjs.com/package/@d1g1tal/tsbuild)
[![npm downloads](https://img.shields.io/npm/dm/@d1g1tal/tsbuild)](https://www.npmjs.com/package/@d1g1tal/tsbuild)
[![CI](https://github.com/D1g1talEntr0py/tsbuild/actions/workflows/ci.yml/badge.svg)](https://github.com/D1g1talEntr0py/tsbuild/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/D1g1talEntr0py/tsbuild/graph/badge.svg)](https://codecov.io/gh/D1g1talEntr0py/tsbuild)
[![License: MIT](https://img.shields.io/github/license/D1g1talEntr0py/tsbuild)](https://github.com/D1g1talEntr0py/tsbuild/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/@d1g1tal/tsbuild)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A TypeScript build tool that combines three tools into one workflow: **TypeScript's type system** for correctness, **esbuild** for speed, and **SWC** for legacy decorator metadata (optional, not installed by default). Built for modern ESM-only projects on Node.js 20.16.0+.

TC39 standard decorators are supported natively — no additional dependencies needed. SWC is only required if you are still using `experimentalDecorators` with `emitDecoratorMetadata`.

> **Note:** This is a personal project I built for my own use and decided to share. It works well for me, but it's not battle-hardened for every setup. If you need something production-proven, [tsup](https://tsup.egoist.dev/) is excellent, or take a look at the newer [tsdown](https://tsdown.dev/) by [void(0)](https://voidzero.dev/).

## Features

- 🚀 **Blazing Fast** - Leverages esbuild for rapid bundling and transpilation
- 🔍 **Full Type Safety** - Uses TypeScript API for comprehensive type checking
- 📦 **Declaration Bundling** - Automatically bundles `.d.ts` files into single entry points
- ⚡ **Incremental Builds** - Intelligent caching with `.tsbuildinfo` for fast rebuilds
- 👁️ **Watch Mode** - File watching with automatic rebuilds on changes
- 🎨 **TC39 Decorators** - Native support for standard decorators, no extra dependencies required
- 🔧 **Legacy Decorator Metadata** - Optional SWC integration for `emitDecoratorMetadata` when using `experimentalDecorators` (install `@swc/core` separately)
- 🔌 **Plugin System** - Extensible architecture with custom esbuild plugins
- 🎯 **ESM-Only** - Pure ESM project with no CommonJS support by design
- 🧹 **Clean Builds** - Optional output directory cleaning before builds
- 📊 **Performance Metrics** - Built-in performance logging with detailed timing information
- 🔎 **Zero-Config Entry Points** - Auto-infers entry points from `package.json` when none are configured

## Why tsbuild?

Most TypeScript build setups involve a compromise: use `tsc` alone and lose bundling speed, or use esbuild/swc alone and lose accurate type checking and declaration generation. tsbuild aims to give you both by running each tool for what it's actually good at.

The build runs in two phases:

1. **Type Checking** - TypeScript validates types and, if `declaration` is enabled, captures `.d.ts` files into memory (no disk I/O)
2. **Output** - Once type checking completes, two things happen in parallel:
   - esbuild transpiles and bundles the JavaScript
   - If declarations were captured in phase 1, a custom bundler consolidates the `.d.ts` files into final entry points

If `declaration` is not enabled, phase 2 is just the esbuild step.

## Quick Start

The only thing tsbuild requires in `tsconfig.json` is an `outDir`. Everything else carries over from your existing config.

### Minimal config — no `tsbuild` section needed

```jsonc
{
  "compilerOptions": {
    "outDir": "./dist"
    // ... your existing TypeScript config
  }
}
```

Entry points are inferred from `package.json` automatically, and all dependencies are treated as external by default.

### Bundle a specific package into the output

By default, bare specifiers (e.g. `lodash-es`) are kept as external imports. Use `noExternal` to force a package to be inlined into the bundle:

```jsonc
{
  "compilerOptions": {
    "outDir": "./dist"
    // ... your existing TypeScript config
  },
  "tsbuild": {
    "noExternal": ["evicting-cache"]  // bundle evicting-cache into the output instead of leaving it as an import
  }
}
```

### Preferred `tsconfig.json` setup — incremental (recommended)

`incremental` defaults to `true` in tsbuild unless you explicitly set it to `false` in your `tsconfig.json`. With incremental enabled, TypeScript only re-emits changed files on each build and the declaration cache is preserved across runs, making repeated builds significantly faster.

```jsonc
{
  "compilerOptions": {
    "outDir": "./dist",
    "declaration": true,
    "incremental": true,           // redundant — tsbuild enables this by default, but explicit is clear
    "isolatedDeclarations": true,  // recommended: enables faster parallel declaration emit
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler", // recommended for library builds processed by a bundler
    // lib controls platform detection — omitting "DOM" targets Node.js (platform: "node").
    // Add "DOM" to target the browser (platform: "browser").
    "lib": ["ESNext"]             // Node.js library — no DOM APIs
    // "lib": ["ESNext", "DOM"]   // Browser library — includes DOM APIs, sets platform to "browser"
  }
}
```

### Preferred `tsconfig.json` setup — non-incremental

Set `incremental: false` to opt out of the `.tsbuildinfo` cache entirely. Every build is a full compilation from scratch. Useful for CI environments where you want deterministic, cache-free output.

```jsonc
{
  "compilerOptions": {
    "outDir": "./dist",
    "declaration": true,
    "incremental": false,          // disables TypeScript's .tsbuildinfo cache and tsbuild's DTS cache
    "isolatedDeclarations": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler", // recommended for library builds processed by a bundler
    // lib controls platform detection — omitting "DOM" targets Node.js (platform: "node").
    // Add "DOM" to target the browser (platform: "browser").
    "lib": ["ESNext"]             // Node.js library — no DOM APIs
    // "lib": ["ESNext", "DOM"]   // Browser library — includes DOM APIs, sets platform to "browser"
  }
}
```

Then, if tsbuild is installed globally:

```bash
tsbuild
```

Or if installed locally as a dev dependency, add a script to `package.json` and run it:

```json
{ "scripts": { "build": "tsbuild" } }
```

```bash
pnpm build
```

That's it. tsbuild reads your `compilerOptions`, infers entry points from your `package.json`, and builds. See [Configuration Options](#configuration-options) for everything you can customise.

## Installation

### Global Installation (Recommended for CLI usage)

Installing globally makes the `tsbuild` command available in your terminal across all projects:

```bash
# pnpm
pnpm add -g @d1g1tal/tsbuild

# npm
npm install -g @d1g1tal/tsbuild
```

With a global install, your projects can use `tsbuild` in `package.json` scripts without adding it as a dependency.

### Local Installation (Per-project)

Install as a dev dependency for per-project version pinning (recommended for CI/CD environments):

```bash
# pnpm
pnpm add -D @d1g1tal/tsbuild

# npm
npm install -D @d1g1tal/tsbuild

# yarn
yarn add -D @d1g1tal/tsbuild
```

`@swc/core` is **not a dependency** and will never be installed automatically. It is only needed if you use `experimentalDecorators` with `emitDecoratorMetadata` — see [Decorator Metadata](#decorator-metadata) for details.

> **Note:** When installed only as a local dev dependency, the `tsbuild` command is not available directly in your terminal. Use it through `package.json` scripts (e.g., `pnpm build`) or invoke it explicitly with `pnpm exec tsbuild` / `npx tsbuild`.

### Requirements

- **Node.js**: >=20.16.0
- **pnpm**: >=9.0.0

## Usage

### Configuration

#### Your tsconfig.json Does the Heavy Lifting

Because tsbuild uses the TypeScript compiler API directly, it reads your `compilerOptions` automatically. There is no need to re-declare `target`, `module`, `lib`, `strict`, `paths`, `moduleResolution`, `baseUrl`, or any other TypeScript settings in a separate config — they are already in your `tsconfig.json`, and tsbuild honours them as-is.

The `tsbuild` section only covers options that don't belong in `compilerOptions`: bundling behaviour, entry points, watch mode, output formatting, and similar build-specific settings.

This means your type-checker and your build always use the exact same TypeScript configuration — no drift, no duplication.

The only `compilerOptions` setting tsbuild requires:
- **`outDir`** — determines where built files are written

Declaration generation is **not required**. If `declaration: true` is already set in your `tsconfig.json`, tsbuild will automatically generate and bundle `.d.ts` files. If it's not set, tsbuild skips that step — no changes needed either way.

Everything else carries over automatically.

Add a `tsbuild` property to your `tsconfig.json` with only the options you need to customise:

```jsonc
{
  "compilerOptions": {
    "declaration": true,
    "isolatedModules": true,
    "isolatedDeclarations": true,
    "target": "ESNext",
    "module": "ESNext",
    "lib": [ "ESNext", "DOM" ],
    "outDir": "./dist",
    // ... other TypeScript options
  },
  "tsbuild": {
    "clean": true, // Remove all files from output directory before building (default: true)
    "platform": "node", // Will default to "browser" if "DOM" is found in "lib", otherwise "node"
    "entryPoints": { // Optional - tsbuild can infer entry points from package.json if not provided
      "cli": "./src/cli.ts",
      "index": "./src/index.ts"
    },
    "dts": {
      "entryPoints": [ "index" ]  // Only bundle declarations for index
    }
  }
}
```

### CLI Commands

The examples below use the bare `tsbuild` command, which works when tsbuild is installed globally. If it's installed locally as a dev dependency, run these through `package.json` scripts (`pnpm build`, etc.) or prefix with `pnpm exec`/`npx` (e.g., `pnpm exec tsbuild --watch`).

```bash
# Build once
tsbuild

# Minify build output
tsbuild --minify  # or -m

# Force a full rebuild, bypassing incremental compilation.
tsbuild --force  # or -f

# Clear the incremental build cache (.tsbuild/dts_cache.v8.br) before building.
tsbuild --clearCache  # or -c

# Build with watch mode
tsbuild --watch  # or -w

# Type-check only (no bundling)
tsbuild --noEmit  # or -n

# Use custom tsconfig
tsbuild --project ./tsconfig.build.json  # or -p

# Display help
tsbuild --help  # or -h

# Display version
tsbuild --version  # or -v
```

> **Note**: `--watch` and `--force` are CLI-only options. If you configure `watch` or `force` in the config, it will be ignored.

### Package.json Scripts

```json
{
  "scripts": {
    "build": "tsbuild",
    "build:watch": "tsbuild --watch",
		"build:force": "tsbuild --force",
    "type-check": "tsbuild --noEmit"
  }
}
```

## Incremental Builds

tsbuild uses two separate caches to speed up repeated builds, and two flags to control them.

### How it works

Enable incremental compilation in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "incremental": true
  }
}
```

With this set, each build maintains two caches inside a `.tsbuild/` directory:

| Cache | File | What it stores |
|-------|------|----------------|
| TypeScript | `.tsbuild/.tsbuildinfo` | Which source files changed and their type information |
| DTS cache | `.tsbuild/dts_cache.v8.br` | Pre-processed declaration files (Brotli-compressed) |

On each build, TypeScript reads `.tsbuildinfo` to determine what changed and only re-emits those files. Changed `.d.ts` files overwrite their entries in the DTS cache; unchanged entries remain valid. If nothing changed, TypeScript skips emission entirely and the output phase is skipped too — this is why incremental rebuilds with no changes take ~5ms.

### Flags

**`--force` (`-f`)** — Runs the output phase (esbuild + DTS bundling) even when TypeScript detects no changes. Useful when something outside the source files changed (e.g. an environment variable or esbuild config) and you need to regenerate output without touching the caches.

**`--clearCache` (`-c`)** — Deletes the entire `.tsbuild/` directory before building, wiping both `.tsbuildinfo` and the DTS cache. The next build runs as if it's the first time. Use this when you suspect the cache is stale or after significant config changes.

**Normal build (no flags)** — TypeScript compares source file hashes against `.tsbuildinfo`, re-emits only what changed, and the DTS cache is updated accordingly.

## Configuration Options

tsbuild supports a comprehensive set of options (full schema available in [`schema.json`](./schema.json)):

### Entry Points

```jsonc
{
  "tsbuild": {
    // Object syntax - recommended for named outputs
    "entryPoints": {
      "cli": "./src/cli.ts",
      "index": "./src/index.ts"
    },

    // Array syntax - auto-names based on file names
    "entryPoints": ["./src/index.ts", "./src/cli.ts"]
  }
}
```

If a directory is provided, all files within will be used as entry points.

When `entryPoints` is omitted entirely, tsbuild automatically infers entry points from `package.json` by reverse-mapping output paths back to their source files. Resolution order:

1. **`exports`** - Subpath export map (wildcard patterns are skipped; `import`/`default` conditions are tried in order)
2. **`bin`** - Binary entry points
3. **`main`** / **`module`** - Legacy fallback (only used when `exports` and `bin` produce no results)

> **Note:** Auto-inference requires that your `package.json` output paths fall inside the `outDir` declared in `tsconfig.json` and that the corresponding source files exist under `src/`.

### Declaration Bundling

```jsonc
{
  "tsbuild": {
    "dts": {},  // Use defaults (bundle declarations for all entry points)

    // Or configure specific options
    "dts": {
      "entryPoints": ["index", "cli"],  // Names from entryPoints object
      "resolve": false  // true = bundle external types from node_modules
    }
  }
}
```

The `resolve` option controls whether to bundle external types from `node_modules` into your declaration files. When `false` (default for Node.js), external imports remain as import statements. When `true`, the bundler attempts to inline external types. This defaults to:
- `false` for `platform: "node"` (recommended for Node.js projects - keeps external types as imports)
- `true` for `platform: "browser"` and `platform: "neutral"` (bundles everything for standalone distribution)

### External Dependencies

```jsonc
{
  "tsbuild": {
    // Don't bundle these modules (keep as imports)
    "external": ["typescript", "esbuild"],

    // Always bundle these modules (even if in dependencies)
    "noExternal": ["lodash-es"],

    // Bundle strategy: 'bundle' includes deps, 'external' excludes them
    "packages": "external"
  }
}
```

By default, bare specifiers (e.g., `lodash`) are treated as external when `platform: "node"`. Use `noExternal` to force bundling specific packages.

### Other Options

```jsonc
{
  "tsbuild": {
    "platform": "node",          // Target platform: 'node' | 'browser' | 'neutral'
    "clean": true,               // Remove output directory contents before building (default: true)
    "minify": false,             // Minify output
    "sourceMap": true,           // Generate source maps (boolean | 'inline' | 'external' | 'both')
    "splitting": true,           // Enable code splitting
    "bundle": true,              // Enable/disable bundling
    "force": false,              // Force full rebuild, bypassing incremental cache
    "banner": {                  // Inject code at start of files
      "js": "#!/usr/bin/env node"
    },
    "footer": {                  // Inject code at end of files
      "js": "// Copyright 2025"
    },
    "env": {                     // Environment variables (accessible via import.meta.env)
      "API_URL": "https://api.example.com"
    },
    "watch": {                   // Watch mode configuration
      "enabled": false,          // Set via --watch CLI flag
      "ignore": ["**/*.test.ts"]
    },
    "plugins": []                // Custom esbuild plugins (programmatic API only)
  }
}
```

**Note:** All `compilerOptions` (including `target`, `outDir`, `module`, `strict`, `paths`, etc.) come from `tsconfig.json` and are not duplicated in the `tsbuild` section. The `force` and `minify` options are generally more useful as CLI flags (`--force`, `--minify`) than as persistent config values.

## Advanced Features

### Decorator Metadata

#### TC39 Standard Decorators (recommended)

Standard decorators work out of the box — just use them in your code. No configuration, no extra packages.

```jsonc
{
  "compilerOptions": {
    "target": "ESNext"
    // No experimentalDecorators needed
  }
}
```

#### Legacy Decorators with Metadata (`experimentalDecorators`)

If you are using the older decorator proposal with `emitDecoratorMetadata`, tsbuild delegates the transform to SWC so that metadata is emitted correctly through the esbuild pipeline. This requires `@swc/core` to be installed manually — it is **not** included with tsbuild:

```bash
pnpm add -D @swc/core
```

Then enable the flags in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

tsbuild detects these flags automatically and uses SWC. If `@swc/core` is not installed when these flags are set, the build will fail with a clear message telling you to install it.

### Custom Plugins

tsbuild supports custom esbuild plugins:

```typescript
import { TypeScriptProject } from 'tsbuild';

const myPlugin = {
  name: 'my-plugin',
  setup(build) {
    // Your plugin logic
  }
};

// In tsconfig.json, plugins aren't directly supported
// You'll need to use the TypeScriptProject API directly
```

### Lifecycle Management

tsbuild includes built-in decorators for resource management:

- `@closeOnExit` - Automatically cleanup resources on process exit or SIGINT
- `@logPerformance` - Wraps async methods with performance timing

These are used internally but can be leveraged when extending tsbuild.

## Architecture

### Core Components

**TypeScriptProject** (`src/type-script-project.ts`) - Central orchestrator that manages the build lifecycle
**FileManager** (`src/file-manager.ts`) - In-memory `.d.ts` storage with optional caching support
**IncrementalBuildCache** (`src/incremental-build-cache.ts`) - Brotli-compressed caching to `.tsbuild/dts_cache.v8.br`
**ProcessManager** (`src/process-manager.ts`) - Global cleanup coordinator for graceful shutdowns

### Plugin System

**External Modules Plugin** - Pattern-based external dependency resolution
**Output Plugin** - Handles file writing and executable permissions (shebangs get 0o755)
**Decorator Metadata Plugin** - Optional SWC transform for decorator metadata

### DTS Bundling System

The declaration bundling system (`src/dts/declaration-bundler.ts`) is a custom implementation that:

1. **Module Graph Building** - Traverses import/export statements to build dependency graph using TypeScript's module resolution
2. **Dependency Sorting** - Topologically sorts modules to ensure correct declaration order
3. **Code Combination** - Strips imports/exports while preserving external references
4. **Pre/Post Processing** (`declaration-processor.ts`) - Cleans up directives, splits declarations, fixes modifiers, normalizes exports

This custom bundler works entirely with in-memory declaration files, avoiding the overhead of duplicate TypeScript Program creation with some other bundlers.

When a circular dependency is detected between declaration files, tsbuild emits a warning with the full cycle path (e.g., `a.d.ts -> b.d.ts -> a.d.ts`) and continues rather than failing silently or crashing.

## Performance

tsbuild is designed for speed:

- **Incremental builds** - Only recompiles changed files
- **In-memory declarations** - No intermediate disk I/O for `.d.ts` files
- **Parallel processing** - Declaration bundling and transpilation run in parallel after type checking completes
- **Smart caching** - Leverages `.tsbuildinfo` for TypeScript incremental compilation

Typical build times for the tsbuild project itself:
- Full build: ~450-500ms
- Incremental rebuild (no changes): ~5ms
- Type-check only: ~10-15ms

## Acknowledgments

tsbuild was inspired by and borrows concepts from several excellent projects:

### [tsup](https://tsup.egoist.dev/) by [@egoist](https://github.com/egoist)
tsbuild's overall architecture, API design, and configuration approach are heavily influenced by tsup. The external module resolution strategy, entry point handling, and plugin system take direct inspiration from tsup's battle-tested design. If you need a production-ready build tool, use tsup.

### [rollup-plugin-dts](https://github.com/Swatinem/rollup-plugin-dts) by [Arpad Borsos](https://github.com/Swatinem)
The TypeScript declaration bundling system was originally inspired by rollup-plugin-dts's approach to handling complex TypeScript declarations. The current custom implementation builds a dependency graph and combines modules without Rollup, optimizing for in-memory operations and avoiding duplicate TypeScript Program creation.

### Other Dependencies
- **[esbuild](https://esbuild.github.io/)** - The incredibly fast JavaScript bundler that powers tsbuild's transpilation
- **[TypeScript](https://www.typescriptlang.org/)** - Type checking, declaration generation, and module resolution
- **[SWC](https://swc.rs/)** - Optional decorator metadata transformation
- **[magic-string](https://github.com/Rich-Harris/magic-string)** - Efficient source code transformation with sourcemap support
- **[watchr](https://github.com/bevry/watchr)** - File watching for watch mode

## Limitations

- **ESM Only** - No CommonJS support by design
- **Node.js 20.16.0+** - Requires a modern Node.js version
- **Personal project** - Works well for my use cases, but hasn't been tested across every environment or edge case
- **Plugins are programmatic only** - Custom esbuild plugins can't be declared in `tsconfig.json`; they require using the `TypeScriptProject` API directly
- **tsBuildInfoFile Path Changes** - When changing the `tsBuildInfoFile` path in `tsconfig.json`, the old `.tsbuildinfo` file at the previous location will not be automatically cleaned up and must be manually removed

## Comparison with Other Tools

| Feature | tsbuild | tsup | tsdown | tsc |
|---------|---------|------|--------|-----|
| Type Checking | ✅ Full | ✅ Full | ⚠️ Via DTS only | ✅ Full |
| Bundling | ✅ esbuild | ✅ esbuild | ✅ Rolldown | ❌ N/A |
| Declaration Bundling | ✅ Custom Bundler | ✅ rollup-plugin-dts¹ | ✅ rolldown-plugin-dts | ❌ N/A |
| TC39 Decorators | ✅ Native | ✅ Native | ✅ Native | ✅ Native |
| Legacy Decorator Metadata | ✅ SWC (manual install) | ✅ SWC | ✅ SWC | ✅ Native |
| CommonJS Support | ❌ None | ✅ Yes | ✅ Yes | ✅ Yes |
| Watch Mode | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Incremental Builds | ✅ Yes | ⚠️ Limited | ⚠️ Limited | ✅ Yes |
| Production Ready | ⚠️ Experimental | ✅ Yes | ✅ Yes | ✅ Yes |

> ¹ tsup uses **esbuild** for JS bundling and **rollup-plugin-dts** (a Rollup plugin) for declaration bundling. `--experimental-dts` uses `@microsoft/api-extractor` instead. An optional `--treeshake` flag also delegates tree-shaking to Rollup.

## Development

```bash
# Install dependencies
pnpm install

# Build (self-hosting)
pnpm build

# Watch mode
pnpm build:watch

# Type-check only
pnpm type-check

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Lint
pnpm lint
```

## Contributing

Contributions and feedback are welcome. This is a personal project, so response times may vary, but issues and pull requests will be reviewed.

## License

MIT

## Author

D1g1talEntr0py
