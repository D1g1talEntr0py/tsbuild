import { Paths } from '../paths';
import { FileExtension } from '../constants';
import { ConfigurationError } from '../errors';
import { everyOutputInBatches } from './output-checks';
import type { AbsolutePath, PathDescriptor } from '../@types';

/** Validates output paths with project-lifetime caching of canonical protected inputs. */
export class OutputPathValidator {
	#protectedPaths?: Promise<readonly AbsolutePath[]>;
	readonly #directory: AbsolutePath;
	readonly #configFilePath: AbsolutePath;
	readonly #rootNames: readonly AbsolutePath[];
	readonly #outDir: AbsolutePath;

	/**
	 * Creates a validator without performing filesystem operations.
	 * @param directory - Project directory
	 * @param configFilePath - Resolved configuration file path
	 * @param rootNames - Project source paths, absolute or relative to the project directory
	 * @param outDir - Configured output directory
	 */
	constructor(directory: AbsolutePath, configFilePath: AbsolutePath, rootNames: readonly PathDescriptor[], outDir: AbsolutePath) {
		this.#directory = directory;
		this.#configFilePath = configFilePath;
		this.#rootNames = rootNames.map((path) => Paths.isAbsolutePath(path) ? path : Paths.absolute(directory, path));
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
			...this.#rootNames.map(Paths.canonical)
		]));

		if (outputDirectory === Paths.parse(outputDirectory).root || protectedPaths.some((path) => Paths.isSameOrDescendant(outputDirectory, path))) {
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
		await everyOutputInBatches(entryNames, async (name) => {
			const declarationPath = await Paths.canonical(Paths.join(outputDirectory, name + FileExtension.D_TS));
			if (declarationPath === outputDirectory || !Paths.isSameOrDescendant(outputDirectory, declarationPath)) {
				throw new ConfigurationError(`Unsafe declaration output path "${name}" resolves outside "${this.#outDir}". Rename the entry point or choose a dedicated output directory.`);
			}

			return true;
		});
	}
}