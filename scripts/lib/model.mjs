// What a shard holds and how a MTGJSON entry becomes series. Shared by build, update and verify so
// the three can never disagree about a key.

import { dayOf } from "./series-codec.mjs";

/** MTGJSON vendor name -> short code used in the files (kept short: it is repeated 750 000 times). */
export const VENDOR_CODES = { cardmarket: "cm", tcgplayer: "tcg", cardkingdom: "ck", manapool: "mp" };

/** MTGJSON finish name -> short code. */
export const FINISH_CODES = { normal: "n", foil: "f", etched: "e" };

/** Number of hex characters of the Scryfall id that name a shard: 3 -> 4 096 files. */
export const SHARD_CHARS = 3;

export function shardOf(scryfallId) {
	return scryfallId.slice(0, SHARD_CHARS);
}

/** Scryfall ids that MTGJSON knows under several uuids (a double-faced card has one uuid per face). */
export function multiUuidSids(idmap) {
	const seen = new Set();
	const multi = new Set();
	for (const ids of Object.values(idmap)) {
		if (seen.has(ids[0])) multi.add(ids[0]);
		seen.add(ids[0]);
	}
	return multi;
}

/**
 * One series from several MTGJSON entries describing the same Scryfall printing: the UNION of their
 * days. Measured on the 2026-10-13 files, 15 482 series are described twice (24 three times) and across
 * 1.3 million days they NEVER disagree on a day both hold; they only differ by which days each has (one
 * face lagging a day, other holes). If they ever did, the smallest uuid wins, so the result does not
 * depend on the order the file is read in.
 * candidates: [{uuid, points}], returns points sorted by day.
 */
export function unionPoints(candidates) {
	if (candidates.length === 1) return candidates[0].points;
	const byDay = new Map();
	for (const { points } of [...candidates].sort((a, b) => (a.uuid < b.uuid ? -1 : 1))) {
		for (const [day, cents] of points) if (!byDay.has(day)) byDay.set(day, cents);
	}
	return [...byDay.entries()].sort((a, b) => a[0] - b[0]);
}

// 68 million date strings go through here in a full build, but only ~90 distinct ones.
const dayCache = new Map();
function cachedDayOf(date) {
	let d = dayCache.get(date);
	if (d === undefined) {
		d = dayOf(date);
		dayCache.set(date, d);
	}
	return d;
}

/**
 * The retail series of one MTGJSON entry (`{paper: {vendor: {retail: {finish: {date: price}}}}}`) as
 * a list of {key, points}, where key is "<vendor>.<finish>" and points are [[day, cents], ...] sorted.
 * Buylist prices and MTGO (cardhoarder) are left out on purpose, see README.
 * `untilDay` drops later days (used to rehearse the daily update from an older file).
 * `stats` collects what the codec has to know about the source (non-cent prices).
 */
export function seriesOfEntry(entry, untilDay = Infinity, stats = undefined) {
	const out = [];
	const paper = entry.paper;
	if (!paper) return out;
	for (const [vendor, vcode] of Object.entries(VENDOR_CODES)) {
		const retail = paper[vendor]?.retail;
		if (!retail) continue;
		for (const [finish, fcode] of Object.entries(FINISH_CODES)) {
			const byDate = retail[finish];
			if (!byDate) continue;
			const points = [];
			for (const [date, price] of Object.entries(byDate)) {
				const day = cachedDayOf(date);
				if (day > untilDay) continue;
				const cents = Math.round(price * 100);
				if (stats && Math.abs(price * 100 - cents) > 1e-6) stats.nonCent++;
				points.push([day, cents]);
			}
			if (points.length === 0) continue;
			points.sort((a, b) => a[0] - b[0]);
			out.push({ key: `${vcode}.${fcode}`, points });
		}
	}
	return out;
}
