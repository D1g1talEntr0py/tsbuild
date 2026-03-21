import { describe, it, expect } from 'vitest';
import { TextFormat } from 'src/text-formatter';

describe('TextFormat', () => {
	describe('enabled', () => {
		it('is a boolean or string', () => {
			expect(['boolean', 'string', 'undefined']).toContain(typeof TextFormat.enabled);
		});
	});

	describe('formatting methods', () => {
		const formattingMatrix: [string, keyof typeof TextFormat, number, number][] = [
			['bold',          'bold',          1,  22],
			['dim',           'dim',           2,  22],
			['italic',        'italic',        3,  23],
			['underline',     'underline',     4,  24],
			['inverse',       'inverse',       7,  27],
			['hidden',        'hidden',        8,  28],
			['strikethrough', 'strikethrough', 9,  29],
			['reset',         'reset',         0,  0],
		];

		it.each(formattingMatrix)('applies %s formatting', (_name, key, open, close) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toContain(`\x1b[${open}m`);
			expect(result).toContain(`\x1b[${close}m`);
		});

		it('returns empty string for empty input', () => {
			expect(TextFormat.bold('')).toBe('');
		});
	});

	describe('standard colors', () => {
		const colorMatrix: [string, keyof typeof TextFormat, number, number][] = [
			['black',   'black',   30, 39],
			['red',     'red',     31, 39],
			['green',   'green',   32, 39],
			['yellow',  'yellow',  33, 39],
			['blue',    'blue',    34, 39],
			['magenta', 'magenta', 35, 39],
			['cyan',    'cyan',    36, 39],
			['white',   'white',   37, 39],
			['gray',    'gray',    90, 39],
		];

		it.each(colorMatrix)('applies %s color', (_name, key, open, close) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toContain(`\x1b[${open}m`);
			expect(result).toContain(`\x1b[${close}m`);
		});
	});

	describe('bright colors', () => {
		const brightMatrix: [string, keyof typeof TextFormat, number][] = [
			['blackBright',   'blackBright',   90],
			['redBright',     'redBright',     91],
			['greenBright',   'greenBright',   92],
			['yellowBright',  'yellowBright',  93],
			['blueBright',    'blueBright',    94],
			['magentaBright', 'magentaBright', 95],
			['cyanBright',    'cyanBright',    96],
			['whiteBright',   'whiteBright',   97],
		];

		it.each(brightMatrix)('applies %s color', (_name, key, open) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toContain(`\x1b[${open}m`);
			expect(result).toContain('\x1b[39m');
		});
	});

	describe('background colors', () => {
		const bgMatrix: [string, keyof typeof TextFormat, number][] = [
			['bgBlack',   'bgBlack',   40],
			['bgRed',     'bgRed',     41],
			['bgGreen',   'bgGreen',   42],
			['bgYellow',  'bgYellow',  43],
			['bgBlue',    'bgBlue',    44],
			['bgMagenta', 'bgMagenta', 45],
			['bgCyan',    'bgCyan',    46],
			['bgWhite',   'bgWhite',   47],
		];

		it.each(bgMatrix)('applies %s background', (_name, key, open) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toContain(`\x1b[${open}m`);
			expect(result).toContain('\x1b[49m');
		});
	});

	describe('bright background colors', () => {
		const brightBgMatrix: [string, keyof typeof TextFormat, number][] = [
			['bgBlackBright',   'bgBlackBright',   100],
			['bgRedBright',     'bgRedBright',     101],
			['bgGreenBright',   'bgGreenBright',   102],
			['bgYellowBright',  'bgYellowBright',  103],
			['bgBlueBright',    'bgBlueBright',    104],
			['bgMagentaBright', 'bgMagentaBright', 105],
			['bgCyanBright',    'bgCyanBright',    106],
			['bgWhiteBright',   'bgWhiteBright',   107],
		];

		it.each(brightBgMatrix)('applies %s background', (_name, key, open) => {
			const fn = TextFormat[key] as (text: string) => string;
			const result = fn('test');
			expect(result).toContain(`\x1b[${open}m`);
			expect(result).toContain('\x1b[49m');
		});
	});

	describe('nested formatting', () => {
		it('handles close code appearing inside text', () => {
			const result = TextFormat.bold(`before\x1b[22minner`);
			expect(result).toContain('\x1b[1m');
		});
	});
});
