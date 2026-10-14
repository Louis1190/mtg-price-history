// A PASSIVE counter of what looks odd on the last day (see daily.mjs): it counts, it never hides, drops or refuses anything.
//
// Why it exists: on 2026-10-15 a measure on a real collection found that no rule against absurd prices would hide anything, and that about
// 7 series in 616 732 are absurd. A rule needs numbers over weeks (are such jumps corrected the next day? how many a day?), and a day with
// thousands of them would be a sign that MTGJSON had an incident: the series of daily counts, kept in status.json, answers both.

import { priceOnDay } from "./series-codec.mjs";

/** A last day this many times the day before (or the day before this many times the last day) is a move worth counting. */
export const MOVE_FACTOR = 8;
/** ... provided the higher of the two is at least this (cents): a card going from 5 cents to 40 is not news. */
export const MOVE_MIN_CENTS = 2000;

/** "jump", "drop" or null for a record: its last day against the day before, when the series is live on `asOfDay` and has both prices. */
export function lastDayMove(rec, asOfDay) {
	if (rec[1] !== asOfDay || rec[0] >= asOfDay) return null;
	const last = priceOnDay(rec, asOfDay);
	const before = priceOnDay(rec, asOfDay - 1);
	if (last === null || before === null || last === 0 || before === 0) return null;
	if (last >= MOVE_FACTOR * before && last >= MOVE_MIN_CENTS) return "jump";
	if (before >= MOVE_FACTOR * last && before >= MOVE_MIN_CENTS) return "drop";
	return null;
}
