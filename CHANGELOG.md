## [1.1.2](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.1.1...v1.1.2) (2026-02-24)

### Bug Fixes

* **bundler:** flatten qualified names from bundled namespace imports (883c4a4e47df1d2de7e91e549e37cae0c09753e8)
- Adds tracking of namespace aliases created from bundled `import * as Alias` statements
- When a bundled module is inlined, its namespace import is stripped, so all `Alias.X` qualified references must be rewritten to plain `X` to avoid broken output
- Fixes identifier re-insertion bug where the rename visitor was walking import/export declarations that had already been removed via magic.remove(), causing overwrite() to reinsert removed text and produce corrupted output like `};Json$1JsonPrimitive$1`
- Restricts the rename visitor to declaration statements only, skipping import/export declarations
- Imports two new TypeScript AST helpers needed for the above fixes

## [1.1.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.1.0...v1.1.1) (2026-02-24)

### Bug Fixes

* **dts:** correct scoped package name in DTS output (9c40f48a896d5dab7d05c130eb624d288d0f6967)
Two bugs caused scoped npm package imports (e.g. `@d1g1tal/watchr`) to be
emitted as unscoped names (`watchr`) in the bundled declaration output.

- Race condition in `IncrementalBuildCache`: `loadCache()` starts reading
  the cache file asynchronously in the constructor, but `invalidate()` is
  called afterward; the I/O read could complete before `rmSync` deleted the
  file, so stale cache data was returned by `restore()` even after
  `--clearCache`; fixed by adding an `invalidated` flag that makes
  `restore()` bail out immediately when set
- Ambiguous path matching in `sourceToDeclarationPath`: when both a stale
  cache entry (`dist/src/@types/index.d.ts` from an old build) and the
  correct current entry (`dist/@types/index.d.ts`) exist in
  `declarationFiles`, the stale one (inserted earlier from `restore()`) was
  returned first; fixed by selecting the match with the shortest relative
  path since TypeScript strips `rootDir` from output paths
- Add test for the `invalidated` flag race-condition fix in
  `tests/build-cache.test.ts`
- Add test for shortest-path preference in
  `tests/declaration-bundler.test.ts`

## [1.1.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.0.3...v1.1.0) (2026-02-24)

### Features

* **entry-points:** infer entry points from package.json when none configured (a3c73da481e4e59416e2f6e4483e932c525d0968)
- add src/entry-points.ts with inferEntryPoints() that reverse-maps output paths
  from exports, bin, main, and module fields back to source files
- add PackageJson type covering exports, bin, main, module, dependencies,
  and peerDependencies fields
- integrate inferEntryPoints into TypeScriptProject.readConfiguration() so
  projects with no explicit entryPoints config auto-infer from package.json
- update schema.json markdownDescription for entryPoints to document the
  auto-inference behaviour
- replace ProjectDependencies with PackageJson in getProjectDependencyPaths()
  and cache the parsed package.json on the instance for reuse
- add tests/entry-points.test.ts covering all inference paths


### Bug Fixes

* **dts:** fix modifier removal eating next token's leading character (7a0f90321ca00879557ec55e2464b72d97bfe528)
- replace hard-coded '+ 1' offset in fixModifiers with a call to the
  existing getTrailingWhitespaceLength() helper so that only actual
  whitespace after the modifier keyword is consumed, not the first
  character of the following token
- add tests covering export modifier at end of line, export default, and
  export with multiple trailing spaces

* **dts:** separate external declarations, fix rename collisions, warn on circular deps (5daeb0a227b502a6fda29f24d756dfc1f1fb7df6)
- introduce externalDeclarationFiles Map separate from declarationFiles so
  externally-resolved node_modules .d.ts files never pollute the project map
- update moduleResolutionHost.fileExists and readFile to check both maps
- store disk-loaded external declarations in externalDeclarationFiles instead
  of declarationFiles to prevent memory accumulation across entry points
- add clearExternalFiles() method and call it after all bundling completes to
  free memory used by externally-resolved declarations
- expand buildDependencyGraph and topological-sort visit() to look up cached
  declarations in both maps
- fix rename collision detection: iterate with an incrementing suffix and
  skip candidates already present in declarationSources instead of always
  using sequential indices
- emit a Logger.warn() message when a circular dependency is detected rather
  than silently returning
- replace TODO comment on posix.normalize with an accurate explanation
- add tests for circular dependency warning, rename collision avoidance,
  and external-file cleanup path

* **errors:** make UnsupportedSyntaxError extend BundleError with exit code 2 (ee239c97a05b0f2fb58e911ab83cd90519ffd3b8)
- change UnsupportedSyntaxError base class from Error to BundleError so
  it carries exit code 2 and participates in the standard error hierarchy
- set this.name to 'UnsupportedSyntaxError' for correct identification
  after instanceof checks across prototype chains
- update JSDoc to clarify it is thrown during DTS processing
- add test asserting instanceof BundleError, instanceof BuildError,
  exit code 2, and correct name

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
