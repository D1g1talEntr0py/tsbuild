import { vol, DirectoryJSON } from 'memfs';
import { vi } from 'vitest';
import { resolve, join, dirname, isAbsolute, extname } from 'node:path';
import type { Loader, Plugin } from 'esbuild';
import ts from 'typescript';
import type { CachedDeclaration } from '../../src/@types';
import { DeclarationProcessor } from '../../src/dts/declaration-processor';

// Re-export vol for convenience
export { vol };

/**
 * Test helper for setting up memfs-based tests.
 * Provides utilities for mocking the filesystem, creating test projects,
 * and patching TypeScript's sys object to work with memfs.
 */
export class TestHelper {
	private static originalSys: typeof ts.sys | undefined;

	/**
	 * Resets the memfs volume and sets up TypeScript lib files.
	 * Call this in beforeEach for tests that need memfs.
	 */
	static async setupMemfs() {
		vol.reset();
		vol.mkdirSync(process.cwd(), { recursive: true });

		// Copy typescript libs to memfs
		const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
		const path = await vi.importActual<typeof import('node:path')>('node:path');
		const { createRequire } = await vi.importActual<typeof import('node:module')>('node:module');
		const require = createRequire(import.meta.url);

		try {
			const tsLibPath = path.dirname(require.resolve('typescript/package.json'));
			const libDir = path.join(tsLibPath, 'lib');

			if (fs.existsSync(libDir)) {
				const files = fs.readdirSync(libDir).filter((f: string) => f.startsWith('lib.') && f.endsWith('.d.ts'));
				const memLibDir = path.join(tsLibPath, 'lib');
				vol.mkdirSync(memLibDir, { recursive: true });

				for (const file of files) {
					const content = fs.readFileSync(path.join(libDir, file), 'utf-8');
					vol.writeFileSync(path.join(memLibDir, file), content);
					// Also copy to cwd as fallback
					vol.writeFileSync(path.join(process.cwd(), file), content);
				}
			}
		} catch (e) {
			console.warn('Failed to copy typescript libs:', e);
		}

		await this.patchTsSys();
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
	 * Restores original ts.sys and resets memfs.
	 * Call this in afterEach.
	 */
	static teardownMemfs() {
		this.restoreTsSys();
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
				...options.tsconfig?.compilerOptions,
			},
			tsbuild: {
				entryPoints: { index: './src/index.ts' },
				...options.tsconfig?.tsbuild,
			},
			include: options.tsconfig?.include || ['src/**/*'],
			exclude: options.tsconfig?.exclude || ['node_modules', 'dist'],
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
		const sourceFile = ts.createSourceFile('temp.d.ts', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
		const { code: processedCode, typeReferences, fileReferences } = DeclarationProcessor.preProcess(sourceFile);
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
	 * Gets TypeScript lib files from memfs.
	 */
	static getLibFiles(): Record<string, string> {
		const files: Record<string, string> = {};
		const cwd = process.cwd();
		if (vol.existsSync(cwd)) {
			const dirFiles = vol.readdirSync(cwd) as string[];
			for (const file of dirFiles) {
				if (file.startsWith('lib.') && file.endsWith('.d.ts')) {
					files[file] = vol.readFileSync(join(cwd, file), 'utf-8') as string;
				}
			}
		}
		return files;
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
	 * Patches ts.sys to use memfs.
	 */
	static async patchTsSys() {
		if (this.originalSys) return;

		this.originalSys = { ...ts.sys };
		const originalReadDirectory = ts.sys.readDirectory;

		ts.sys.readFile = (path: string, encoding?: string) => {
			if (vol.existsSync(path) && !vol.statSync(path).isDirectory()) {
				return vol.readFileSync(path, encoding as BufferEncoding || 'utf8') as string;
			}
			return undefined;
		};

		ts.sys.writeFile = (path: string, data: string) => {
			vol.mkdirSync(dirname(path), { recursive: true });
			vol.writeFileSync(path, data);
		};

		ts.sys.fileExists = (path: string) => {
			try {
				return vol.existsSync(path) && !vol.statSync(path).isDirectory();
			} catch {
				return false;
			}
		};

		ts.sys.directoryExists = (path: string) => {
			try {
				return vol.existsSync(path) && vol.statSync(path).isDirectory();
			} catch {
				return false;
			}
		};

		ts.sys.getDirectories = (path: string) => {
			if (vol.existsSync(path) && vol.statSync(path).isDirectory()) {
				return (vol.readdirSync(path) as string[]).filter(f => {
					const fullPath = join(path, f);
					return vol.existsSync(fullPath) && vol.statSync(fullPath).isDirectory();
				});
			}
			return [];
		};

		ts.sys.readDirectory = (path: string, extensions?: readonly string[], exclude?: readonly string[], include?: readonly string[], depth?: number): string[] => {
			if (!vol.existsSync(path)) {
				return originalReadDirectory(path, extensions, exclude, include, depth);
			}

			const files: string[] = [];
			const walk = (dir: string, currentDepth: number) => {
				if (depth !== undefined && currentDepth > depth) return;
				if (!vol.existsSync(dir) || !vol.statSync(dir).isDirectory()) return;
				if (exclude && exclude.some(ex => dir.includes(ex))) return;

				for (const entry of vol.readdirSync(dir) as string[]) {
					const fullPath = join(dir, entry);
					if (vol.statSync(fullPath).isDirectory()) {
						if (exclude && exclude.some(ex => fullPath.includes(ex))) continue;
						walk(fullPath, currentDepth + 1);
					} else {
						if (!extensions || extensions.some(ext => fullPath.endsWith(ext))) {
							files.push(fullPath);
						}
					}
				}
			};
			walk(path, 0);
			return files;
		};

		ts.sys.realpath = (path: string) => path;
		ts.sys.resolvePath = (path: string) => resolve(path);
		ts.sys.getCurrentDirectory = () => process.cwd();
	}

	/**
	 * Restores original ts.sys.
	 */
	static restoreTsSys() {
		if (this.originalSys) {
			Object.assign(ts.sys, this.originalSys);
			this.originalSys = undefined;
		}
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
					if (!path.startsWith('/') && !path.startsWith('.')) {
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
					}
				};
			});
		};

		await setupFsMock('node:fs');
		await setupFsMock('fs');
		await setupFsMock('node:fs/promises');
		await setupFsMock('fs/promises');
	}
}
