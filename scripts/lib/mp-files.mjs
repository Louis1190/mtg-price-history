// The Mana Pool files for phones and tablets (a second, separate set next to the main one: site/mp/<xyz>.json.gz).
//
// Why a set of its own. Mana Pool is collected into the state but left out of the main files (lib/publish.mjs): putting it back there
// would make every file 29 % heavier for everybody. A computer reads Mana Pool's own price list, which is live and knows Near Mint; a phone
// cannot (the list is 49 MB and its server allows no streaming), so the plugin reads THIS set there, only on a phone or tablet, and shows
// the price as "Lowest available": MTGJSON's Mana Pool price is the lowest price across all conditions (measured 2026-10-16: equal to the
// price list's `price_cents` for 86 % of the printings of a real 4 800-printing collection, to its Near Mint price for 36 %).
//
// The files hold the same records as the state, in the same format and under the same names ("mp.n", "mp.f", "mp.e"), so the plugin
// reads them with the reader it already has. They are made from the state, never from MTGJSON.

import { priceOnOrBefore } from "./series-codec.mjs";

export const MP_FOLDER = "mp";
export const MP_VENDOR = "mp";

// The guard. MTGJSON's Mana Pool prices are the least reliable of its four vendors: an integer overflow gave $211,667 for a card TCGplayer
// sells for $250, and 83 of 146 762 printings (0.06 %) sat above ten times TCGplayer's price on 2026-10-15 (24 of them above $100, the
// others plausible thin markets). A series whose current price is more than MP_MAX_RATIO times TCGplayer's price for the same printing and
// finish AND at least MP_MIN_CENTS is not published: the phone then shows "—" for that card, which is better than a hundred-times price.
// Under the floor a high ratio is a few cents of difference, not an error. When TCGplayer has no price that day nothing can be judged
// (5 956 printings that day), the series is kept. Decided 2026-10-16.
export const MP_MAX_RATIO = 10;
export const MP_MIN_CENTS = 500;

// "Current" is read with the same tolerance as the plugin's LIVE_TOLERANCE_DAYS (core/price-history.ts): a price from the day before counts.
const CURRENT_TOLERANCE_DAYS = 1;

/** Is a Mana Pool price (cents) not credible next to TCGplayer's price for the same printing and finish (cents)? */
export function isImplausibleMpPrice(mpCents, tcgCents) {
	return tcgCents > 0 && mpCents >= MP_MIN_CENTS && mpCents > MP_MAX_RATIO * tcgCents;
}

/** Is this state key one of Mana Pool's ("mp.n" -> true)? */
export function isMpKey(key) {
	return key.split(".")[0] === MP_VENDOR;
}

/** Is the Mana Pool series `mp.<finish>` of this card, as it stands on `asOfDay`, one the guard keeps out? */
export function isHiddenByGuard(recs, key, asOfDay) {
	const finish = key.slice(MP_VENDOR.length + 1);
	const tcgRec = recs[`tcg.${finish}`];
	if (!tcgRec) return false;
	const mp = priceOnOrBefore(recs[key], asOfDay, CURRENT_TOLERANCE_DAYS);
	const tcg = priceOnOrBefore(tcgRec, asOfDay, CURRENT_TOLERANCE_DAYS);
	return mp !== null && tcg !== null && isImplausibleMpPrice(mp, tcg);
}

/**
 * The Mana Pool set of a state (Map<shard, Map<scryfallId, {seriesKey: record}>>): only the "mp.*" series, minus the ones the guard keeps out.
 * A card left with no series, and a shard left with no card, disappear (the plugin reads a missing file as "no price here"). The records are shared
 * with the state, never copied or modified. Returns the set and what was counted.
 */
export function buildManaPoolFiles(state, asOfDay) {
	const out = new Map();
	let stateSeries = 0;
	let hiddenSeries = 0;
	for (const [name, byCard] of state) {
		const kept = new Map();
		for (const [sid, recs] of byCard) {
			const left = {};
			let n = 0;
			for (const key of Object.keys(recs)) {
				if (!isMpKey(key)) continue;
				stateSeries++;
				if (isHiddenByGuard(recs, key, asOfDay)) {
					hiddenSeries++;
					continue;
				}
				left[key] = recs[key];
				n++;
			}
			if (n > 0) kept.set(sid, left);
		}
		if (kept.size > 0) out.set(name, kept);
	}
	return { shards: out, stateSeries, hiddenSeries };
}
