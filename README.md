# tsbuild

[![npm version](https://img.shields.io/npm/v/%40d1g1tal/tsbuild?color=blue)](https://www.npmjs.com/package/@d1g1tal/tsbuild)
[![npm downloads](https://img.shields.io/npm/dm/%40d1g1tal/tsbuild)](https://www.npmjs.com/package/@d1g1tal/tsbuild)
[![CI](https://github.com/D1g1talEntr0py/tsbuild/actions/workflows/ci.yml/badge.svg)](https://github.com/D1g1talEntr0py/tsbuild/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/D1g1talEntr0py/tsbuild/graph/badge.svg)](https://codecov.io/gh/D1g1talEntr0py/tsbuild)
[![License: MIT](https://img.shields.io/github/license/D1g1talEntr0py/tsbuild)](https://github.com/D1g1talEntr0py/tsbuild/blob/main/LICENSE)
[![Node.js](https://img.shields.io/node/v/%40d1g1tal/tsbuild)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

A self-hosting TypeScript build tool that combines the best of three worlds: **TypeScript's type system**, **esbuild's speed**, and **SWC's decorator metadata support**. tsbuild is designed for modern ESM-only projects targeting Node.js 20.16.0+.

> **⚠️ Note:** This is an experimental project for personal use. For production use, consider [tsup](https://tsup.egoist.dev/) instead, which is mature, battle-tested, and widely adopted. Or check out the new [tsdown](https://tsdown.dev/) by [void(0)](https://voidzero.dev/).

## Features

- 🚀 **Blazing Fast** - Leverages esbuild for rapid bundling and transpilation
- 🔍 **Full Type Safety** - Uses TypeScript API for comprehensive type checking
- 📦 **Declaration Bundling** - Automatically bundles `.d.ts` files into single entry points
- ⚡ **Incremental Builds** - Intelligent caching with `.tsbuildinfo` for fast rebuilds
- 👁️ **Watch Mode** - File watching with automatic rebuilds on changes
- 🎨 **Decorator Metadata** - Optional SWC integration for `emitDecoratorMetadata` support for legacy decorators (Will probably be removed at some point in favor of native ESM decorators only)
- 🔌 **Plugin System** - Extensible architecture with custom esbuild plugins
- 🎯 **ESM-Only** - Pure ESM project with no CommonJS support by design
- 🧹 **Clean Builds** - Optional output directory cleaning before builds
- 📊 **Performance Metrics** - Built-in performance logging with detailed timing information

## Why tsbuild?

tsbuild orchestrates a sophisticated three-phase build process:

1. **Type Checking Phase** - TypeScript compiler validates types and emits `.d.ts` files into memory (not disk)
2. **Transpile Phase** - esbuild bundles JavaScript with custom plugins for module resolution and output formatting
3. **DTS Bundle Phase** - Custom minimal bundler combines declaration files through dependency graph traversal and AST transformation

This separation of concerns ensures TypeScript handles correctness, esbuild handles speed, and the custom bundler handles declaration consolidation efficiently without creating duplicate TypeScript Programs.

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
# pnpm - no SWC dependency (optional for decorator metadata)
pnpm add -D @d1g1tal/tsbuild --no-optional

# pnpm - with SWC dependency (for decorator metadata)
pnpm add -D @d1g1tal/tsbuild

# npm
npm install -D @d1g1tal/tsbuild

# yarn
yarn add -D @d1g1tal/tsbuild
```

> **Note:** When installed only as a local dev dependency, the `tsbuild` command is not available directly in your terminal. Use it through `package.json` scripts (e.g., `pnpm build`) or invoke it explicitly with `pnpm exec tsbuild` / `npx tsbuild`.

### Requirements

- **Node.js**: >=20.16.0
- **pnpm**: >=9.0.0

## Usage

### Configuration

Add a `tsbuild` property to your `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "declaration": true,
    "isolatedModules": true,
    "isolatedDeclarations": true,
    "target": "ESNext",
    "module": "ESNext",
    "lib": [ "ESNext", "DOM" ],
    "outDir": "./dist", // default value
    // ... other TypeScript options
  },
  "tsbuild": {
    "clean": true, // Remove all files from output directory before building (default: true)
    "platform": "node", // Will default to "browser" if "DOM" is found in "lib", otherwise "node"
    "entryPoints": {
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

**Note:** The `target` and `outDir` options come from `tsconfig.json` `compilerOptions` and cannot be overridden in the `tsbuild` section. The `force` and `minify` options are typically better controlled via CLI flags (`--force`, `--minify`) rather than in the config.

## Advanced Features

### Decorator Metadata

tsbuild supports `emitDecoratorMetadata` through SWC integration:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

You must have `@swc/core` installed (as an optional dependency) for this feature to work:

```bash
pnpm add -D @swc/core
```

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

## Performance

tsbuild is designed for speed:

- **Incremental builds** - Only recompiles changed files
- **In-memory declarations** - No intermediate disk I/O for `.d.ts` files
- **Parallel processing** - Type checking and transpilation run in parallel when possible
- **Smart caching** - Leverages `.tsbuildinfo` for TypeScript incremental compilation

Typical build times for the tsbuild project itself:
- Full build: ~400-600ms
- Incremental rebuild: ~100-200ms
- Type-check only: ~50-100ms

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
- **Node.js 20.16.0+** - Requires modern Node.js features
- **Experimental** - Personal project, not recommended for production use
- **Limited Configuration in tsconfig.json** - Some options (like `plugins`) are only available via programmatic API
- **tsBuildInfoFile Path Changes** - When changing the `tsBuildInfoFile` path in `tsconfig.json`, the old `.tsbuildinfo` file at the previous location will not be automatically cleaned up and must be manually removed

## Comparison with Other Tools

| Feature | tsbuild | tsup | tsc |
|---------|---------|------|-----|
| Type Checking | ✅ Full | ✅ Full | ✅ Full |
| Fast Bundling | ✅ esbuild | ✅ esbuild | ❌ N/A |
| Declaration Bundling | ✅ Custom Bundler | ✅ rollup-plugin-dts | ❌ N/A |
| Decorator Metadata | ✅ SWC (optional) | ✅ SWC | ✅ Native |
| CommonJS Support | ❌ None | ✅ Yes | ✅ Yes |
| Watch Mode | ✅ Yes | ✅ Yes | ✅ Yes |
| Incremental Builds | ✅ Yes | ⚠️ Limited | ✅ Yes |
| Production Ready | ⚠️ Experimental | ✅ Yes | ✅ Yes |

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

This is a personal experimental project. While contributions are welcome, please note that the project is not actively maintained for production use.

## License

ISC

## Author

D1g1talEntr0py

---

**Remember:** For production projects, use [tsup](https://tsup.egoist.dev/) instead. tsbuild is an educational and experimental project exploring how modern build tools can be composed together.
