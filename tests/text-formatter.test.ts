import { vi, describe, beforeEach, it, expect } from 'vitest';
import { TextFormat } from '../src/text-formatter';

describe('text-formatter', () => {
	describe('TextFormat.enabled', () => {
		it('should expose color support status', () => {
			expect(TextFormat.enabled).toBeDefined();
			expect(typeof TextFormat.enabled).toBe('boolean');
		});
	});

	describe('Basic formatting', () => {
		it('should format text with bold style', () => {
			const boldText = TextFormat.bold('hello');
			expect(boldText).toBe('\x1b[1mhello\x1b[22m');
		});

		it('should format text with dim style', () => {
			const dimText = TextFormat.dim('hello');
			expect(dimText).toBe('\x1b[2mhello\x1b[22m');
		});

		it('should format text with italic style', () => {
			const italicText = TextFormat.italic('hello');
			expect(italicText).toBe('\x1b[3mhello\x1b[23m');
		});

		it('should format text with underline style', () => {
			const underlineText = TextFormat.underline('hello');
			expect(underlineText).toBe('\x1b[4mhello\x1b[24m');
		});

		it('should format text with inverse style', () => {
			const inverseText = TextFormat.inverse('hello');
			expect(inverseText).toBe('\x1b[7mhello\x1b[27m');
		});

		it('should format text with hidden style', () => {
			const hiddenText = TextFormat.hidden('hello');
			expect(hiddenText).toBe('\x1b[8mhello\x1b[28m');
		});

		it('should format text with strikethrough style', () => {
			const strikethroughText = TextFormat.strikethrough('hello');
			expect(strikethroughText).toBe('\x1b[9mhello\x1b[29m');
		});

		it('should format text with reset', () => {
			const resetText = TextFormat.reset('hello');
			expect(resetText).toBe('\x1b[0mhello\x1b[0m');
		});
	});

	describe('Standard colors', () => {
		it('should format text with black color', () => {
			const blackText = TextFormat.black('hello');
			expect(blackText).toBe('\x1b[30mhello\x1b[39m');
		});

		it('should format text with red color', () => {
			const redText = TextFormat.red('hello');
			expect(redText).toBe('\x1b[31mhello\x1b[39m');
		});

		it('should format text with green color', () => {
			const greenText = TextFormat.green('hello');
			expect(greenText).toBe('\x1b[32mhello\x1b[39m');
		});

		it('should format text with yellow color', () => {
			const yellowText = TextFormat.yellow('hello');
			expect(yellowText).toBe('\x1b[33mhello\x1b[39m');
		});

		it('should format text with blue color', () => {
			const blueText = TextFormat.blue('hello');
			expect(blueText).toBe('\x1b[34mhello\x1b[39m');
		});

		it('should format text with magenta color', () => {
			const magentaText = TextFormat.magenta('hello');
			expect(magentaText).toBe('\x1b[35mhello\x1b[39m');
		});

		it('should format text with cyan color', () => {
			const cyanText = TextFormat.cyan('hello');
			expect(cyanText).toBe('\x1b[36mhello\x1b[39m');
		});

		it('should format text with white color', () => {
			const whiteText = TextFormat.white('hello');
			expect(whiteText).toBe('\x1b[37mhello\x1b[39m');
		});

		it('should format text with gray color', () => {
			const grayText = TextFormat.gray('hello');
			expect(grayText).toBe('\x1b[90mhello\x1b[39m');
		});
	});

	describe('Bright colors', () => {
		it('should format text with blackBright color', () => {
			const text = TextFormat.blackBright('hello');
			expect(text).toBe('\x1b[90mhello\x1b[39m');
		});

		it('should format text with redBright color', () => {
			const text = TextFormat.redBright('hello');
			expect(text).toBe('\x1b[91mhello\x1b[39m');
		});

		it('should format text with greenBright color', () => {
			const text = TextFormat.greenBright('hello');
			expect(text).toBe('\x1b[92mhello\x1b[39m');
		});

		it('should format text with yellowBright color', () => {
			const text = TextFormat.yellowBright('hello');
			expect(text).toBe('\x1b[93mhello\x1b[39m');
		});

		it('should format text with blueBright color', () => {
			const text = TextFormat.blueBright('hello');
			expect(text).toBe('\x1b[94mhello\x1b[39m');
		});

		it('should format text with magentaBright color', () => {
			const text = TextFormat.magentaBright('hello');
			expect(text).toBe('\x1b[95mhello\x1b[39m');
		});

		it('should format text with cyanBright color', () => {
			const text = TextFormat.cyanBright('hello');
			expect(text).toBe('\x1b[96mhello\x1b[39m');
		});

		it('should format text with whiteBright color', () => {
			const text = TextFormat.whiteBright('hello');
			expect(text).toBe('\x1b[97mhello\x1b[39m');
		});
	});

	describe('Background colors', () => {
		it('should format text with bgBlack', () => {
			const text = TextFormat.bgBlack('hello');
			expect(text).toBe('\x1b[40mhello\x1b[49m');
		});

		it('should format text with bgRed', () => {
			const text = TextFormat.bgRed('hello');
			expect(text).toBe('\x1b[41mhello\x1b[49m');
		});

		it('should format text with bgGreen', () => {
			const text = TextFormat.bgGreen('hello');
			expect(text).toBe('\x1b[42mhello\x1b[49m');
		});

		it('should format text with bgYellow', () => {
			const text = TextFormat.bgYellow('hello');
			expect(text).toBe('\x1b[43mhello\x1b[49m');
		});

		it('should format text with bgBlue', () => {
			const text = TextFormat.bgBlue('hello');
			expect(text).toBe('\x1b[44mhello\x1b[49m');
		});

		it('should format text with bgMagenta', () => {
			const text = TextFormat.bgMagenta('hello');
			expect(text).toBe('\x1b[45mhello\x1b[49m');
		});

		it('should format text with bgCyan', () => {
			const text = TextFormat.bgCyan('hello');
			expect(text).toBe('\x1b[46mhello\x1b[49m');
		});

		it('should format text with bgWhite', () => {
			const text = TextFormat.bgWhite('hello');
			expect(text).toBe('\x1b[47mhello\x1b[49m');
		});
	});

	describe('Bright background colors', () => {
		it('should format text with bgBlackBright', () => {
			const text = TextFormat.bgBlackBright('hello');
			expect(text).toBe('\x1b[100mhello\x1b[49m');
		});

		it('should format text with bgRedBright', () => {
			const text = TextFormat.bgRedBright('hello');
			expect(text).toBe('\x1b[101mhello\x1b[49m');
		});

		it('should format text with bgGreenBright', () => {
			const text = TextFormat.bgGreenBright('hello');
			expect(text).toBe('\x1b[102mhello\x1b[49m');
		});

		it('should format text with bgYellowBright', () => {
			const text = TextFormat.bgYellowBright('hello');
			expect(text).toBe('\x1b[103mhello\x1b[49m');
		});

		it('should format text with bgBlueBright', () => {
			const text = TextFormat.bgBlueBright('hello');
			expect(text).toBe('\x1b[104mhello\x1b[49m');
		});

		it('should format text with bgMagentaBright', () => {
			const text = TextFormat.bgMagentaBright('hello');
			expect(text).toBe('\x1b[105mhello\x1b[49m');
		});

		it('should format text with bgCyanBright', () => {
			const text = TextFormat.bgCyanBright('hello');
			expect(text).toBe('\x1b[106mhello\x1b[49m');
		});

		it('should format text with bgWhiteBright', () => {
			const text = TextFormat.bgWhiteBright('hello');
			expect(text).toBe('\x1b[107mhello\x1b[49m');
		});
	});

	describe('Edge cases', () => {
		it('should handle empty string', () => {
			expect(TextFormat.bold('')).toBe('');
			expect(TextFormat.red('')).toBe('');
			expect(TextFormat.bgBlue('')).toBe('');
		});

		it('should handle nested formatting', () => {
			const nestedText = TextFormat.bold(`hello ${TextFormat.red('world')}`);
			expect(nestedText).toContain('hello');
			expect(nestedText).toContain('world');
			expect(nestedText).toMatch(/\x1b\[1m.*hello.*\x1b\[31m.*world/);
		});

		it('should handle strings containing the closing ANSI code (triggers recursion)', () => {
			// The closing code for bold is \x1b[22m. By including it in the string,
			// we force the internal `replaceClose` function to execute its recursive branch.
			const text = 'hello \x1b[22m world';
			const formattedText = TextFormat.bold(text);
			expect(formattedText).toBe('\x1b[1mhello \x1b[22m\x1b[1m world\x1b[22m');
		});

		it('should handle multiple nested ANSI codes in text', () => {
			// Multiple occurrences of the closing code
			const text = 'a \x1b[22m b \x1b[22m c';
			const formattedText = TextFormat.bold(text);
			// The replaceClose function processes recursively but only replaces in the tail after first occurrence
			expect(formattedText).toBe('\x1b[1ma \x1b[22m b \x1b[22m\x1b[1m c\x1b[22m');
		});

		it('should handle text with dim replacing its close code', () => {
			// Dim also uses 22 as close code, with special replace behavior
			const text = 'test \x1b[22m more';
			const formattedText = TextFormat.dim(text);
			expect(formattedText).toBe('\x1b[2mtest \x1b[22m\x1b[2m more\x1b[22m');
		});

		it('should handle combining multiple formatters', () => {
			const text = TextFormat.bold(TextFormat.red(TextFormat.underline('important')));
			expect(text).toContain('\x1b[1m'); // bold
			expect(text).toContain('\x1b[31m'); // red
			expect(text).toContain('\x1b[4m'); // underline
			expect(text).toContain('important');
		});

		it('should handle single occurrence of close code (no further recursion)', () => {
			// This tests the branch where next < 0 (no more close sequences in tail)
			const text = 'before \x1b[22m after';
			const formattedText = TextFormat.bold(text);
			// After the first replacement, there's no more \x1b[22m in the tail
			expect(formattedText).toBe('\x1b[1mbefore \x1b[22m\x1b[1m after\x1b[22m');
		});

		it('should handle text without any close code occurrences', () => {
			// No close code in the text at all - this tests the base case where replaceClose
			// is not called at all (or returns immediately)
			const text = 'simple text without escape codes';
			const formattedText = TextFormat.bold(text);
			expect(formattedText).toBe('\x1b[1msimple text without escape codes\x1b[22m');
		});
	});
});

describe('TextFormat color support detection', async () => {
	const originalEnv = { ...process.env };
	const originalPlatform = process.platform;
	const { isatty: originalIsatty } = await import('node:tty');

	beforeEach(async () => {
		// Reset all mocks and restore original environment
		vi.resetModules();
		process.env = { ...originalEnv };
		Object.defineProperty(process, 'platform', { value: originalPlatform });
		vi.doMock('node:tty', () => ({ isatty: originalIsatty }));
	});

	describe('FORCE_COLOR and NO_COLOR environment variables', () => {
		it('should enable colors if FORCE_COLOR is set, ignoring other settings', async () => {
			process.env.FORCE_COLOR = '1';
			process.env.TERM = 'dumb'; // This would normally disable colors
			const { TextFormat } = await import('../src/text-formatter');
			expect(TextFormat.enabled).toBe(true);
		});

		it('should disable colors if NO_COLOR is set, overriding FORCE_COLOR', async () => {
			process.env.NO_COLOR = '1';
			process.env.FORCE_COLOR = '1'; // This would normally enable colors
			const { TextFormat } = await import('../src/text-formatter');
			expect(TextFormat.enabled).toBe(false);
		});
	});

	describe('TERM environment variable', () => {
		it('should disable colors if TERM is "dumb"', async () => {
			process.env.TERM = 'dumb';
			const { TextFormat } = await import('../src/text-formatter');
			expect(TextFormat.enabled).toBe(false);
		});

		it('should enable colors if TERM is set and TTY is a TTY', async () => {
			vi.doMock('node:tty', () => ({ isatty: () => true }));
			process.env.TERM = 'xterm-256color';
			const { TextFormat } = await import('../src/text-formatter');
			expect(TextFormat.enabled).toBe(true);
		});

		it('should disable colors if TERM is set but TTY is not a TTY', async () => {
			vi.doMock('node:tty', () => ({ isatty: () => false }));
			process.env.TERM = 'xterm-256color';
			const { TextFormat } = await import('../src/text-formatter');
			expect(TextFormat.enabled).toBe(false);
		});
	});

	describe('platform-specific behavior', () => {
		it('should enable colors on Windows in a compatible terminal', async () => {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			vi.doMock('node:tty', () => ({ isatty: () => true }));
			process.env.TERM = 'cygwin'; // A non-dumb terminal
			const { TextFormat } = await import('../src/text-formatter');
			expect(TextFormat.enabled).toBe(true);
		});

		it('should disable colors on Windows in a dumb terminal', async () => {
			Object.defineProperty(process, 'platform', { value: 'win32' });
			vi.doMock('node:tty', () => ({ isatty: () => true }));
			process.env.TERM = 'dumb';
			const { TextFormat } = await import('../src/text-formatter');
			expect(TextFormat.enabled).toBe(false);
		});
	});
});
