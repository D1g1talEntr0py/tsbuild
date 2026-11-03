import { vol, type DirectoryJSON } from 'memfs';
import { vi } from 'vitest';
import { resolve, join, dirname, isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Loader, Plugin } from 'esbuild';
import { API } from 'typescript/sync';
import { serverFS, type FileSystemCallbacks } from 'typescript/fs';
import type { CachedDeclaration } from '../../src/@types';
import { DeclarationProcessor } from '../../src/dts/declaration-processor';

// Re-export vol for convenience
export { vol };

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
	static createTestProject(options: {
		tsconfig?: Record<string, any>;
		files?: Record<string, string>;
		packageJson?: Record<string, any>;
	}) {
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
	static createDeclarationFilesMap(entries: [string, string][]): Map<string, CachedDeclaration> {
		const map = new Map<string, CachedDeclaration>();
		for (const [path, code] of entries) {
			map.set(path, this.createCachedDeclaration(code));
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
		tsconfig?: Record<string, unknown>;
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
				...(options.tsconfig?.['compilerOptions'] as Record<string, unknown> ?? {})
			},
			tsbuild: {
				entryPoints: { index: './src/index.ts' },
				clean: false,
				...(options.tsconfig?.['tsbuild'] as Record<string, unknown> ?? {})
			},
			include: (options.tsconfig?.['include'] as string[]) ?? ['src/**/*']
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
	 * Mocks fs and fs/promises globally with fallback to real fs.
	 * Use for integration tests that need full fs mocking.
	 */
	static async mockFs() {
		const setupFsMock = async (moduleName: string) => {
			vi.doMock(moduleName, async (importOriginal) => {
				const realFs = await importOriginal<any>();
				const { fs: memfs } = await import('memfs');

				const isPromises = moduleName.includes('promises');

				const shouldFallback = (path: string) => {
					if (memfs.existsSync(path)) return false;
					const relativePath = path.startsWith(process.cwd()) ? path.slice(process.cwd().length + 1) : path;
					if (!isAbsolute(path) && !path.startsWith('.')) {
						if (path.startsWith('node_modules')) return true;
						return false;
					}
					if (path.startsWith(process.cwd())) {
						if (relativePath.startsWith('node_modules')) return true;
						return false;
					}
					return true;
				};

				if (isPromises) {
					return {
						...realFs,
						default: { ...realFs },
						readFile: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.readFile as Function)(path, ...args);
							return (realFs.readFile as Function)(path, ...args);
						},
						writeFile: async (path: any, ...args: any[]) => (memfs.promises.writeFile as Function)(path, ...args),
						readdir: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.readdir as Function)(path, ...args);
							return (realFs.readdir as Function)(path, ...args);
						},
						stat: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.stat as Function)(path, ...args);
							return (realFs.stat as Function)(path, ...args);
						},
						lstat: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.lstat as Function)(path, ...args);
							return (realFs.lstat as Function)(path, ...args);
						},
						mkdir: async (path: any, ...args: any[]) => (memfs.promises.mkdir as Function)(path, ...args),
						rm: async (path: any, ...args: any[]) => (memfs.promises.rm as Function)(path, ...args),
						access: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.access as Function)(path, ...args);
							return (realFs.access as Function)(path, ...args);
						},
						open: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.open as Function)(path, ...args);
							return (realFs.open as Function)(path, ...args);
						},
						chmod: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.chmod as Function)(path, ...args);
							return (realFs.chmod as Function)(path, ...args);
						},
					};
				}

				return {
					...realFs,
					default: { ...realFs },
					readFileSync: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.readFileSync as Function)(path, ...args);
						return (realFs.readFileSync as Function)(path, ...args);
					},
					readFile: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.readFile as Function)(path, ...args);
						return (realFs.readFile as Function)(path, ...args);
					},
					writeFileSync: (path: any, ...args: any[]) => (memfs.writeFileSync as Function)(path, ...args),
					writeFile: (path: any, ...args: any[]) => (memfs.writeFile as Function)(path, ...args),
					readdir: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.readdir as Function)(path, ...args);
						return (realFs.readdir as Function)(path, ...args);
					},
					readdirSync: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.readdirSync as Function)(path, ...args);
						return (realFs.readdirSync as Function)(path, ...args);
					},
					stat: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.stat as Function)(path, ...args);
						return (realFs.stat as Function)(path, ...args);
					},
					statSync: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.statSync as Function)(path, ...args);
						return (realFs.statSync as Function)(path, ...args);
					},
					lstat: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.lstat as Function)(path, ...args);
						return (realFs.lstat as Function)(path, ...args);
					},
					lstatSync: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.lstatSync as Function)(path, ...args);
						return (realFs.lstatSync as Function)(path, ...args);
					},
					existsSync: (path: any) => {
						if (!shouldFallback(path.toString())) return (memfs.existsSync as Function)(path);
						return realFs.existsSync(path);
					},
					mkdir: (path: any, ...args: any[]) => (memfs.mkdir as Function)(path, ...args),
					mkdirSync: (path: any, ...args: any[]) => (memfs.mkdirSync as Function)(path, ...args),
					rm: (path: any, ...args: any[]) => (memfs.rm as Function)(path, ...args),
					rmSync: (path: any, ...args: any[]) => (memfs.rmSync as Function)(path, ...args),
					watch: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.watch as Function)(path, ...args);
						return (realFs.watch as Function)(path, ...args);
					},
					createReadStream: (path: any, ...args: any[]) => {
						if (!shouldFallback(path.toString())) return (memfs.createReadStream as Function)(path, ...args);
						return (realFs.createReadStream as Function)(path, ...args);
					},
					createWriteStream: (path: any, ...args: any[]) => (memfs.createWriteStream as Function)(path, ...args),
					promises: {
						...realFs.promises,
						readFile: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.readFile as Function)(path, ...args);
							return (realFs.promises.readFile as Function)(path, ...args);
						},
						writeFile: async (path: any, ...args: any[]) => (memfs.promises.writeFile as Function)(path, ...args),
						readdir: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.readdir as Function)(path, ...args);
							return (realFs.promises.readdir as Function)(path, ...args);
						},
						stat: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.stat as Function)(path, ...args);
							return (realFs.promises.stat as Function)(path, ...args);
						},
						lstat: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.lstat as Function)(path, ...args);
							return (realFs.promises.lstat as Function)(path, ...args);
						},
						mkdir: async (path: any, ...args: any[]) => (memfs.promises.mkdir as Function)(path, ...args),
						rm: async (path: any, ...args: any[]) => (memfs.promises.rm as Function)(path, ...args),
						access: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.access as Function)(path, ...args);
							return (realFs.promises.access as Function)(path, ...args);
						},
						open: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.open as Function)(path, ...args);
							return (realFs.promises.open as Function)(path, ...args);
						},
						chmod: async (path: any, ...args: any[]) => {
							if (!shouldFallback(path.toString())) return (memfs.promises.chmod as Function)(path, ...args);
							return (realFs.promises.chmod as Function)(path, ...args);
						},
					}
				};
			});
		};

		await setupFsMock('node:fs');
		await setupFsMock('fs');
		await setupFsMock('node:fs/promises');
		await setupFsMock('fs/promises');
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
