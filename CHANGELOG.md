## [1.8.6](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.8.5...v1.8.6) (2026-04-14)

### Bug Fixes

* ensure the source map is referenced in the iife output when source maps are enabled (f6bc57d11cfd7f8289f85c37aea5b6ff983fc302)

## [1.8.5](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.8.4...v1.8.5) (2026-04-14)

### Bug Fixes

* **iife:** resolve paths absolutely and output to nested directory (7514592a039f02e070b71f4c30c6cd88a99bd17d)
- Changes IIFE output to resolve paths absolutely instead of relatively
- Creates a dedicated `iife` output directory under the main `outdir`
- Fixes virtual loader plugin to handle the new directory structure properly
- Adds an integration test for IIFE builds


### Build System

* **deps-dev:** bump typescript-eslint dependencies (e4abe9fe4083b89953f94f4cd17622387844b844)
- Updates `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, and `typescript-eslint` from 8.58.1 to 8.58.2
- Updates `pnpm-lock.yaml` with the new versions and their sub-dependencies

## [1.8.4](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.8.3...v1.8.4) (2026-04-12)

### Performance Improvements

* **build:** delegate file writing to esbuild (84a64e212a9dc7f309bb2dcbe74ffa990c06065b)
- Enables esbuild write option for direct-to-disk transpilation output
- Moves relative module specifier rewriting logic to FileManager
- Simplifies output plugin to only manage shebang executable permissions via chmod
- Adapts IIFE plugin to process metafile outputs instead of in-memory files
- Updates tests and mock helpers to align with file writing capabilities

* **dts:** optimize declaration bundler module resolution and graph traversal (59606c0ccfe54ac74068fe6ab8f6d26d7edd97b6)
- Optimizes module pattern matching by using Sets and RegEx arrays instead of iteration
- Refactors bundled specifiers state to use ReadonlySet for O(1) lookups
- Simplifies deduplication of non-mergeable imports using Sets
- Yields the event loop before cpu-intensive declaration bundling to prevent I/O blocking


### Miscellaneous Chores

* **perf:** add performance baseline documentation and benchmark script (3e897aaa7a35022b8d9ec1d4222448973eb57a2b)
- Adds documentation detailing performance baselines and architectures
- Introduces performance measurements log
- Adds quick reference for performance monitoring
- Introduces new benchmark script for running automated metrics collection
- Registers bench script in package.json

## [1.8.3](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.8.2...v1.8.3) (2026-04-11)

### Performance Improvements

* **core:** optimize build performance and decrease startup time (5cc35a8e0c6acc45dff38f6186e9f5b8f59ee8bf)
- use sets instead of arrays for faster lookups
- replace string concatenation with array joins
- replace object.keys with for-in loops
- cache regex patterns and avoid repeated compilations
- dynamically import esbuild and watchr to reduce startup time
- replace map/reduce chains with single loops for better performance


### Miscellaneous Chores

* **deps:** update dependency @types/node to ^25.6.0 (a99b720acf5c2d3ed4116605e66fbd0f0174259f)

## [1.8.2](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.8.1...v1.8.2) (2026-04-09)

### Bug Fixes

* **build:** add handling for modules where the export uses 'as' (d96f626e7329188e702cd32bd8ba028810647d06)

## [1.8.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.8.0...v1.8.1) (2026-04-09)

### Bug Fixes

* **iife:** ensure module exports are added to 'globalThis' (23933af3534c86b20ee364aae67e955d3cf374a6)
- change esbuild format from iife to esm to capture exports
- add wrapAsIife function to manually wrap esm content and assign exports
- execute esbuild per entry point to inline all dynamic chunks
- update tests to verify global export assignments and correct build options

## [1.8.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.7.5...v1.8.0) (2026-04-09)

### Features

* **build:** add support for esbuild plugins and iife output (b4ffefbf01e0b3c1bb017f9ce0f87608235c9a6b)
- add iife plugin to generate iife bundle
- add resolve-plugin to resolve string/tuple plugin options to plugin instances
- update type definitions for BuildOptions and create PluginReference type
- update json schema to support new plugin format and iife options
- register plugins during build


### Miscellaneous Chores

* **deps:** remove overrides from package.json and update watchr package (7d87c0b207a76a17c37fb10df2d1686d5f23713b)
* **deps:** update dependencies (142c13fff1425e477239ac7f8bdb0a8fcffd3c07)
- update @types/node to ^25.5.2
- update @typescript-eslint/eslint-plugin to ^8.58.1
- update @typescript-eslint/parser to ^8.58.1
- update @vitest/coverage-v8 to ^4.1.4
- update typescript-eslint to ^8.58.1
- update vitest to ^4.1.4
- update various transitive dependencies in pnpm-lock.yaml


### Tests

* **plugins:** add tests for iife and resolve plugins (63371ebd3652831ae168a1fbc18f32d2d436707b)
- add unit tests for iife plugin covering build options, entry point identification, virtual loader, and file output
- add unit tests for resolve-plugin utility covering pass-through, string, tuple references, and error handling
- add a test fixture for the iife plugin

## [1.7.5](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.7.4...v1.7.5) (2026-04-07)

### Bug Fixes

* **deps:** update vitest to latest to resolve CVE-2026-39363 (4bd805572667f2b5e778c19ac70e5971e27f0c08)
Updates vitest to the latest version to mitigate CVE-2026-39363 inherently through the natural dependency updates.


### Miscellaneous Chores

* **deps:** enforce latest esbuild and vite versions (2894d8dea77f3c8743854cdf56d839705ab604f8)
Overrides esbuild and vite transient dependencies. Ensures vitest allows the use of the latest esbuild version, as oxc does not support typescript decorators.

## [1.7.4](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.7.3...v1.7.4) (2026-04-06)

### Bug Fixes

* **typescript:** address regression where 'noEmit' would not catch all type errors (ece0de27a4e3019c3dfc437e40894b61a7ac04a3)
- collect syntatic, semantic, and declaration diagnostics independently when 'noEmit' is true
- emit correctly within 'noEmit' mode to guarantee the incrementally updated tsbuildinfo cache is correctly generated
- adjoin extensive test coverage evaluating diagnostic consistency against varied declaration violations


### Code Refactoring

* **types:** add explicit return types to support isolateddeclarations (ca0b2ee7757de487a5bf64d36fd346faf35adba4)
- add explicit return types to functions across constants, decorators, and internal libraries
- annotate return types on file manager, cache, logger, process manager, and path utilities
- ensure process manager exit handler properly invokes close on registered instances
- update typescript configuration to enable isolateddeclarations for the project

## [1.7.3](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.7.2...v1.7.3) (2026-04-04)

### Bug Fixes

* update esbuild and remaining dependencies (d9fd8e31d2598cc8efc657eb594cb7c8985767d8)
- update esbuild from ^0.27.4 to ^0.28.0
- update @types/node from ^25.5.0 to ^25.5.2
- update eslint from ^10.1.0 to ^10.2.0
- update pnpm-lock.yaml to reflect new dependency versions
- add stableTypeOrdering: true to tsconfig.json
- change moduleResolution: Bundler to module: preserve in tsconfig.json
- add clarifying comment about global regex usage in src/type-script-project.ts


### Miscellaneous Chores

* **docs:** remove AI generate document unrelated to the project (3f31ad1ce93deff047a859961514e3978633fc6a)

## [1.7.2](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.7.1...v1.7.2) (2026-04-01)

### Bug Fixes

* resolve regex state, circular dependencies, and path handling (321769cd3bf64bb3d40e06ae3b437d121dbe3fda)
- Remove global flags from regex constants to prevent stateful matching bugs
- Update regex usage in tests and environment variable expansion to avoid index issues
- Track visited paths in declaration-bundler to prevent infinite dependency loops
- Fix file watcher ignore logic to properly match specific directories
- Fix source maps generated by decorator metadata plugin to use relative paths


### Code Refactoring

* improve type definitions and utility names (dc21288c723217b678630371b6aacead82fef47c)
- Rename Function type to Fn to prevent conflicts with global Function type
- Rename PrettyModify type utility to Modify for concise naming
- Change typeReferences and fileReferences to ReadonlySet for better immutability guarantees
- Update DtsCompilerOptions paths array type from RelativePath to string


### Miscellaneous Chores

* **deps:** updated dev dependencies (4137a8cc6f79110297347a02a9b9fef32e35d865)
* update dependencies and release configuration (3f19d52c7f199ddbf4afcd91a1b52d79d6c25bd3)
- Add major release trigger for breaking changes in semantic-release config
- Update eslint-plugin-jsdoc to version 62.9.0
- Update transitive dependencies in lockfile

## [1.7.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.7.0...v1.7.1) (2026-03-29)

### Code Refactoring

* **bundler:** remove internal index files and improve declaration bundling (0299420b919a09fab5f3988124296e8105a21c7f)
- Updates package.json types and exports to point to type-script-project instead of index
- Removes src/index.ts and src/dts/index.ts files
- Updates test imports to reference declaration-bundler directly instead of via index
- Fixes declaration bundler to gracefully handle entry points without declaration files
- Updates declaration bundler to ensure the output directory exists before writing
- Refines declaration identifier conflict mapping to use Set for finalTypeExports
- Updates file-manager to skip processing and writing empty declaration files
- Removes internal Symbol.toStringTag from FileManager


### Styles

* update editorconfig indent size to 2 (e56b2b6dc13e4b53ff064db8a8b950cc1c6b23ae)
- Changes indent_size from 1 to 2 in .editorconfig

## [1.7.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.6.5...v1.7.0) (2026-03-27)

### Features

* **build:** add support for ES2025 ScriptTarget (2aecca9dc4ac67cd3e27021e34054a7c7552ebe9)
- Add `ES2025` targeting map for TS `ScriptTarget.ES2025` so newly produced esbuild configurations will honor it.


### Bug Fixes

* **dts:** infer reference types for node protocols and correct module mapping (03c4ec5859b3741b7f30d590b38ea9c729128eea)
- Add logic in the `DeclarationBundler` to automatically infer `/// <reference types="node" />` when `node:` protocol imports are merged in, so the generated `.d.ts` file remains self-contained.
- Stop stripping inline `type` keywords from import statements in the `DeclarationProcessor`, preserving them for `.d.ts` output correctness.
- Remove unused `inlineTypePattern` import due to removing the stripping logic.
- Fix minor property initialization order formatting in `DeclarationBundler`.
- Add testing specific to these fixes in `declaration-bundler.test.ts` and `declaration-processor.test.ts`.

