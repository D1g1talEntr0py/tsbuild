/** Supported build report output styles. */
export const BuildOutputStyle = { DASHBOARD: 'dashboard', PIPELINE: 'pipeline', ARTIFACTS: 'artifacts', SUMMARY: 'summary', DETAILED: 'detailed' } as const;

/** A supported build report output style. */
export type BuildOutputStyle = typeof BuildOutputStyle[keyof typeof BuildOutputStyle];

/** All supported build report output style values. */
export const buildOutputStyles: readonly BuildOutputStyle[] = Object.values(BuildOutputStyle);

/** Checks whether a value is a supported build report output style.
 * @param value - The value to check
 */
export const isBuildOutputStyle = (value: unknown): value is BuildOutputStyle => buildOutputStyles.includes(value as BuildOutputStyle);
