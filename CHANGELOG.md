## [1.2.3](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.2.2...v1.2.3) (2026-02-25)

### Bug Fixes

* **deps:** update minimatch (958d33ffed3a53997b260afe6e2dc40b9553681a)

## [1.2.2](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.2.1...v1.2.2) (2026-02-25)

### Bug Fixes

* **build:** log configuration errors before exiting (7a2497ae68be5924f19c61aab3936d0f0805453a)
ConfigurationError was being thrown but never logged, leaving the user
with no visible feedback about what went wrong during the build.

- Handles ConfigurationError separately from other BuildError subclasses
  in the build error handler
- Logs the error message via the logger before setting the exit code
- Clarifies the comment for TypeCheckError and BundleError, which are
  already logged at the point they are thrown

* **entry-points:** use file stem instead of package name for root export (f641c1f0f6e20d79ac9566297b204458d4c37699)
Previously, the root export ('.') used the unscoped package name as the
entry point key, which could conflict with bin entries and was
unpredictable when the source file name differed from the package name.

- Adds a `stemOf` helper to extract the filename stem from a path
- Uses the file stem of the resolved source path as the entry key for
  the root export ('.') and for string exports
- Non-root subpath exports continue to use the subpath-derived name
- Fixes a bug where bin entries with different names were silently
  dropped because they collided with the package-name-based export key


### Tests

* **entry-points:** update tests to reflect file-stem entry naming (38c296d1441ecfb435e6b7fd69493ab936be11fc)
Follows up on the change that uses file stems instead of package names
for root export entry point keys.

- Updates all test expectations that previously expected the unscoped
  package name (e.g., 'my-pkg') as the root entry key to now expect the
  file stem (e.g., 'index')
- Renames a test to better describe the new behaviour of combining
  exports and bin when their names differ
- Adds a new test that mirrors the real-world tsbuild package layout,
  where exports '.' resolves to index.ts and bin resolves to tsbuild.ts,
  verifying both are included as separate entries
- Adds a missing `name` field to a test fixture that requires it
- Updates a test description to reflect that file stem is used for root
  exports while subpath names are used for other exports

## [1.2.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.2.0...v1.2.1) (2026-02-25)

### Bug Fixes

* **paths:** return false for non-existent paths in type checks (393856cfff44dedffa1e63b3f5fa5a9b3863d023)
- Handle ENOENT in isDirectory and isFile instead of throwing
- Re-throw any unexpected errors to preserve error visibility
- Update JSDoc to document non-existence behavior
- Add unit tests covering existing directory, existing file, and non-existent path cases for both methods
- Mock node:fs and node:fs/promises with memfs for isolated in-memory testing

* **type-script-project:** validate entry points exist and suppress unhandled rejection (758be0311f505f9f0417036912a35a186dfa96fc)
- Throw a ConfigurationError when an entry point path does not exist as a file or directory
- Suppress the unhandled rejection warning on the entry points promise since the rejection is handled when awaited in build()
- Inline a single-use variable in dependency path parsing for clarity
- Remove stale commented-out entry points from tsconfig.json
- Add a test asserting that a missing entry point causes exit code 3 during build

## [1.2.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.1.3...v1.2.0) (2026-02-24)

### Features

* **entry-points:** add unscoped name support and drop .mjs mapping (d11c55e994b6ca780b52e67ad7c8c6dda26c8a9b)
- Removes .mjs and .d.mts from the output-to-source extension map since the project is ESM-only and only emits .js
- Adds an unscope() helper to strip npm scope prefixes (e.g. @scope/pkg → pkg) so scoped package names produce clean entry point keys
- Applies unscoping when deriving entry point names from the root export (.) and when using package.json name as a fallback key
- Enables tsconfig.json to rely on auto-inferred entry points by commenting out the explicit entryPoints config, exercising the zero-config path


### Code Refactoring

* **type-script-project:** remove unused packageJson field (96c5659ac9e9617feea3454414880b8ebb23f466)
- Drops the cached packageJson instance field that was read but never used outside of the dependency resolution method
- Simplifies the class by eliminating unnecessary state that was populated as a side-effect of reading dependencies


### Documentation

* update README with new features and revised benchmarks (2f3141830cca6d7dc3d2ecea5efae87a6cdd56a6)
- Documents the zero-config entry point auto-inference feature including resolution order and constraints
- Documents circular dependency detection behavior in the declaration bundler
- Adds the zero-config entry point feature to the feature highlights list
- Updates build time benchmarks to reflect current measured performance


### Miscellaneous Chores

* consolidate agent guidelines into copilot-instructions (0830c1c47b583fac5ce3d472f52694cc073b1f33)
- Removes the standalone AGENTS.md file to reduce documentation fragmentation
- Inlines the core principles, coding rules, testing rules, and workflow rules directly into .github/copilot-instructions.md
- Condenses verbose guidelines into concise bullet points while preserving all essential constraints
- Ensures Copilot and other agents read a single authoritative source of truth

* **release:** make all commit types visible in changelog (f884bcf888927bb9c273aa52962de1cd742b91c3)
- Removes the hidden:true flag from docs, style, chore, test, build, and ci commit types in .releaserc.json
- All commit types will now appear in generated changelogs regardless of semantic-release conventions


### Tests

* **entry-points:** update tests for .mjs removal and scoped names (1eba92d4ed914182bf0445684ec415c17b4dba7b)
- Removes test cases for .mjs and .d.mts extension mappings that no longer exist in the source
- Updates the module field fallback test to use .js instead of .mjs
- Corrects the expectation for .mjs exports to be undefined (unmappable) rather than resolving
- Adds a new test covering scoped package name stripping across exports, bin, and the root export key

## [1.1.3](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.1.2...v1.1.3) (2026-02-24)

### Bug Fixes

* **dts:** improve circular dependency detection with full cycle path (b5bbb2bf6028eca05cdf13d6d7eb24058917a0f6)
- Tracks the current visit stack so the exact cycle can be reconstructed
- Reports the full chain of modules involved in the cycle instead of just the entry point
- Properly cleans up visiting state and stack when a module is not found
- Updates the test assertion to verify the full cycle path is reported

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