* **env:** support dynamic process.env extraction in config values (9469b5963d9ac5c1473bf500e96baa841b04b586)
- Expand `process.env` references dynamically in ESBuild `define` objects to support runtime-bound values instead of just static strings.

* **release:** manually update the workspace file since pnpm can't seem to get it right (8795a7497ab9cc26991001ef09145f8d92097841)

### Code Refactoring

* **core:** simplify promise handling in TypeScript build configuration (e7b154ad9cf38347bf93cb3a48301753cead58e0)
- Remove intermediate `entryPointsPromise` variable and `.catch()` swallowing since rejection is natively handled when awaited later in the `build()` process.
- Improve the `tsbuildOptions` setup.

* **style:** remove explicit return types and clean up syntax (c306735aefb8ff4d4227f5bdaae21e7d0ed53f32)
- Remove redundant explicit return types from internal utility functions across several files (`constants`, `decorators`, `dts`, `file-manager`, `files`, `json`, `logger`, `paths`, etc.).
- Allow TypeScript to infer these return types automatically, reducing visual noise.
- Simplify closures to arrow functions or shortened arrow syntax where applicable.


### Documentation

* **EADDRINUSE:** add issue draft for WSL2 network issue (5f5ea0d31f6df8e85a4e586c5f8018a56e5b2702)
- Add a detailed bug report draft describing the `EADDRINUSE` issue that occurs on every single activation attempt when running under WSL2 with `networkingMode=Mirrored`.
- Include a minimal reproduction case that demonstrates the underlying Node.js `net.createServer().listen()` race condition in WSL2 mirrored networking.
- Provide expected behavior and output logs for the VS Code extension failure.
- Suggest a direct bind and instance retention fix instead of the current close-and-reopen approach.

