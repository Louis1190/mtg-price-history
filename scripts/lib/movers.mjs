// Market movers (the plugin's Home "Market trends" block) computed from the state: the cards whose price moved the most, per period and vendor.
//
// Why it exists: the block used to read cardbase.dev's /movers, which has been frozen since 2026-09-09, and whose raw top of every list is
// made of placeholder prices. Our state already holds every price of every day, so the same lists are a pass over it (2 s on the real set).
// Measured on the real state of 2026-10-13: the filter has to come BEFORE the ranking (the raw top 100 keeps 0-9 rows once filtered), and
// what a list is made of depends on its rule.
//
// What a list is (chosen on 2026-10-15 from four variants compared side by side on that state):
//   1. only series live on the last day, with a price on both days compared (a vendor that stopped listing a card has no move);
//   2. the plugin's own anomaly filter (isImplausible, the twin of src/core/market-movers.ts shouldHideMover);
//   3. a floor: the lower of the two prices is at least FLOOR;
//   4. for 7 days and 30 days: another vendor (same card, same finish, same period) moved the same way, by CONFIRM_UP_PCT or more up / CONFIRM_DOWN_PCT or
//      more down. At 24 h it is NOT asked: a one-day spike has not reached a second vendor yet (measured: 6 candidates left out of 12 000);
//   5. ranked by percent, a printing's duplicate (same name, vendor, finish and prices: 7ED #237 and #237*) kept once, the first LIST_LIMIT kept.
// Cardmarket repeats the previous day's whole list on some days (0 % of its series changed on 2026-09-23, 10-05 and 10-13 against ~25 %
// usually): a vendor's "last day" is the latest one on which at least NEW_DAY_MIN_SHARE of its series really changed, so that its 24 h list
// is not empty on those days (and a vendor that stopped altogether shows an old `as_of`, which the plugin turns into its stale-data notice).
// Mana Pool is not here: collected, not published.
//
// The files have cardbase's own response shape ({data: {period, gainers, losers}, meta: {as_of}}), so the plugin reads them with the
// parser it already has and the Home block did not change.

import { EXPECTED_CURRENCY } from "./model.mjs";
import { dateOf, priceOnDay } from "./series-codec.mjs";

/** Period name (the plugin's CardbaseMoverPeriod) -> days. */
export const PERIODS = { "1d": 1, "7d": 7, "30d": 30 };
/** Vendor code of the series keys -> the name the plugin knows it by (CardbaseVendor). */
export const MOVER_VENDORS = { cm: "cardmarket", tcg: "tcgplayer", ck: "cardkingdom" };
export const FINISH_NAMES = { n: "normal", f: "foil", e: "etched" };
/** Rows per side in each file: the plugin shows 5, then 20 with "Show more". */
export const LIST_LIMIT = 20;

/** The plugin's anomaly filter, same numbers as src/core/market-movers.ts (golden.mjs writes the cases both sides are tested against). */
export const MIN_PRICE = 2;
export const MAX_JUMP_RATIO = 5;
export const HIGH_PRICE = 250;
export const HIGH_PRICE_MAX_JUMP_RATIO = 2;
/** The lower of the two prices must be at least this (the vendor's own currency). */
export const FLOOR = 5;
/** Another vendor's confirmation, in percent of ITS OWN move (a rise of 25 % and a fall of 20 % are the same size seen from either end). */
export const CONFIRM_UP_PCT = 25;
export const CONFIRM_DOWN_PCT = -20;
/** Which periods ask for a confirmation. */
export const CONFIRMED_PERIODS = new Set(["7d", "30d"]);
/** A vendor's day counts as "new" when at least this share of its series differs from the day before. */
export const NEW_DAY_MIN_SHARE = 0.02;
/** How far back to look for a vendor's latest new day (a vendor with none in that many days is reported as that old). */
export const LOOKBACK_DAYS = 6;

/** Prices in the vendor's own currency, whole units. true = the move is an artefact (a placeholder, a collapse to nothing, a showcase price). */
export function isImplausible(from, to) {
	if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	if (lo < MIN_PRICE) return true;
	const ratio = hi / lo;
	if (ratio > MAX_JUMP_RATIO) return true;
	return hi >= HIGH_PRICE && ratio > HIGH_PRICE_MAX_JUMP_RATIO;
}

/** Each moves-vendor's latest "new" day, as days since the epoch: { cm, tcg, ck }. */
export function vendorLastNewDays(shards, asOfDay) {
	const changed = new Map();
	const compared = new Map();
	for (const byCard of shards.values()) {
		for (const recs of byCard.values()) {
			for (const [key, rec] of Object.entries(recs)) {
				const v = key.split(".")[0];
				if (!(v in MOVER_VENDORS) || rec[1] !== asOfDay) continue;
				for (let d = asOfDay - LOOKBACK_DAYS + 1; d <= asOfDay; d++) {
					const before = priceOnDay(rec, d - 1);
					const now = priceOnDay(rec, d);
					if (!before || !now) continue;
					const k = `${v}|${d}`;
					compared.set(k, (compared.get(k) ?? 0) + 1);
					if (before !== now) changed.set(k, (changed.get(k) ?? 0) + 1);
				}
			}
		}
	}
	const days = {};
	for (const v of Object.keys(MOVER_VENDORS)) {
		let day = asOfDay;
		while (day > asOfDay - LOOKBACK_DAYS + 1 && (changed.get(`${v}|${day}`) ?? 0) / Math.max(1, compared.get(`${v}|${day}`) ?? 1) < NEW_DAY_MIN_SHARE) day--;
		days[v] = day;
	}
	return days;
}

