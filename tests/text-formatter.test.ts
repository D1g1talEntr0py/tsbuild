import { describe, it, expect } from 'vitest';
import { TextFormat } from 'src/text-formatter';

// eslint-disable-next-line no-control-regex
const ansiEscapePattern = /\x1b\[[0-9;]*m/;

describe('TextFormat', () => {
	describe('enabled', () => {
		it('is a boolean or string', () => {
			expect(['boolean', 'string', 'undefined']).toContain(typeof TextFormat.enabled);
		});
	});

	describe('formatting methods', () => {
		const formattingMatrix: [string, keyof typeof TextFormat][] = [
			['bold',          'bold'],
			['dim',           'dim'],
			['italic',        'italic'],
			['underline',     'underline'],
			['inverse',       'inverse'],
			['hidden',        'hidden'],
			['strikethrough', 'strikethrough'],
			['reset',         'reset'],
		];

		it.each(formattingMatrix)('applies %s formatting', (_name, key) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toMatch(ansiEscapePattern);
			expect(result).toContain('test');
			expect(result).not.toBe('test');
		});

		it('returns empty string for empty input', () => {
			expect(TextFormat.bold('')).toBe('');
		});
	});

	describe('standard colors', () => {
		const colorMatrix: [string, keyof typeof TextFormat][] = [
			['black',   'black'],
			['red',     'red'],
			['green',   'green'],
			['yellow',  'yellow'],
			['blue',    'blue'],
			['magenta', 'magenta'],
			['cyan',    'cyan'],
			['white',   'white'],
			['gray',    'gray'],
		];

		it.each(colorMatrix)('applies %s color', (_name, key) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toMatch(ansiEscapePattern);
			expect(result).toContain('test');
			expect(result).not.toBe('test');
		});
	});

	describe('bright colors', () => {
		const brightMatrix: [string, keyof typeof TextFormat][] = [
			['blackBright',   'blackBright'],
			['redBright',     'redBright'],
			['greenBright',   'greenBright'],
			['yellowBright',  'yellowBright'],
			['blueBright',    'blueBright'],
			['magentaBright', 'magentaBright'],
			['cyanBright',    'cyanBright'],
			['whiteBright',   'whiteBright'],
		];

		it.each(brightMatrix)('applies %s color', (_name, key) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toMatch(ansiEscapePattern);
			expect(result).toContain('test');
			expect(result).not.toBe('test');
		});
	});

	describe('background colors', () => {
		const bgMatrix: [string, keyof typeof TextFormat][] = [
			['bgBlack',   'bgBlack'],
			['bgRed',     'bgRed'],
			['bgGreen',   'bgGreen'],
			['bgYellow',  'bgYellow'],
			['bgBlue',    'bgBlue'],
			['bgMagenta', 'bgMagenta'],
			['bgCyan',    'bgCyan'],
			['bgWhite',   'bgWhite'],
		];

		it.each(bgMatrix)('applies %s background', (_name, key) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toMatch(ansiEscapePattern);
			expect(result).toContain('test');
			expect(result).not.toBe('test');
		});
	});

	describe('bright background colors', () => {
		const brightBgMatrix: [string, keyof typeof TextFormat][] = [
			['bgBlackBright',   'bgBlackBright'],
			['bgRedBright',     'bgRedBright'],
			['bgGreenBright',   'bgGreenBright'],
			['bgYellowBright',  'bgYellowBright'],
			['bgBlueBright',    'bgBlueBright'],
			['bgMagentaBright', 'bgMagentaBright'],
			['bgCyanBright',    'bgCyanBright'],
			['bgWhiteBright',   'bgWhiteBright'],
		];

		it.each(brightBgMatrix)('applies %s background', (_name, key) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toMatch(ansiEscapePattern);
			expect(result).toContain('test');
			expect(result).not.toBe('test');
		});
	});

	describe('nested formatting', () => {
		it('handles close code appearing inside text', () => {
			// Extract bold's own close sequence from its output rather than hardcoding it.
			const boldClose = TextFormat.bold('x').slice(-'\x1b[22m'.length);
			const result = TextFormat.bold(`before${boldClose}inner`);
			const matches = result.match(new RegExp(ansiEscapePattern.source, 'g')) ?? [];
			// A naive wrap (open + text + close) would contain the boldClose sequence plus 2 more (open, close) = 3.
			// Bleed-clearing re-opens bold after the embedded close, adding an extra escape sequence.
			expect(matches.length).toBeGreaterThan(3);
			expect(result).toContain('before');
			expect(result).toContain('inner');
		});
	});
});