* **README:** update isolatedModules and TS strict requirements (c4a491791b8ad9d90c909ce9a2f8d03e1aeb0521)
- Update the minimum supported TypeScript badge to `>=5.6.3`.
- Clarify that `isolatedModules` is strictly required due to the reliance on esbuild for transpilation.
- Remove the `strict` option note for newer TS versions since it is enabled by default in TypeScript 6.0+.
- Add an "Advanced Features" section explicitly explaining *why* `isolatedModules` is necessary for esbuild.


### Miscellaneous Chores

* **deps:** update package and lockfile dependencies (5a9f0623ffc63b42ddcdd7d2bc1882510f0a7d60)
- Update various devDependencies, including `typescript` to `^6.0.2` and related `@typescript-eslint` packages.
- Update `vitest` and coverage plugins to `^4.1.2`.
- Remove `@babel/plugin-proposal-decorators` and `@rolldown/plugin-babel` and replace Babel decorator handling in vitest config with a custom `esbuild` transformer.
- Add a `test:compat` script entry to test against 5 minor versions of TypeScript.
- Specify a peer dependency requirement for `typescript: >=5.6.3`.
- Modify `package.json` `types` field.
- Refresh and resolve `pnpm-lock.yaml` according to the new dependency state.

* **vscode:** set TS SDK path in settings (6e6622483d6648ba6cf283b362622665bd1dbede)
- Configure `.vscode/settings.json` to use the workspace `node_modules/typescript/lib` for the TypeScript language server.


