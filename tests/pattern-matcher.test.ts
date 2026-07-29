import { describe, expect, it } from 'vitest';
import { createPatternMatcher } from '../src/pattern-matcher';

describe('createPatternMatcher', () => {
	it('matches exact string patterns', () => {
		const matcher = createPatternMatcher(['pkg']);

		expect(matcher('pkg')).toBe(true);
		expect(matcher('pkg/subpath')).toBe(false);
		expect(matcher('pkg2')).toBe(false);
	});

	it('supports allowSubpaths for exact string patterns', () => {
		const matcher = createPatternMatcher(['pkg'], { allowSubpaths: true });

		expect(matcher('pkg')).toBe(true);
		expect(matcher('pkg/subpath')).toBe(true);
		expect(matcher('pkg2/subpath')).toBe(false);
	});

	it('matches scoped packages and their subpaths', () => {
		const matcher = createPatternMatcher(['@scope/pkg'], { allowSubpaths: true });

		expect(matcher('@scope/pkg')).toBe(true);
		expect(matcher('@scope/pkg/subpath')).toBe(true);
		expect(matcher('@scope/pkg2/subpath')).toBe(false);
	});

	it('matches regexp patterns', () => {
		const matcher = createPatternMatcher([/^foo-[a-z]+$/]);

		expect(matcher('foo-bar')).toBe(true);
		expect(matcher('foo-123')).toBe(false);
		expect(matcher('bar-baz')).toBe(false);
	});

	it('supports mixed string and regexp patterns', () => {
		const matcher = createPatternMatcher(['pkg', /^@scope\/.+$/], { allowSubpaths: true });

		expect(matcher('pkg')).toBe(true);
		expect(matcher('pkg/subpath')).toBe(true);
		expect(matcher('@scope/feature')).toBe(true);
		expect(matcher('@scope/feature/subpath')).toBe(true);
		expect(matcher('other')).toBe(false);
	});
});
