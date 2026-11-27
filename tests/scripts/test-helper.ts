import { vol, type DirectoryJSON } from 'memfs';
import { vi } from 'vitest';
import { resolve, join, dirname, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Loader, Plugin } from 'esbuild';
import { API } from 'typescript/sync';
import { serverFS, type FileSystemCallbacks } from 'typescript/fs';
import type { AbsolutePath, CachedDeclaration } from '../../src/@types';
import { DeclarationProcessor } from '../../src/dts/declaration-processor';

// Re-export vol for convenience
export { vol };

type TestProjectOptions = {
	tsconfig?: Record<string, unknown> & {
		compilerOptions?: Record<string, unknown>;
		tsbuild?: Record<string, unknown>;
		include?: string[];
		exclude?: string[];
	};
	files?: Record<string, string>;
	packageJson?: Record<string, unknown>;
};

/**
 * Test helper for setting up memfs-based tests.
 * Provides utilities for mocking the filesystem, creating test projects,
 * and a shared TypeScript native API whose filesystem overlays memfs on the real filesystem.
 */
export class TestHelper {
	private static sharedApi: API | undefined;
	private static importOutputId = 0;

	/**
	 * Shared TypeScript API for parsing and module resolution in tests.
	 * Paths present in memfs are served from memfs; everything else (TypeScript libs, node_modules) falls through to the OS.
	 */
	static get api(): API {
		return this.sharedApi ??= new API({ cwd: process.cwd(), fs: this.memfsCallbacks() });
	}

	/** Closes the shared TypeScript API process. */
	static closeApi() {
		this.sharedApi?.close();
		this.sharedApi = undefined;
	}

	/**
	 * Host filesystem callbacks that read from memfs and fall back to the OS for paths memfs does not contain.
	 */
	static memfsCallbacks(): FileSystemCallbacks {
		const isDirectory = (path: string) => vol.existsSync(path) && vol.statSync(path).isDirectory();
		const isFile = (path: string) => vol.existsSync(path) && !vol.statSync(path).isDirectory();

		return {
			directoryExists: (path) => isDirectory(path) || serverFS.useOS,
			fileExists: (path) => isFile(path) || serverFS.useOS,
			getAccessibleEntries: (path) => {
				if (!isDirectory(path)) { return serverFS.useOS }
				const files: string[] = [];
				const directories: string[] = [];
				for (const entry of vol.readdirSync(path) as string[]) {
					(isDirectory(join(path, entry)) ? directories : files).push(entry);
				}
				return { files, directories, symlinks: undefined };
			},
			readFile: (path) => isFile(path) ? vol.readFileSync(path, 'utf8') as string : serverFS.useOS,
			realpath: (path) => vol.existsSync(path) ? path : serverFS.useOS,
			stat: (path) => {
				if (!vol.existsSync(path)) { return serverFS.useOS }
				const { mode, size, mtime } = vol.statSync(path);
				return { mode: Number(mode), size: Number(size), mtime };
			},
			writeFile: (path, content) => {
				vol.mkdirSync(dirname(path), { recursive: true });
				vol.writeFileSync(path, content);
			},
			removeFile: (path) => { vol.rmSync(path, { recursive: true, force: true }) }
		};
	}

	/**
	 * Resets the memfs volume and stubs @types/node.
	 * Call this in beforeEach for tests that need memfs.
	 */
	static async setupMemfs() {
		vol.reset();
		vol.mkdirSync(process.cwd(), { recursive: true });

		const path = await vi.importActual<typeof import('node:path')>('node:path');

		// Create a minimal @types/node stub so `types: ["node"]` in compilerOptions
		// doesn't emit TS2688 ("Cannot find type definition file for 'node'") in the
		// memfs environment where node_modules is not available.
		const atTypesNodeDir = path.join(process.cwd(), 'node_modules', '@types', 'node');
		vol.mkdirSync(atTypesNodeDir, { recursive: true });
		vol.writeFileSync(path.join(atTypesNodeDir, 'index.d.ts'), '// stub\nexport {};\n');
	}

	/**
	 * Alias for setupMemfs for compatibility.
	 */
	static async setup(files: DirectoryJSON = {}) {
		await this.setupMemfs();
		if (Object.keys(files).length > 0) {
			vol.fromJSON(files, process.cwd());
		}

		// Ensure we have a valid package.json in cwd if not provided
		if (!vol.existsSync(join(process.cwd(), 'package.json'))) {
			vol.writeFileSync(join(process.cwd(), 'package.json'), JSON.stringify({
				name: 'test-project',
				version: '1.0.0',
				type: 'module'
			}));
		}
	}

	/**
	 * Resets memfs.
	 * Call this in afterEach.
	 */
	static teardownMemfs() {
		vol.reset();
	}