### Tests

* **compat:** introduce multi-version TypeScript testing script (3ad98b8cc914d6e7c37237713b11568e97ef1bbf)
- Add a new compatibility test script `test-ts-compat.ts` that iterates through minor TypeScript versions dynamically.
- Conditionally add support for testing `ES2024` and `ES2025` script targets only if the installed version of TS contains them.
- Implement a comprehensive type-guard/API compatibility test in `typescript-compatibility.test.ts` to guarantee runtime API availability.
- Update `tsconfig.json` for tests with required strict compatibility changes.


### Continuous Integration

* **github:** add workflow for testing TypeScript compatibility (0c9bbbf8301ad66c4321fa9878169d66bbb1eda7)
- Create a new GitHub Actions workflow to run the test suite against multiple versions of TypeScript (5.6.3 to 6.0).
- Ensure backwards compatibility of the tools when run with older minimal supported TypeScript versions.
- Set up basic jobs utilizing `pnpm` and Node.js 24.

## [1.6.5](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.6.4...v1.6.5) (2026-03-21)

### Code Refactoring

* **bundler:** remove unused getModuleExports method (40be90ce03de5ada924ac6ac5d0966cceda7ade1)
- Remove dead private method getModuleExports from DeclarationBundler class


### Tests

* add json, incremental-build-cache tests and shared declaration fixtures (dadea76ceb2fa487124031bbef2b2532195a60dd)
- Add comprehensive tests for Json.parse and Json.serialize with primitives, arrays, and objects
- Add tests for IncrementalBuildCache covering restore, save, invalidate, isBuildInfoFile, and isValid
- Add tests for corrupt cache file handling, cache invalidation skipping restore, and round-trip save/restore
- Add shared declaration fixture file with reusable type definitions for bundler and processor tests
- Remove old build-cache.test.ts in favor of new incremental-build-cache.test.ts

* rewrite test suite with parameterized patterns and expanded coverage (dd30d901a7bcffcf743ae7bb91d6309377cdb49d)
- Rewrite text-formatter tests with it.each matrix patterns for formatting, color, bright, background, and bright background categories
- Rewrite paths tests with it.each matrix for isPath, add parse and isFile coverage, remove TestHelper boilerplate
- Rewrite logger tests with it.each matrices for isWrittenFiles/colorize/prettyBytes, remove memfs dependency, add header/separator/step/subSteps/EntryType tests
- Rewrite decorator-metadata plugin tests removing TestHelper dependency, simplify mock setup
- Rewrite external-modules plugin tests with it.each for bare specifiers and local paths, add packageName extraction tests
- Rewrite output plugin tests, add rewriteRelativeSpecifiers unit tests for extension-less and bare specifier handling
- Simplify process-manager tests by condensing redundant assertions and removing duplicate spy verifications
- Rewrite tsbuild CLI tests with it.each for --help/-h and --version/-v flags, group into describe blocks
- Expand type-script-project tests with triggerRebuild (rename, unlink, empty changes), close, handleBuildError (watch mode), resolveConfiguration (browser platform, entry point inference, invalid tsconfig, malformed package.json), getEntryPoints, and transpile (env expansion, esbuild warnings/errors, SWC decorator metadata plugin)
- Streamline integration tests with condensed fixtures and consistent Logger mock formatting
- Rewrite constants, declaration-bundler, declaration-processor, decorator, entry-points, errors, file-manager, and files tests with simplified patterns

## [1.6.4](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.6.3...v1.6.4) (2026-03-21)

### Bug Fixes

* **logging:** bypass formatting for empty error message arrays (7ced5ad268029ee763bafdfeda405c50faec8ad3)
- Check for messages length before invoking the format function
- Preclude unnecessary iteration over empty diagnostic outputs
- Prevent empty lines from being emitted to the console log stream


### Performance Improvements

