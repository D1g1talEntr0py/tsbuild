import type { Pattern } from './@types';

type PatternMatcherOptions = {
	/** Match nested specifiers for exact string patterns (`pkg` matches `pkg/subpath`) */
	allowSubpaths?: boolean;
};

const alwaysFalse = () => false;

/**
 * Builds an efficient matcher for string/RegExp pattern arrays.
 *
 * String patterns support exact matches by default.
 * With `allowSubpaths: true`, `pattern` also matches `pattern/...`.
 * @param patterns An array of string or RegExp patterns to match against.
 * @param options Options for the pattern matcher.
 * @returns A function that takes a string and returns true if it matches any of the patterns.
 */
export function createPatternMatcher(patterns: readonly Pattern[], options: PatternMatcherOptions = {}): (id: string) => boolean {
	const exact = new Set<string>();
	const prefixes: string[] = [];
	const regexps: RegExp[] = [];

	for (const pattern of patterns) {
		if (typeof pattern === 'string') {
			exact.add(pattern);
			if (options.allowSubpaths) { prefixes.push(pattern + '/') }
		} else {
			regexps.push(pattern);
		}
	}

	if (exact.size === 0 && regexps.length === 0) { return alwaysFalse }

	return (id: string) => {
		if (exact.has(id)) { return true }

		for (let i = 0, length = prefixes.length; i < length; i++) {
			if (id.startsWith(prefixes[i])) { return true }
		}

		for (let i = 0, length = regexps.length; i < length; i++) {
			if (regexps[i].test(id)) { return true }
		}

		return false;
	};
}