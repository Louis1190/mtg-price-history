// Compact encoding of ONE price series (one vendor x one finish of one printing).
//
// A record is [start, end, [off, cents], [off, cents], ...]:
//   start   first day with data (days since 1970-01-01)
//   end     last day with data
//   [off,c] from day start+off the price is c cents, until the next entry; c = null means "no data
//           from that day" (a hole inside the series: the vendor stopped listing it for a while)
// Days after `end` have no data, so a series that is still live has end == the file's as-of day.
// Invariant: the last entry is never null (trailing absence is expressed by `end`).
//
// Only CHANGES are stored, so a price that stays put for 40 days costs one entry, not 40. Both ways of
// building a record (encodeSeries from a whole history, appendPoint one day at a time) must give the
// same record, which selftest.mjs checks on random series.

export const DAY_MS = 86400000;

/** "2026-10-12" -> days since the epoch. */
export function dayOf(date) {
	return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** Days since the epoch -> "2026-10-12". */
export function dateOf(day) {
	return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** points: [[day, cents], ...] sorted by day, distinct days, at least one. */
export function encodeSeries(points) {
	const start = points[0][0];
	const rec = [start, points[points.length - 1][0]];
	let prevDay = null;
	let prevCents = null;
	for (const [day, cents] of points) {
		const contiguous = prevDay !== null && day === prevDay + 1;
		if (prevDay !== null && !contiguous) rec.push([prevDay + 1 - start, null]);
		if (prevDay === null || !contiguous || cents !== prevCents) rec.push([day - start, cents]);
		prevDay = day;
		prevCents = cents;
	}
	return rec;
}

/** Inverse of encodeSeries: [[day, cents], ...] for every day that has data. */
export function decodeSeries(rec) {
	const start = rec[0];
	const end = rec[1];
	const out = [];
	let idx = 2;
	let cur = null;
	for (let day = start; day <= end; day++) {
		while (idx < rec.length && rec[idx][0] <= day - start) {
			cur = rec[idx][1];
			idx++;
		}
		if (cur !== null) out.push([day, cur]);
	}
	return out;
}

/** Adds one day to a record (or creates it). Idempotent for a day the record already covers. */
export function appendPoint(rec, day, cents) {
	if (rec === undefined) return [day, day, [0, cents]];
	const start = rec[0];
	const end = rec[1];
	if (day <= end) return rec;
	const last = rec[rec.length - 1][1];
	if (day === end + 1) {
		if (cents !== last) rec.push([day - start, cents]);
	} else {
		rec.push([end + 1 - start, null]);
		rec.push([day - start, cents]);
	}
	rec[1] = day;
	return rec;
}

/** Price on a given day, or null: what the plugin's chart and "price on day X" would call. */
export function priceOnDay(rec, day) {
	if (day < rec[0] || day > rec[1]) return null;
	let cur = null;
	for (let i = 2; i < rec.length && rec[i][0] <= day - rec[0]; i++) cur = rec[i][1];
	return cur;
}

/** Two lists of points equal? Returns null when equal, else a short description of the first difference. */
export function diffPoints(a, b) {
	if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
	for (let i = 0; i < a.length; i++) {
		if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return `point ${i}: ${a[i]} vs ${b[i]}`;
	}
	return null;
}
