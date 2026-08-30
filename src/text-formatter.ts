import { isatty } from 'node:tty';
import { styleText } from 'node:util';
import type { InspectColor } from 'node:util';
import type { FormatSupplier } from './@types';

const { env = {} } = process;
const isDumbTerminal = env['TERM'] === 'dumb';
const isCompatibleTerminal = isatty(1) && env['TERM'] && !isDumbTerminal;
const isColorSupported = !('NO_COLOR' in env) && ('FORCE_COLOR' in env || isCompatibleTerminal);

/**
 * Recursively replaces all occurrences of `close` in `string` with `replace`, starting from `index`.
 * @param index The starting index for the replacement.
 * @param string The string to perform replacements on.
 * @param close The substring to replace.
 * @param replace The substring to replace with.
 * @param head The part of the string before the current index.
 * @param tail The part of the string after the current index.
 * @param next The index of the next occurrence of `close` in `tail`.
 * @returns The string with all occurrences of `close` replaced by `replace`.
 */
const replaceClose = (index: number, string: string, close: string, replace: string, head = string.substring(0, index) + replace, tail = string.substring(index + close.length), next = tail.indexOf(close)): string => {
	// This has too many parameters, but it's a private recursive function
	return head + (next < 0 ? tail : replaceClose(next, tail, close, replace));
};

/**
 * Clears ANSI escape code bleed by replacing occurrences of `close` with `replace` after the first occurrence of `open`.
 * @param index The index of the first occurrence of `open` in `string`.
 * @param string The string to process.
 * @param open The opening ANSI escape code.
 * @param close The closing ANSI escape code.
 * @param replace The ANSI escape code to replace `close` with.
 * @returns The processed string with ANSI escape code bleed cleared.
 */
const clearBleed = (index: number, string: string, open: string, close: string, replace: string) => {
	return index < 0 ? `${open}${string}${close}` : `${open}${replaceClose(index, string, close, replace)}${close}`;
};

/**
 * Creates a FormatSupplier that applies ANSI formatting if the terminal supports it.
 * If the terminal does not support colors, it returns the original text.
 * @param open The ANSI escape code to start the formatting.
 * @param close The ANSI escape code to end the formatting.
 * @param replace The ANSI escape code to use for replacing `close` within the text.
 * @param at The position in the text to start looking for `close`.
 * @returns A FormatSupplier function that applies the formatting.
 */
const filterEmpty = (open: string, close: string, replace: string = open, at: number = open.length + 1): FormatSupplier => {
	return (text: string): string => text.length ? clearBleed(text.indexOf(close, at), text, open, close, replace) : '';
};

/**
 * Derives the open/close ANSI escape sequences node:util's `styleText` applies for `format`.
 * `validateStream: false` is required so the codes are always returned regardless of the current TTY - this project applies its own `isColorSupported` gating via `TextFormat.enabled`.
 * @param format A format name recognized by node:util's `styleText` (see `util.inspect.colors`).
 * @returns A tuple of the open and close ANSI escape sequences.
 */
const styleTextCodes = (format: InspectColor): [open: string, close: string] => {
	const probe = '\0';
	const wrapped = styleText(format, probe, { validateStream: false });
	const index = wrapped.indexOf(probe);

	return [ wrapped.slice(0, index), wrapped.slice(index + 1) ];
};

/**
 * Generates a FormatSupplier sourcing its ANSI open/close codes from node:util's `styleText`.
 * @param format The node:util `styleText` format name to source the open/close ANSI codes from.
 * @param replace Optional replacement ANSI code string.
 */
const generateTextFormatter = (format: InspectColor, replace?: string): FormatSupplier => {
	const [open, close] = styleTextCodes(format);
	return filterEmpty(open, close, replace);
};

/**
 * Utility class for formatting text with ANSI escape codes.
 * Each static property is a function that takes a string and returns the formatted string.
 * If the terminal does not support colors, these functions will return the original string.
 */
export class TextFormat {
	static readonly enabled: boolean | string | undefined = isColorSupported;
	static readonly reset: FormatSupplier = generateTextFormatter('reset');
	static readonly bold: FormatSupplier = generateTextFormatter('bold', '\x1b[22m\x1b[1m');
	static readonly dim: FormatSupplier = generateTextFormatter('dim', '\x1b[22m\x1b[2m');
	static readonly italic: FormatSupplier = generateTextFormatter('italic');
	static readonly underline: FormatSupplier = generateTextFormatter('underline');
	static readonly inverse: FormatSupplier = generateTextFormatter('inverse');
	static readonly hidden: FormatSupplier = generateTextFormatter('hidden');
	static readonly strikethrough: FormatSupplier = generateTextFormatter('strikethrough');
	static readonly black: FormatSupplier = generateTextFormatter('black');
	static readonly red: FormatSupplier = generateTextFormatter('red');
	static readonly green: FormatSupplier = generateTextFormatter('green');
	static readonly yellow: FormatSupplier = generateTextFormatter('yellow');
	static readonly blue: FormatSupplier = generateTextFormatter('blue');
	static readonly magenta: FormatSupplier = generateTextFormatter('magenta');
	static readonly cyan: FormatSupplier = generateTextFormatter('cyan');
	static readonly white: FormatSupplier = generateTextFormatter('white');
	static readonly gray: FormatSupplier = generateTextFormatter('gray');
	static readonly bgBlack: FormatSupplier = generateTextFormatter('bgBlack');
	static readonly bgRed: FormatSupplier = generateTextFormatter('bgRed');
	static readonly bgGreen: FormatSupplier = generateTextFormatter('bgGreen');
	static readonly bgYellow: FormatSupplier = generateTextFormatter('bgYellow');
	static readonly bgBlue: FormatSupplier = generateTextFormatter('bgBlue');
	static readonly bgMagenta: FormatSupplier = generateTextFormatter('bgMagenta');
	static readonly bgCyan: FormatSupplier = generateTextFormatter('bgCyan');
	static readonly bgWhite: FormatSupplier = generateTextFormatter('bgWhite');
	// 'blackBright'/'bgBlackBright' have no matching key in node:util's InspectColor union; 'gray'/'bgGray' produce identical codes (90/39, 100/49).
	static readonly blackBright: FormatSupplier = generateTextFormatter('gray');
	static readonly redBright: FormatSupplier = generateTextFormatter('redBright');
	static readonly greenBright: FormatSupplier = generateTextFormatter('greenBright');
	static readonly yellowBright: FormatSupplier = generateTextFormatter('yellowBright');
	static readonly blueBright: FormatSupplier = generateTextFormatter('blueBright');
	static readonly magentaBright: FormatSupplier = generateTextFormatter('magentaBright');
	static readonly cyanBright: FormatSupplier = generateTextFormatter('cyanBright');
	static readonly whiteBright: FormatSupplier = generateTextFormatter('whiteBright');
	static readonly bgBlackBright: FormatSupplier = generateTextFormatter('bgGray');
	static readonly bgRedBright: FormatSupplier = generateTextFormatter('bgRedBright');
	static readonly bgGreenBright: FormatSupplier = generateTextFormatter('bgGreenBright');
	static readonly bgYellowBright: FormatSupplier = generateTextFormatter('bgYellowBright');
	static readonly bgBlueBright: FormatSupplier = generateTextFormatter('bgBlueBright');
	static readonly bgMagentaBright: FormatSupplier = generateTextFormatter('bgMagentaBright');
	static readonly bgCyanBright: FormatSupplier = generateTextFormatter('bgCyanBright');
	static readonly bgWhiteBright: FormatSupplier = generateTextFormatter('bgWhiteBright');
}