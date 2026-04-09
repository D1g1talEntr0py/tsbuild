import { iifePlugin } from 'src/plugins/iife';
import type { Plugin } from 'esbuild';
import type { IifeOptions } from 'src/@types';

/**
 * Test fixture: wraps the internal IIFE plugin as a default-export factory function.
 * Used to validate config-driven plugin resolution (string/tuple references in tsconfig.json).
 */
export default function iifePluginFactory(options?: IifeOptions): Plugin {
	return iifePlugin(options).plugin;
}
