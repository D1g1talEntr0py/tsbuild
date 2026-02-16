import { isatty } from 'node:tty';
import type { FormatSupplier } from './@types';

const { env = {}, platform = '' } = process;
const isDumbTerminal = env.TERM === 'dumb';
const isCompatibleTerminal = isatty(1) && env.TERM && !isDumbTerminal;
const isColorSupported = !('NO_COLOR' in env) && ('FORCE_COLOR' in env || (platform === 'win32' && !isDumbTerminal) || isCompatibleTerminal);

/**
 * Recursively replaces all occurrences of `close` in `string` with `replace`, starting from `index`.
 * @param index - The starting index for the replacement
 * @param string - The string to perform replacements on
 * @param close - The substring to replace
 * @param replace - The substring to replace with
 * @param head - The part of the string before the current index
 * @param tail - The part of the string after the current index
 * @param next - The index of the next occurrence of `close` in `tail`
 * @returns The modified string with replacements
 */
const replaceClose = (index: number, string: string, close: string, replace: string, head = string.substring(0, index) + replace, tail = string.substring(index + close.length), next = tail.indexOf(close)): string => {
	// This has too many parameters, but it's a private recursive function
	return head + (next < 0 ? tail : replaceClose(next, tail, close, replace));
};

/**
 * Clears ANSI escape code bleed by replacing occurrences of `close` with `replace` after the first occurrence of `open`.
 * @param index - The index of the first occurrence of `open` in `string`
 * @param string - The string to process
 * @param open - The opening ANSI escape code
 * @param close - The closing ANSI escape code
 * @param replace - The ANSI escape code to replace `close` with
 * @returns The processed string with cleared bleed
 */
const clearBleed = (index: number, string: string, open: string, close: string, replace: string): string => {
	return index < 0 ? `${open}${string}${close}` : `${open}${replaceClose(index, string, close, replace)}${close}`;
};

/**
 * Creates a FormatSupplier that applies ANSI formatting if the terminal supports it.
 * If the terminal does not support colors, it returns the original text.
 * @param open - The ANSI escape code to start the formatting
 * @param close - The ANSI escape code to end the formatting
 * @param replace - The ANSI escape code to use for replacing `close` within the text
 * @param at - The position in the text to start looking for `close`
 * @returns A FormatSupplier function that applies the formatting
 */
const filterEmpty = (open: string, close: string, replace: string = open, at: number = open.length + 1): FormatSupplier => {
	return (text: string): string => text.length ? clearBleed(text.indexOf(close, at), text, open, close, replace) : '';
};

/**
 * Generates a FormatSupplier for the given ANSI open and close codes.
 * @param open - The ANSI escape code to start the formatting
 * @param close - The ANSI escape code to end the formatting
 * @param replace - The ANSI escape code to use for replacing `close` within the text
 * @returns A FormatSupplier function that applies the formatting
 */
const generateTextFormatter = (open: number, close: number, replace?: string): FormatSupplier => filterEmpty(`\x1b[${open}m`, `\x1b[${close}m`, replace);

/**
 * Utility class for formatting text with ANSI escape codes.
 * Each static property is a function that takes a string and returns the formatted string.
 * If the terminal does not support colors, these functions will return the original string.
 */
export class TextFormat {
	static readonly enabled: boolean | string | undefined = isColorSupported;
	static readonly reset: FormatSupplier = generateTextFormatter(0, 0);
	static readonly bold: FormatSupplier = generateTextFormatter(1, 22, '\x1b[22m\x1b[1m');
	static readonly dim: FormatSupplier = generateTextFormatter(2, 22, '\x1b[22m\x1b[2m');
	static readonly italic: FormatSupplier = generateTextFormatter(3, 23);
	static readonly underline: FormatSupplier = generateTextFormatter(4, 24);
	static readonly inverse: FormatSupplier = generateTextFormatter(7, 27);
	static readonly hidden: FormatSupplier = generateTextFormatter(8, 28);
	static readonly strikethrough: FormatSupplier = generateTextFormatter(9, 29);
	static readonly black: FormatSupplier = generateTextFormatter(30, 39);
	static readonly red: FormatSupplier = generateTextFormatter(31, 39);
	static readonly green: FormatSupplier = generateTextFormatter(32, 39);
	static readonly yellow: FormatSupplier = generateTextFormatter(33, 39);
	static readonly blue: FormatSupplier = generateTextFormatter(34, 39);
	static readonly magenta: FormatSupplier = generateTextFormatter(35, 39);
	static readonly cyan: FormatSupplier = generateTextFormatter(36, 39);
	static readonly white: FormatSupplier = generateTextFormatter(37, 39);
	static readonly gray: FormatSupplier = generateTextFormatter(90, 39);
	static readonly bgBlack: FormatSupplier = generateTextFormatter(40, 49);
	static readonly bgRed: FormatSupplier = generateTextFormatter(41, 49);
	static readonly bgGreen: FormatSupplier = generateTextFormatter(42, 49);
	static readonly bgYellow: FormatSupplier = generateTextFormatter(43, 49);
	static readonly bgBlue: FormatSupplier = generateTextFormatter(44, 49);
	static readonly bgMagenta: FormatSupplier = generateTextFormatter(45, 49);
	static readonly bgCyan: FormatSupplier = generateTextFormatter(46, 49);
	static readonly bgWhite: FormatSupplier = generateTextFormatter(47, 49);
	static readonly blackBright: FormatSupplier = generateTextFormatter(90, 39);
	static readonly redBright: FormatSupplier = generateTextFormatter(91, 39);
	static readonly greenBright: FormatSupplier = generateTextFormatter(92, 39);
	static readonly yellowBright: FormatSupplier = generateTextFormatter(93, 39);
	static readonly blueBright: FormatSupplier = generateTextFormatter(94, 39);
	static readonly magentaBright: FormatSupplier = generateTextFormatter(95, 39);
	static readonly cyanBright: FormatSupplier = generateTextFormatter(96, 39);
	static readonly whiteBright: FormatSupplier = generateTextFormatter(97, 39);
	static readonly bgBlackBright: FormatSupplier = generateTextFormatter(100, 49);
	static readonly bgRedBright: FormatSupplier = generateTextFormatter(101, 49);
	static readonly bgGreenBright: FormatSupplier = generateTextFormatter(102, 49);
	static readonly bgYellowBright: FormatSupplier = generateTextFormatter(103, 49);
	static readonly bgBlueBright: FormatSupplier = generateTextFormatter(104, 49);
	static readonly bgMagentaBright: FormatSupplier = generateTextFormatter(105, 49);
	static readonly bgCyanBright: FormatSupplier = generateTextFormatter(106, 49);
	static readonly bgWhiteBright: FormatSupplier = generateTextFormatter(107, 49);
}