	/**
	 * Alias for teardownMemfs for compatibility.
	 */
	static teardown() {
		this.teardownMemfs();
		vi.restoreAllMocks();
	}

	/**
	 * Creates a standard test project structure in memfs.
	 * @returns The project root path (cwd).
	 */
	static createTestProject(options: TestProjectOptions) {
		const cwd = process.cwd();

		const defaultTsConfig = {
			compilerOptions: {
				target: 'ES2022',
				module: 'ESNext',
				moduleResolution: 'bundler',
				esModuleInterop: true,
				skipLibCheck: true,
				outDir: './dist',
				declaration: true,
				...options.tsconfig?.['compilerOptions'],
			},
			tsbuild: {
				entryPoints: { index: './src/index.ts' },
				...options.tsconfig?.['tsbuild'],
			},
			include: options.tsconfig?.['include'] || ['src/**/*'],
			exclude: options.tsconfig?.['exclude'] || ['node_modules', 'dist'],
			...options.tsconfig,
		};

		const defaultPackageJson = {
			name: 'test-project',
			version: '1.0.0',
			type: 'module',
			...options.packageJson,
		};

		const defaultFiles = {
			'src/index.ts': 'export const hello = "world";',
			...options.files,
		};

		const jsonFiles: DirectoryJSON = {
			'tsconfig.json': JSON.stringify(defaultTsConfig, null, 2),
			'package.json': JSON.stringify(defaultPackageJson, null, 2),
		};

		for (const [path, content] of Object.entries(defaultFiles)) {
			jsonFiles[path] = content;
		}

		vol.fromJSON(jsonFiles, cwd);
		return cwd;
	}

	/**
	 * Creates a CachedDeclaration from raw declaration code.
	 * Pre-processes the code through DeclarationProcessor.preProcess to match
	 * what the build system produces.
	 */
	static createCachedDeclaration(code: string): CachedDeclaration {
		using retained = this.api.createSourceFile('/temp.d.ts', code);
		const { code: processedCode, typeReferences, fileReferences } = DeclarationProcessor.preProcess(retained.sourceFile);
		return {
			code: processedCode,
			typeReferences,
			fileReferences
		};
	}

	/**
	 * Creates a Map of CachedDeclaration objects from raw string content.
	 * Useful for testing bundleDeclarations with the new cache format.
	 */
	static createDeclarationFilesMap(entries: [string, string][]): Map<AbsolutePath, CachedDeclaration> {
		const map = new Map<AbsolutePath, CachedDeclaration>();
		for (const [path, code] of entries) {
			map.set(resolve(path) as AbsolutePath, this.createCachedDeclaration(code));
		}
		return map;
	}

	/**
	 * Checks if a file exists in the memfs volume.
	 */
	static fileExists(path: string): boolean {
		return vol.existsSync(path);
	}

	/**
	 * Reads a file from the memfs volume.
	 */
	static readFile(path: string): string {
		return vol.readFileSync(path, 'utf-8') as string;
	}

	/**
	 * Loads generated JavaScript as an ESM module for runtime assertions.
	 */
	static async importOutput<T extends object>(path: string): Promise<T> {
		const url = pathToFileURL(path);
		url.searchParams.set('test', String(this.importOutputId++));
		return await import(url.href) as T;
	}

