/** Shared performance labels used by build instrumentation and report rendering. */
export const PerformancePhase = {
	BUILD: 'Build',
	INITIALIZATION: 'Initialization',
	COMPILE: 'Compile',
	BUNDLE: 'Bundle',
	DECLARATIONS: 'Process Declarations',
	TRANSPILE: 'Transpile'
} as const;

/** A valid named phase used by build performance instrumentation. */
export type PerformancePhase = typeof PerformancePhase[keyof typeof PerformancePhase];