* **plugins:** optimize build plugins and file operations (d5669224bff868001baf43a99efb409ec33d521e)
- Cache SWC transformFile reference lazy-loaded for decorator metadata
- Build reusable O(1) matchers for external modules string and RegExp patterns
- Extract package names properly handling scoped and unscoped module paths
- Cache shared TextEncoder and TextDecoder instances for output generation
- Preserve shebangs and set correct execute permissions on output scripts
- Optimize extension rewriting to only trigger string replacements when modified


### Miscellaneous Chores

* **deps:** update watchr and eslint dependencies (619d559159bb358cef75b36e99223999a0c6da57)
- Update @d1g1tal/watchr package to version 1.0.4
- Update eslint package to version 10.1.0
- Synchronize pnpm-lock.yaml with new dependency versions
- Update typescript-eslint plugin and parser dependencies in lockfile

## [1.6.3](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.6.2...v1.6.3) (2026-03-18)

### Bug Fixes

* updated regex to allow minified output to have the proper extensions in the imports (23ab153ec4e1e07a10a4c21b692491031557f03b)

## [1.6.2](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.6.1...v1.6.2) (2026-03-18)

### Bug Fixes

* **compiler:** rewrite relative specifiers to include .js extension (39bc1a19d6d79cebb298e7717435591099f47c11)
- Add relativeSpecifierPattern to detect bare relative imports
- Implement rewriteRelativeSpecifiers to append .js for ESM Node resolution
- Apply rewriteRelativeSpecifiers before writing files in FileManager
- Update fileMapper in output plugin to rewrite JS contents


### Miscellaneous Chores

* **workspace:** update workspace configurations and metadata (af85d4d72aa726a9f1d2b5ef60dc2e3beae8318c)
- Remove FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 from github actions CI
- Add compiler, type-checking, and library keywords to package.json
- Format babel preset plugins array in vitest.config.ts
- Disable typecheck in vitest configuration explicitly

## [1.6.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.6.0...v1.6.1) (2026-03-18)

### Bug Fixes

* **test:** workaround vitest 4.1 decorator regression (e018d99561fad324f4f8c73bf34fd6b4fcd881e5)
- add @rolldown/plugin-babel and @babel/plugin-proposal-decorators to devDependencies
- update vitest.config.ts to transform decorators using babel
- introduce tests/tsconfig.json for test environment typing
- bump typescript-eslint and @types/node dependencies
- sync pnpm-lock.yaml with updated dependencies


### Miscellaneous Chores

* **pkg:** update package manager and project scripts (57a0ff3aa552d49aa56745bd0179ee245fd70ac7)
- bump pnpm packageManager field to 10.32.1
- include CHANGELOG.md in the list of published files
- remove deprecated prepare script
- add test:watch convenience script for vitest

* **style:** add editorconfig (55d07cb8090f6874e7f16a5c7943309e6ade8f64)
- establish consistent coding styles across the workspace
- configure standard indents, charsets, and newline rules


### Continuous Integration

* force actions to use Node.js 24 (9eaac47d702c40ce9d8aeb7b7e6d990ccfa3b51d)
* updated actions to latest versions (a5a7b0f36420cad83192fca489c5ff9bc376b9d7)
* upgrade github actions runner versions (b9ed4f72294dee56713155623b016fc4951c8931)
- bump actions/checkout to v6
- bump pnpm/action-setup to v5
- bump actions/setup-node to v6
- enforce using latest npm globally in publish workflow

## [1.6.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.5.0...v1.6.0) (2026-03-12)

### Features

* **logger:** add ANSI-safe header width and styled build banner (6dd2e72306dcc29998b2a1900c51e044d5cd0b9a)
- Fix header box width calculation by stripping ANSI escape codes before measuring message length
- Add TextFormat import to TypeScriptProject for use in the build header
- Prefix build header message with a styled blue TS logo
- Rename logPerformance label from 'Process Declarations' to 'Bundle Declarations'
- Update logger subSteps test to cover filtering behaviour and new PerformanceSubStep shape
- Add test case asserting nothing is logged when all steps are below the threshold


### Bug Fixes

