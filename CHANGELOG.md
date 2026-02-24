## [1.0.3](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.0.2...v1.0.3) (2026-02-24)

### Bug Fixes

* **build:** fix --force flag, new-file watch handling, and minor correctness issues (c005d19c406aafd44c54836f4ca38026f72a2ba5)
- Fixes the `--force` flag being silently ignored when incremental
  TypeScript reports no changed files; reorders the condition so `force`
  independently bypasses the `filesWereEmitted` gate
- Fixes newly added source files being silently dropped during a watch
  rebuild by adding a `FileEvent.add` handler that appends the path to
  `rootNames` when not already present
- Passes `configFileParsingDiagnostics` when recreating the incremental
  program so config-level errors are surfaced rather than swallowed
- Removes a stale `compilerOptionOverrides` spread that was clobbering
  user-provided compiler options
- Caches the package.json dependency read as a lazy promise to avoid
  repeated file reads across multiple calls
- Adds tests covering the --force bypass and the new-file rootNames
  insertion, including a guard against duplicate entries

* **dts:** fix identifier rename whitespace bug and optimise directory lookups (1321f065be435d37cfd524e2bd11908e4c57c5db)
- Fixes a bug where renaming conflicting exported identifiers consumed
  leading trivia (whitespace), turning `type Options` into `typeOptions$1`;
  replaces `node.pos` with `node.getStart()` which excludes trivia
- Removes an erroneous `isModuleBlock` recursion in identifier collection
  that could cause duplicate or mis-scoped renames, and drops its import
- Replaces the O(n) linear scan on every `directoryExists` call with an
  O(1) pre-computed `Set` of all ancestor directory paths, built once
  after declaration files are loaded
- Removes the fragile on-demand lazy loading of external declaration files
  from within the import-resolution loop
- Replaces the manual collect-sort-apply transformation pattern in
  `postProcess` with direct `MagicString` edits during the AST walk,
  removing the `CodeTransformation` type and its reverse-order comparator
- Adds a regression test for the whitespace-preservation fix


### Code Refactoring

* clean up dead code and simplify type constraints (3ccfd81f146b968ed1e4af46971927261a9eea36)
- Relaxes overly strict self-referential generic constraints on
  `TypedFunction` and `OptionalReturn` to use a simpler upper bound,
  eliminating circular constraint errors
- Removes unused recursive JSON utility types (`JsonArray`, `JsonObject`,
  `JsonValue`) that were never consumed outside the type file
- Removes the `NodeType` string-literal constant and its export, which
  was dead code left over from an earlier ESTree-based AST walking approach
- Removes its corresponding test coverage
- Updates the debounce module to drop the now-unnecessary `TypedFunction`
  import and inlines a more precise constraint directly on the method

## [1.0.2](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.0.1...v1.0.2) (2026-02-24)

### Bug Fixes

* **ci:** attach npm package tarball to github release (b0c0c49a868eabf7da9d86608c8d53f6056cb201)

## [1.0.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.0.0...v1.0.1) (2026-02-24)

### Bug Fixes

* **ci:** add registry-url to setup-node for trusted publisher OIDC (420d5200bf0685b57d2713fe59bebae49981fdfe)
* **ci:** use exec plugin for npm publish to support trusted publishers (89efe130d17d417962a3b27735990629343ee11c)

# Changelog

## 1.0.0 (2026-02-16)


### Features

* initial release ([8a49106](https://github.com/D1g1talEntr0py/tsbuild/commit/8a49106dcc03c911b1670ed07e86c29717007a26))