	/**
	 * Creates an esbuild plugin that resolves and loads files from memfs.
	 */
	static createEsbuildPlugin(): Plugin {
		return {
			name: 'memfs-plugin',
			setup(build) {
				build.onResolve({ filter: /.*/ }, (args) => {
					let resolveDir = args.resolveDir;

					if (!resolveDir && args.importer) {
						let importer = args.importer;
						if (importer.startsWith('memfs:')) {
							importer = importer.slice(6);
						}
						resolveDir = dirname(importer);
					}

					if (!resolveDir) {
						resolveDir = process.cwd();
					}

					let absolutePath = args.path;
					if (!isAbsolute(args.path)) {
						if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
							return null; // Let esbuild resolve packages
						}
						absolutePath = resolve(resolveDir, args.path);
					}

					// Try exact match
					if (vol.existsSync(absolutePath)) {
						return { path: absolutePath, namespace: 'memfs' };
					}

					// Try replacing .js/.jsx with .ts/.tsx
					if (absolutePath.endsWith('.js') || absolutePath.endsWith('.jsx')) {
						const tsPath = absolutePath.replace(/\.js(x?)$/, '.ts$1');
						if (vol.existsSync(tsPath)) {
							return { path: tsPath, namespace: 'memfs' };
						}
					}

					// Try extensions
					const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.d.ts'];
					for (const ext of extensions) {
						if (vol.existsSync(absolutePath + ext)) {
							return { path: absolutePath + ext, namespace: 'memfs' };
						}
					}

					// Try directory index
					for (const ext of extensions) {
						const indexPath = join(absolutePath, `index${ext}`);
						if (vol.existsSync(indexPath)) {
							return { path: indexPath, namespace: 'memfs' };
						}
					}

					return null;
				});

				build.onLoad({ filter: /.*/, namespace: 'memfs' }, (args) => {
					if (vol.existsSync(args.path) && !vol.statSync(args.path).isDirectory()) {
						const contents = vol.readFileSync(args.path, 'utf8');
						const ext = extname(args.path);
						const loaderMap: Record<string, Loader> = {
							'.ts': 'ts', '.tsx': 'tsx', '.js': 'js',
							'.jsx': 'jsx', '.json': 'json'
						};
						const loader = loaderMap[ext] || 'default';
						return { contents: contents.toString(), loader, resolveDir: dirname(args.path) };
					}
					return null;
				});
			}
		};
	}

	/**
	 * Creates a project in a real temp directory on disk.
	 * Symlinks the project node_modules so TypeScript and esbuild can resolve packages.
	 * Use for end-to-end tests that exercise real TypeScript compilation and real esbuild.
	 * @returns Project directory path and an async cleanup function.
	 */
	static async createTempProject(options: {
		files?: Record<string, string>;
		tsconfig?: TestProjectOptions['tsconfig'];
		packageJson?: Record<string, unknown>;
	} = {}): Promise<{ dir: string; cleanup: () => Promise<void> }> {
		const { mkdtemp, mkdir, writeFile, rm, symlink } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
		const { tmpdir } = await vi.importActual<typeof import('node:os')>('node:os');
		const { join: pathJoin, dirname: pathDirname } = await vi.importActual<typeof import('node:path')>('node:path');

		const dir = await mkdtemp(pathJoin(tmpdir(), 'tsbuild-test-'));

		// Symlink real node_modules so TypeScript finds @types/node and esbuild finds packages
		await symlink(pathJoin(process.cwd(), 'node_modules'), pathJoin(dir, 'node_modules'));

		const defaultTsConfig = {
			compilerOptions: {
				target: 'ES2022',
				module: 'ESNext',
				moduleResolution: 'bundler',
				strict: true,
				outDir: './dist',
				declaration: true,
				...(options.tsconfig?.['compilerOptions'] ?? {})
			},
			tsbuild: {
				entryPoints: { index: './src/index.ts' },
				clean: false,
				...(options.tsconfig?.['tsbuild'] ?? {})
			},
			include: options.tsconfig?.['include'] ?? ['src/**/*']
		};

		const defaultPackageJson = {
			name: 'test-project',
			version: '1.0.0',
			type: 'module',
			...(options.packageJson ?? {})
		};

		const defaultFiles = {
			'src/index.ts': 'export const hello = "world";',
			...(options.files ?? {})
		};

		await writeFile(pathJoin(dir, 'tsconfig.json'), JSON.stringify(defaultTsConfig, null, 2));
		await writeFile(pathJoin(dir, 'package.json'), JSON.stringify(defaultPackageJson, null, 2));

		for (const [filePath, content] of Object.entries(defaultFiles)) {
			await mkdir(pathJoin(dir, pathDirname(filePath)), { recursive: true });
			await writeFile(pathJoin(dir, filePath), content);
		}

		return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
	}

	/**
	 * Mocks esbuild to redirect writes to memfs.
	 * For builds with `write: true`, injects a plugin that captures outputFiles
	 * into memfs before other onEnd callbacks run, then forces `write: false`.
	 * Builds already using `write: false` pass through unchanged.
	 */
	static async mockEsbuild() {
		vi.doMock('esbuild', async (importOriginal) => {
			const real = await importOriginal<typeof import('esbuild')>();
			const { fs: memfs } = await import('memfs');
			const { dirname: pathDirname } = await import('node:path');

			const writeToMemfsPlugin: Plugin = {
				name: 'test:write-to-memfs',
				setup(build) {
					build.onEnd(({ outputFiles }) => {
						if (!outputFiles) { return }
						for (const file of outputFiles) {
							memfs.mkdirSync(pathDirname(file.path), { recursive: true });
							memfs.writeFileSync(file.path, Buffer.from(file.contents));
						}
					});
				}
			};

			return {
				...real,
				build: async (options: import('esbuild').BuildOptions) => {
					if (options.write === false) {
						return real.build(options);
					}
					return real.build({
						...options,
						write: false,
						plugins: [writeToMemfsPlugin, ...(options.plugins ?? [])]
					});
				}
			};
		});
	}
}