* **incremental:** prevent false change detection on .tsbuildinfo writes (8cb4d9631336d1a2a4401da0b1bcdacdc873bb6a)
- Remove forced declarationDir: undefined override from compiler option overrides
- Remove corresponding type entry from CompilerOptionOverrides
- Move hasEmittedFiles tracking inside the non-buildinfo branch of fileWriter so only real output files (not .tsbuildinfo) set the flag
- Return true from the hasChanged check when declaration:false is set, ensuring esbuild always runs when declarations are disabled
- Add test verifying that writing only .tsbuildinfo does not set the emitted flag
- Update existing incremental no-changes test to properly simulate a prior build with cached declarations
- Update test asserting esbuild is always invoked for declaration:false projects
- Remove outdated declarationDir override test
- Remove outdated test asserting esbuild was skipped for declaration:false incremental builds
- Add incremental: false to basic build integration tests to keep them hermetic


### Performance Improvements

* **logger:** filter sub-steps below 5ms to reduce build output noise (fe37d375ca8f3ee79f3c1602cc0240f0d6aefd94)
- Add ms field to PerformanceSubStep type to carry the raw numeric duration
- Update addPerformanceStep to accept a number and derive the formatted string internally
- Update TypeScriptProject.elapsed() to return a number instead of a pre-formatted string
- Update all call sites to pass numeric millisecond values
- Filter out sub-steps with ms < 5 before logging; return early if nothing remains
- Update tests to reflect the new numeric API and updated PerformanceSubStep shape


### Documentation

* update runtime requirements, watchr link, and exports docs (5fe88a82785f56743f82e68622e9986924444b10)
- Bump minimum Node.js requirement from 20.16.0 to 22+ in README and copilot instructions
- Bump minimum pnpm requirement from 9+ to 10+ in copilot instructions
- Update watchr link in README to point to the correct fork repository
- Update exports condition list to include node and module conditions
- Remove stale Performance Notes and Testing Gaps sections from copilot instructions


### Miscellaneous Chores

* **deps:** update dependencies (3b4a3acacd4306e9110b1d1858ce2e43326c8c31)

### Build System

