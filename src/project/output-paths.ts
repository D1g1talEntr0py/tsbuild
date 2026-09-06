import { isAbsolute } from 'node:path';
import { ConfigurationError } from '../errors';
import { Paths } from '../paths';
import type { AbsolutePath } from '../@types';

const isSameOrDescendant = (parent: AbsolutePath, candidate: AbsolutePath): boolean => {
	const path = Paths.relative(parent, candidate);
	return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
};

/** Validates output paths with project-lifetime caching of canonical protected inputs. */
export class OutputPathValidator {
	readonly #directory: AbsolutePath;
	readonly #configFilePath: AbsolutePath;
	readonly #rootNames: readonly string[];
	readonly #outDir: AbsolutePath;
	#protectedPaths?: Promise<readonly AbsolutePath[]>;

	/**
	 * Creates a validator without performing filesystem operations.
	 * @param directory - Project directory
	 * @param configFilePath - Resolved configuration file path
	 * @param rootNames - Project source paths
	 * @param outDir - Configured output directory
	 */
	constructor(directory: AbsolutePath, configFilePath: AbsolutePath, rootNames: readonly string[], outDir: AbsolutePath) {
		this.#directory = directory;
		this.#configFilePath = configFilePath;
		this.#rootNames = rootNames;
		this.#outDir = outDir;
	}

	/**
	 * Validates the output directory before declaration entry resolution.
	 * @returns The canonical output directory for subsequent declaration validation
	 * @throws {ConfigurationError} when cleanup could remove project inputs
	 */
	async validateOutputDirectory(): Promise<AbsolutePath> {
		const outputDirectory = await Paths.canonical(this.#outDir);
		const protectedPaths = await (this.#protectedPaths ??= Promise.all([
			Paths.canonical(this.#directory),
			Paths.canonical(this.#configFilePath),
			Paths.canonical(Paths.join(this.#directory, 'package.json')),
			...this.#rootNames.map((path) => Paths.canonical(path))
		]));
		if (outputDirectory === Paths.parse(outputDirectory).root || protectedPaths.some((path) => isSameOrDescendant(outputDirectory, path))) {
			throw new ConfigurationError(`Unsafe output directory "${this.#outDir}". Choose a dedicated directory that is not the filesystem root, the project directory, an ancestor of the project, or a directory containing project inputs.`);
		}

		return outputDirectory;
	}

	/**
	 * Validates resolved declaration entry names when declaration emission is enabled.
	 * @param outputDirectory - Canonical directory returned by output validation
	 * @param entryNames - Declaration output names in resolution order
	 * @throws {ConfigurationError} when a declaration path escapes the output directory
	 */
	async validateDeclarationPaths(outputDirectory: AbsolutePath, entryNames: readonly string[]): Promise<void> {
		for (const name of entryNames) {
			const declarationPath = await Paths.canonical(Paths.join(outputDirectory, `${name}.d.ts`));
			if (!isSameOrDescendant(outputDirectory, declarationPath) || declarationPath === outputDirectory) {
				throw new ConfigurationError(`Unsafe declaration output path "${name}" resolves outside "${this.#outDir}". Rename the entry point or choose a dedicated output directory.`);
			}
		}
	}
}