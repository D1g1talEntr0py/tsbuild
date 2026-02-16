import { SyntaxKind, type Node } from 'typescript';

/**
 * Custom error classes for tsbuild
 * Provides standardized error handling with exit codes
 */

/**
 * Base error class for all build-related errors
 */
export class BuildError extends Error {
	/**
	 * Creates a new BuildError
	 * @param message - Error message
	 * @param code - Exit code (default: 1)
	 */
	constructor(message: string, public readonly code: number = 1) {
		super(message);
		this.name = 'BuildError';
		Error.captureStackTrace(this, this.constructor);
	}
}

/**
 * Error thrown during TypeScript type checking
 */
export class TypeCheckError extends BuildError {
	/**
	 * Creates a new TypeCheckError
	 * @param message - Error message
	 * @param diagnostics - Optional TypeScript diagnostics output
	 */
	constructor(message: string, public readonly diagnostics?: string) {
		super(message, 1);
		this.name = 'TypeCheckError';
	}
}

/**
 * Error thrown during bundling process
 */
export class BundleError extends BuildError {
	/**
	 * Creates a new BundleError
	 * @param message - Error message
	 */
	constructor(message: string) {
		super(message, 2);
		this.name = 'BundleError';
	}
}

/**
 * Error thrown for invalid configuration
 */
export class ConfigurationError extends BuildError {
	/**
	 * Creates a new ConfigurationError
	 * @param message - Error message
	 */
	constructor(message: string) {
		super(message, 3);
		this.name = 'ConfigurationError';
	}
}

/** Error thrown when encountering unsupported syntax during processing */
export class UnsupportedSyntaxError extends Error {
	/**
	 * Creates an instance of UnsupportedSyntaxError.
	 * @param node The node with unsupported syntax
	 * @param message The message to display (default: 'Syntax not yet supported')
	 */
	constructor(node: Node, message: string = 'Syntax not yet supported') {
		const syntaxKindName = SyntaxKind[node.kind] ?? `Unknown(${node.kind})`;
		const nodeText = node.getText ? node.getText().slice(0, 100) : '<no text>';
		super(`${message}: ${syntaxKindName} - "${nodeText}"`);
	}
}

/**
 * Casts an unknown exception to an Error.
 * @param exception - The exception to cast.
 * @returns The casted Error.
 */
export const castError = (exception: unknown): Error => {
	if (exception instanceof Error) { return exception }

	return new Error(typeof exception === 'string' ? exception : 'Unknown error');
};