* **deps:** bump esbuild, vitest, and related packages (4f10321b7772e0ea6c94faa86d38f3156d3a0f7b)
- Upgrade esbuild from 0.27.3 to 0.27.4
- Upgrade vitest and @vitest/* packages from 4.0.18 to 4.1.0
- Upgrade @vitest/coverage-v8 from 4.0.18 to 4.1.0
- Upgrade eslint-plugin-jsdoc from 62.7.1 to 62.8.0
- Add convert-source-map 2.0.0 as new transitive dependency
- Upgrade ast-v8-to-istanbul from 0.3.12 to 1.0.0
- Upgrade es-module-lexer from 1.7.0 to 2.0.0
- Upgrade std-env from 3.10.0 to 4.0.0
- Upgrade tinyrainbow from 3.0.3 to 3.1.0
- Update pnpm-lock.yaml to reflect all dependency changes
- Remove prepublishOnly script from package.json

## [1.5.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.4.1...v1.5.0) (2026-03-08)

### Features

* **compiler:** always inject 'node' into compiler types (04f1e680dc9a8a76458fd82831f007463588fa6b)
- Merges 'node' into the resolved types array when building the TypeScript incremental program, using a Set to deduplicate
- User-specified types from tsconfig and tool options are preserved and merged, so 'node' is always present without overwriting other entries

* **compiler:** force declarationDir to undefined in overrides (f1fd8efb22658cedf75f296567fc96af618731c8)
- Adds declarationDir: undefined to CompilerOptionOverrides type and constant so .d.ts output always goes to outDir, making declaration files reliably discoverable by the bundler regardless of user tsconfig settings
- Updates the constants test to assert declarationDir is undefined in the overrides object


### Documentation

* update minimum node.js version to 22+ (39e4a319afe4718b052ee2170583e9a928c2dc8a)
- Updates the README description to reflect that the tool targets Node.js 22+ instead of the previously stated 20.16.0+


### Miscellaneous Chores

* **ci:** update the noode version for the README.md badge and packageManager pnpm version (89467c98966ea232fc015df8c6e5fbcaeb327b55)
* **docs:** moved quick start section after installation and fixed some spelling errors (ea23a1a3e2a576c73caaa79514db3306576cd1fd)
* **docs:** update the incremental builds section (9a971879a09a48ffb91177a34a3b9daaa8046f38)

### Tests

* **compiler:** add tests for declarationDir and types overrides (a5ba00a8ed1190ff531e1dbb0af4db8880bbb18f)
- Adds a test asserting declarationDir is overridden to undefined even when set in tsconfig
- Adds a test asserting types defaults to include 'node' when not specified in tsconfig
- Adds a test asserting user-specified types are merged with the 'node' default
- Adds a test asserting 'node' is not duplicated when the user already includes it
- Adds a @types/node stub in the memfs test environment to prevent TS2688 errors during test runs where node_modules is unavailable
- Fixes mock type casts to use 'as unknown as Diagnostic' for stricter TypeScript compatibility
- Changes private transpile() call in a test to use bracket access to avoid visibility errors

## [1.4.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.4.0...v1.4.1) (2026-03-08)

### Bug Fixes

* **ci:** drop node 20 and fix publish git checks (3ff1b239fcc1f7d2d0814bc59d3a61632671e043)
- Removes Node.js 20 from the CI test matrix, keeping only 22 and 24 as actively tested versions
- Adds --no-git-checks to the publish command to prevent pnpm from blocking the release due to git state checks in the semantic-release automation context

## [1.4.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.3.2...v1.4.0) (2026-03-08)

### Features

* **cache:** add isValid() to BuildCache interface (2987352e2391ccf62c032e68ee668468cd18ddf0)
- Adds isValid() method to IncrementalBuildCache returning !this.invalidated
- Adds isValid(): boolean to the BuildCache interface with JSDoc
- Adds missing JSDoc comments to other BuildCache interface methods
- Fixes incremental build header label to only show when cache is actually valid


### Documentation

* expand Quick Start section in README (c31223b8296100af4899fcdec468580b5fe72a4f)
- Adds minimal config example showing no tsbuild section is needed
- Adds noExternal usage example for bundling a specific package
- Adds preferred incremental tsconfig setup with annotated options
- Adds preferred non-incremental tsconfig setup for CI environments
- Clarifies entry point inference and external dependency defaults


### Build System

* update package metadata, deps, and release config (f203cf1611b337509e1f8c30d3b3ff9aebd28f1e)
- Reorganizes package.json field order, grouping author/license/homepage/repository/bugs/maintainers/engines/publishConfig near the top
- Adds maintainers field with name and email
- Adds README.md and LICENSE to published files list
- Moves keywords field to end of package.json
- Updates release commands in .releaserc.json to use pnpm with lint and build steps before pack
- Switches publishCmd to pnpm publish --provenance
- Reorders tsconfig.json compiler options for clarity, groups isolated/verbatim options, moves lib after noUncheckedIndexedAccess, removes moduleDetection: force
- Bumps @types/node, eslint, and memfs dev dependencies to latest minor versions
- Updates pnpm-lock.yaml to reflect all dependency version changes

## [1.3.2](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.3.1...v1.3.2) (2026-03-01)

### Bug Fixes

* updated the entry point inferrence handling message to be more helpful (eeddaaab6faf553098cbf0e85ecd9f0c05d22718)

### Tests

* remove test coverage (6f2ba17ce701d2b37232ab0f8fb64f4891557bee)

## [1.3.1](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.3.0...v1.3.1) (2026-03-01)

### Bug Fixes

* **entry-points:** Resolves conditional exports (65a5d4835ba51e906422982ad1e4d1ba83eeae94)

### Documentation

* updated readme to include tsdown in the tool comparison section (ad3f38a38d05314aabbcc10bba1e55856b50086d)

### Miscellaneous Chores

* **repo:** Updates ignore and README badges (9bdd6ce61a2f97b92ede9f118df7b20aaabb0074)

## [1.3.0](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.2.5...v1.3.0) (2026-02-28)

### Features

* **logger:** add sub-step tree logging to performance output (2a775ca35d4b3524d2862f6e3b5e15040c2efb55)
Introduces timed sub-step display beneath each build step in the
performance log, making it easy to see where time is spent within a
single decorated method.

- Adds PerformanceSubStep type and exports it from the public types index
- Extends PerformanceEntryDetail to carry an optional steps array
- Adds Logger.subSteps() with tree-style ├─/└─ formatting and aligned columns
- Adds module-level pendingSteps buffer to the performance decorator
- Exports addPerformanceStep() so callers can register sub-steps during a decorated call
- Flushes pending steps into the measurement detail inside the measure decorator
- Calls Logger.subSteps() from the observer when steps are present
- Adds unit tests for Logger.subSteps() alignment and single-item edge case
- Adds unit test verifying sub-step attachment and observer rendering
- Updates Logger mock in all affected test files to include subSteps

* **type-script-project:** add per-phase timing to type-check step (acaf8a0c432bb9d340f2441a59577153c7d67ade)
Instruments the three distinct phases of a type-check cycle with
sub-step performance marks so the log shows exactly where build
time is being spent.

- Imports addPerformanceStep and the perf_hooks performance API
- Wraps emit, diagnostics collection, and finalize with performance marks
- Adds a private static elapsed() helper to compute and format duration from a named mark
- Updates finalize() call-site to drop the now-unnecessary await


### Performance Improvements

* **file-manager:** defer emit work and make cache saves async (afe576b5969c7088ccfd77a22e6cd0b6555e1974)
Reduces time spent inside TypeScript's synchronous emit() call by
deferring declaration pre-processing and .tsbuildinfo I/O to a
separate step after emit() returns. Cache persistence becomes a
fire-and-forget promise, unblocking the current build's parallel
phases.

- Buffers raw declaration text and .tsbuildinfo content in fileWriter instead of processing synchronously
- Introduces processEmittedFiles() to run AST creation and pre-processing after emit
- Changes finalize() from async to sync; starts a background save promise
- Adds flush() to await any in-flight background I/O when needed
- Updates initialize() and close() to handle pending save state correctly
- Removes the unused synchronous sys import from typescript
- Updates JSDoc to reflect the deferred processing model
- Removes await from all finalize() call-sites in tests
- Adds explicit finalize() calls in tests that inspect declaration files directly
- Adds await flush() in tests that read cache state from a second instance

## [1.2.5](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.2.4...v1.2.5) (2026-02-28)

### Bug Fixes

* **decorator-metadata:** make @swc/core a true optional dep (69d35717e6f941cf9591097629b51858d3d282f0)
The static import of @swc/core was removed in an earlier commit that
made it an optional peer dependency, but the plugin still used a
static import at the top of the file, causing the now-working
type-checker to surface a TS2307 resolution error.

Converts the import to a dynamic import inside the onLoad callback so
it is only resolved when the plugin is actually used. Adds a minimal
ambient module declaration so TypeScript can resolve the shape of the
dynamic import without requiring @swc/core to be installed.

Changed files:
- src/@types/swc.d.ts
- src/plugins/decorator-metadata.ts

* **type-check:** include semantic diagnostics in type-check (2a3400a73aef2a6b6ac6c3e29ad56369c666ea6a)
Previously, only emit-phase diagnostics were checked, causing all
semantic errors (e.g. TS2307, TS2322) to be silently ignored.

Fixes this by explicitly calling getSemanticDiagnostics() and merging
the result with emit diagnostics before checking for errors.

Changed files:
- src/type-script-project.ts
- tests/type-script-project.test.ts

## [1.2.4](https://github.com/D1g1talEntr0py/tsbuild/compare/v1.2.3...v1.2.4) (2026-02-28)

### Code Refactoring

* **deps:** remove @swc/core optional dependency (6eeff9af10e8e0ca469699cccd580127c5160df5)
- Removes @swc/core and @swc/types as optional dependencies from package.json
- Updates pnpm-lock.yaml to drop all @swc/* package entries and snapshots
- Bumps pnpm packageManager version to 10.30.3
- Rewrites README introduction to clarify the tool's purpose and tone
- Adds TC39 standard decorators as a first-class supported feature with no extra dependencies
- Splits legacy decorator metadata into its own feature bullet, noting @swc/core must be installed manually
- Replaces the three-phase build description with a clearer two-phase explanation
- Adds a Quick Start section showing the minimal tsconfig.json setup and how to run a build
- Simplifies installation instructions by removing the --no-optional flag example
- Adds an explicit note that @swc/core will never be installed automatically
- Expands the Configuration section with an explanation of how tsconfig.json compilerOptions are honoured automatically
- Adds a comment to the entryPoints example clarifying that entry points can be inferred from package.json
- Adds a CLI usage note clarifying global vs local install invocation
- Adds a dedicated Incremental Builds section documenting both caches, the .tsbuild/ directory, and the --force and --clearCache flags
- Rewrites the Decorator Metadata section to lead with TC39 standard decorators and move legacy decorator metadata to a secondary subsection
- Clarifies that the build fails with a helpful message if @swc/core is missing when emitDecoratorMetadata is set
- Corrects the parallel processing performance note to accurately describe declaration bundling and transpilation running in parallel after type checking
- Fixes the circular dependency warning description to say tsbuild continues rather than just emitting a warning
- Updates the Limitations section to remove the Experimental label and improve the plugins limitation description
- Updates the comparison table to split decorator support into TC39 and legacy rows
- Changes the license from ISC to MIT
- Removes the closing disclaimer recommending tsup for production use

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
