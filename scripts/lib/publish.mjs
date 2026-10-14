// What goes on the site is the state MINUS the vendors we do not publish (see publish.mjs).
//
// Mana Pool is collected into the state but not published (decided 2026-10-15): the plugin never reads it, it was 25 % of the published
// bytes, and it is the least reliable vendor in MTGJSON's files (an integer overflow worth 21 million, prices a hundred times the other
// vendors' for a card in ten thousand: its issues #1664 and #1703). Keeping it in the state costs nothing and leaves a future curve possible.

/** Vendor codes of the series keys ("mp.n" -> "mp") that stay in the state but are left out of what is published. */
export const UNPUBLISHED_VENDORS = ["mp"];

/**
 * A copy of `shards` (Map<shard, Map<scryfallId, {seriesKey: record}>>) without the series of `vendors`. A card left with no series, and a shard
 * left with no card, disappear (the plugin reads a missing file as "the files don't know this card" and falls back, silently).
 * The records themselves are shared, not copied: they are never modified. Returns the copy and what was removed.
 */
export function withoutVendors(shards, vendors = UNPUBLISHED_VENDORS) {
	const out = new Map();
	let removedSeries = 0;
	let removedCards = 0;
	for (const [name, byCard] of shards) {
		const kept = new Map();
		for (const [sid, recs] of byCard) {
			const left = {};
			let n = 0;
			for (const [key, rec] of Object.entries(recs)) {
				if (vendors.includes(key.split(".")[0])) removedSeries++;
				else {
					left[key] = rec;
					n++;
				}
			}
			if (n > 0) kept.set(sid, left);
			else removedCards++;
		}
		if (kept.size > 0) out.set(name, kept);
	}
	return { shards: out, removedSeries, removedCards };
}
