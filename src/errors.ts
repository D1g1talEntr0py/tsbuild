/**
 * Custom error classes for tsbuild
 * Provides standardized error handling with exit codes
 */

/**
 * Base error class for all build-related errors
 */
export class BuildError extends Error {
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
	constructor(message: string, public readonly diagnostics?: string) {
		super(message, 1);
		this.name = 'TypeCheckError';
	}
}

/**
 * Error thrown during bundling process
 */
export class BundleError extends BuildError {
	constructor(message: string) {
		super(message, 2);
		this.name = 'BundleError';
	}
}

/**
 * Error thrown for invalid configuration
 */
export class ConfigurationError extends BuildError {
	constructor(message: string) {
		super(message, 3);
		this.name = 'ConfigurationError';
	}
}

export const castError = (exception: unknown): Error => {
	return exception instanceof Error ? exception : new Error(typeof exception === 'string' ? exception : 'Unknown error');
};