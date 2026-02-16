# 🤖 AGENT Guidelines

This document outlines the core principles, coding standards, and workflow protocols for AI assistants contributing to this project.

---

## 💻 Core Principles

1.  **Clarity and Brevity:** All responses, comments, and documentation must be concise, clear, and easy to understand.
2.  **Performance First:** Code implementation must **always** prioritize performance over readability or other metrics. However, always seek the simplest solution first - simplicity often equals performance. Complexity should only arise from necessity, not from overengineering.
3.  **Language:** All code, comments, and documentation must be written in English.
4.  **ESM-Only:** This is an ESM-only project. No CommonJS support. All imports use `.js` extensions for TypeScript files (per `rewriteRelativeImportExtensions`).

---

## 📜 Coding Standards

1.  **Code Formatting:** Do **not** change the formatting of any existing code. Adhere strictly to the established style.
2.  **Line Wrapping:** Wrapping lines is unacceptable in almost every circumstance. Keep lines within the established limits.
3.  **Type Safety:** Prioritize strict type safety. Avoid the `any` type whenever possible. Use specific types to ensure compile-time checks and optimized runtime performance.
4.  **Branded Types:** Use branded path types (`AbsolutePath`, `RelativePath`) for file paths to ensure type safety without runtime overhead.
5.  **Documentation:** Write clear JSDoc documentation for all exported APIs, public-facing methods, and complex logic.
6.  **Decorators:** Use the project's decorator pattern for cross-cutting concerns:
    - `@closeOnExit` - For classes requiring cleanup on process exit
    - `@logPerformance` - For async methods requiring performance measurement
    - `@debounce` - For methods requiring rate limiting

---

## 🧪 Testing Protocol

1.  **Test Creation:** Write unit tests for your code. Create test files for all source files, focusing on public or exported methods/functions. Test files mirror source structure in `tests/`.
2.  **Test Strategy:** Tackle low-hanging fruit first. Do **not** mock internal (private) methods or implementation details of a class or module. Test the public contract.
3.  **Test Framework:** Use Vitest with `pool: 'vmForks'` and Node environment. Use `memfs` for file system mocking when needed.
4.  **Test Fixing:** When instructed to fix tests, do not remove or modify existing implementation code. If a bug in the implementation is discovered while fixing a test, report it clearly instead of modifying the source code.
5.  **Code Coverage:**
    * Run `pnpm test:coverage` to check code coverage.
    * Coverage excludes: `src/@types/**`, `src/dts/@types/**`, `src/index.ts`, `src/dts/index.ts`.
    * If coverage is not 100%, fill in the gaps by adding new tests **to the existing test file** for that source file.
    * If a remaining gap requires a mock to be tested, make a note of it and move on. We do not add mocks unless they are 100% necessary.
    * Repeat this process until all files are 100% covered or the only remaining gaps absolutely require complex mocking.

---

## 🔧 Tooling & Workflow

1.  **Command Execution:** Do not prefix terminal commands with a `cd` command to the repository root. Assume commands will be run from the current working directory and provide relative paths as needed.
2.  **Dependency Management:** Do not suggest or add new dependencies unless they are critical for the required functionality and no native or existing solution is feasible.
3.  **Build Commands:**
    - `pnpm build` - Self-hosting build (uses tsx to run source)
    - `pnpm build:watch` - Watch mode
    - `pnpm type-check` - Type checking only (no bundling)
    - `pnpm test` / `pnpm test:coverage` - Run tests with optional coverage
    - `pnpm lint` - Run ESLint on source files

---

## 🏗️ Architecture Notes

1.  **Three-Phase Build:** Type checking (TypeScript API) → Transpile (esbuild) → DTS bundling (custom bundler).
2.  **In-Memory Architecture:** Declaration files are held in memory via `FileManager`, avoiding disk I/O during compilation.
3.  **Plugin Order:** esbuild plugins run in order. `outputPlugin` must run after `externalModulesPlugin`.
4.  **Cache Strategy:** Uses Brotli-compressed cache at `.tsbuild/dts_cache.json.br` for incremental builds via `IncrementalBuildCache`.