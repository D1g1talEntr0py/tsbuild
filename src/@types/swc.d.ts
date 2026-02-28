/**
 * Minimal ambient declaration for the optional `@swc/core` peer dependency.
 * Only the subset of the API used by the decorator-metadata plugin is declared.
 * Users must install `@swc/core` manually when `emitDecoratorMetadata` is enabled.
 */
declare module '@swc/core' {
	type Output = { code: string; map?: string };
	function transformFile(path: string, options?: object): Promise<Output>;
}
