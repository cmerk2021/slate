/** Tiny fuzzy matcher: subsequence match with scoring. Returns score (higher = better) or -1. */
export function fuzzyScore(query: string, target: string): number {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	if (!q) return 0;
	let qi = 0;
	let score = 0;
	let streak = 0;
	let lastMatch = -2;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			if (ti === lastMatch + 1) streak++;
			else streak = 1;
			score += 1 + streak * 2;
			// bonus for word boundary
			if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '/' || t[ti - 1] === '-') score += 4;
			lastMatch = ti;
			qi++;
		}
	}
	if (qi < q.length) return -1;
	// shorter targets win ties
	return score - t.length * 0.05;
}
