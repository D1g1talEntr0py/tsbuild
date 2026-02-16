declare module 'fs-monkey' {
	import type { IFs } from 'memfs';

	export function patchFs(vol: IFs, options?: { fs?: any; promises?: any }): () => void;
}