/** Every series that moved over each period: { "1d": [row...], ... } with row = { sid, v, f, from, to, pct } (prices in whole units). */
export function collectMoves(shards, asOfDay, lastNewDays) {
	const rows = Object.fromEntries(Object.keys(PERIODS).map((p) => [p, []]));
	for (const byCard of shards.values()) {
		for (const [sid, recs] of byCard) {
			for (const [key, rec] of Object.entries(recs)) {
				const [v, f] = key.split(".");
				if (!(v in MOVER_VENDORS) || !(f in FINISH_NAMES) || rec[1] !== asOfDay) continue;
				const end = lastNewDays[v];
				const to = priceOnDay(rec, end);
				if (!to) continue;
				for (const [period, days] of Object.entries(PERIODS)) {
					const from = priceOnDay(rec, end - days);
					if (!from || from === to) continue;
					rows[period].push({ sid, v, f, from: from / 100, to: to / 100, pct: ((to - from) / from) * 100 });
				}
			}
		}
	}
	return rows;
}

const compareRows = (dir) => (a, b) => (dir === "up" ? b.pct - a.pct : a.pct - b.pct) || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0) || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0) || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0);

/** The two lists of one file. `view` = "all" or a vendor code. */
export function selectMovers(rows, period, view, nameOf, byCardFinish) {
	const confirmed = (r) => {
		const others = byCardFinish.get(`${r.sid}|${r.f}`) ?? {};
		return Object.entries(others).some(([v, pct]) => v !== r.v && (r.pct > 0 ? pct >= CONFIRM_UP_PCT : pct <= CONFIRM_DOWN_PCT));
	};
	const pool = rows.filter((r) => (view === "all" || r.v === view) && !isImplausible(r.from, r.to) && Math.min(r.from, r.to) >= FLOOR && (!CONFIRMED_PERIODS.has(period) || confirmed(r)));
	const pick = (dir) => {
		const seen = new Set();
		const out = [];
		for (const r of pool.filter((x) => (dir === "up" ? x.pct > 0 : x.pct < 0)).sort(compareRows(dir))) {
			const name = nameOf(r.sid);
			if (!name) continue;
			const key = `${name}|${r.v}|${r.f}|${r.from}|${r.to}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ row: r, name });
			if (out.length === LIST_LIMIT) break;
		}
		return out;
	};
	return { gainers: pick("up"), losers: pick("down") };
}

const toRaw = ({ row: r, name }) => ({
	scryfall_id: r.sid,
	name,
	vendor: MOVER_VENDORS[r.v],
	finish: FINISH_NAMES[r.f],
	currency: EXPECTED_CURRENCY[MOVER_VENDORS[r.v]],
	price_from: r.from,
	price_to: r.to,
	change_pct: Math.round(r.pct * 100) / 100,
});

/** File names are `<period>-<view>.json` under movers/ ; view = "all" or the plugin's vendor name. */
export const moverFileName = (period, view) => `movers/${period}-${view === "all" ? "all" : MOVER_VENDORS[view]}.json`;

/**
 * Every file of the movers: { files: { name: JSON text }, report }.
 * `shards`: the state (Map shard -> Map sid -> {key: record}); `nameOf(sid)` the card's name (MTGJSON's, never Scryfall's).
 */
export function buildMoverFiles(shards, asOfDay, nameOf) {
	const lastNewDays = vendorLastNewDays(shards, asOfDay);
	const rowsByPeriod = collectMoves(shards, asOfDay, lastNewDays);
	const files = {};
	const counts = {};
	for (const period of Object.keys(PERIODS)) {
		const rows = rowsByPeriod[period];
		// sid|finish -> { vendor: pct }, for the confirmation (every vendor's own move, whatever list it ends up in).
		const byCardFinish = new Map();
		for (const r of rows) {
			const k = `${r.sid}|${r.f}`;
			let o = byCardFinish.get(k);
			if (!o) byCardFinish.set(k, (o = {}));
			o[r.v] = r.pct;
		}
		for (const view of ["all", ...Object.keys(MOVER_VENDORS)]) {
			const { gainers, losers } = selectMovers(rows, period, view, nameOf, byCardFinish);
			// A vendor's file is as old as that vendor's latest new day; the combined one as the newest of them.
			const asOf = dateOf(view === "all" ? Math.max(...Object.values(lastNewDays)) : lastNewDays[view]);
			const name = moverFileName(period, view);
			files[name] = JSON.stringify({ data: { period, gainers: gainers.map(toRaw), losers: losers.map(toRaw) }, meta: { as_of: asOf } });
			counts[name] = { gainers: gainers.length, losers: losers.length, asOf };
		}
	}
	return { files, report: { asOf: dateOf(asOfDay), lastNewDays: Object.fromEntries(Object.entries(lastNewDays).map(([v, d]) => [v, dateOf(d)])), files: counts } };
}
