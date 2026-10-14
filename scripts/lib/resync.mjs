// The merge behind the weekly resynchronisation (see resync.mjs and README.md, "Resynchronising").
//
// The daily job only appends AllPricesToday, one day at a time, and never reads MTGJSON's 90-day history again, so
// a day it missed stays a hole and a value MTGJSON corrected later never arrives. A resync takes a FRESH set built
// from MTGJSON's current AllPrices and reconciles our stored series with it, with ONE rule:
//
//   days inside the window of the fresh set (its first day on)  -> MTGJSON's current word wins, in both directions
//                                                                  (a day it has and we lack is added, a value it
//                                                                  changed is replaced, a day it no longer has goes)
//   days before the window                                      -> ours, untouched (MTGJSON only keeps 90 days: the
//                                                                  older history exists nowhere else but here)

import { decodeSeries, encodeSeries } from "./series-codec.mjs";

/**
 * What a resync would change in the window, point by point: days only the fresh side has (added), days both have with
 * another price (changed), days only we have (removed). Both lists are sorted by day.
 */
export function diffWindow(prevPoints, freshPoints) {
	let added = 0;
	let changed = 0;
	let removed = 0;
	let i = 0;
	let j = 0;
	while (i < prevPoints.length || j < freshPoints.length) {
		if (j >= freshPoints.length || (i < prevPoints.length && prevPoints[i][0] < freshPoints[j][0])) {
			removed++;
			i++;
		} else if (i >= prevPoints.length || freshPoints[j][0] < prevPoints[i][0]) {
			added++;
			j++;
		} else {
			if (prevPoints[i][1] !== freshPoints[j][1]) changed++;
			i++;
			j++;
		}
	}
	return { added, changed, removed };
}

/**
 * One series. prevRec / freshRec: records or undefined. windowStart: first day of the fresh set's window.
 * Returns { rec, added, changed, removed, keptOlder } where rec is the merged record (undefined = no series left).
 * `mutate` is for the proof chain only: deliberately broken merges that verify.mjs must reject.
 */
export function mergeSeries(prevRec, freshRec, windowStart, mutate = undefined) {
	const prev = prevRec ? decodeSeries(prevRec) : [];
	const fresh = freshRec ? decodeSeries(freshRec) : [];
	const older = prev.filter(([day]) => day < windowStart);
	const prevWindow = prev.filter(([day]) => day >= windowStart);
	const stats = diffWindow(prevWindow, fresh);
	let merged;
	if (mutate === "keep-prev-window") merged = prev; // never takes MTGJSON's word for the window
	else if (mutate === "drop-old-history") merged = fresh; // forgets what is older than the window
	else if (mutate === "ignore-removed") merged = [...older, ...fresh, ...prevWindow.filter(([d]) => !fresh.some(([fd]) => fd === d))].sort((a, b) => a[0] - b[0]);
	else merged = older.concat(fresh); // older days all precede the window, fresh days all start in it: already sorted
	return { rec: merged.length ? encodeSeries(merged) : undefined, ...stats, keptOlder: older.length };
}
