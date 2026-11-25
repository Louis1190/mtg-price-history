// The size of every paper set, for the plugin's "progress" of a list that collects one set (the cards owned out of the cards of the set).
//
// Why a file of ours: Scryfall gives the size of a set's base only for part of the sets (it is missing for most recent ones), MTGJSON gives one for
// every set (`SetList.json`, a few MB with all its other fields). This keeps three values per set, a few KB once compressed:
//
//   sets.json   { "v": 1, "asOf": "2026-11-25", "sets": { "<code>": [baseSetSize, totalSetSize, "<type>"], ... } }
//
// The values are MTGJSON's, unchanged: what they are worth, and which of them a reader may rely on, is the reader's business (the plugin uses the base
// size for core, expansion, masters and draft_innovation sets only, because it is often wrong for the others). Online-only sets are left out.

/** The set types for which a base size means something; the gate below counts them. */
export const MAIN_TYPES = new Set(["core", "expansion", "masters", "draft_innovation"]);
/** Gates: far under what MTGJSON held on 2026-11-25, so that a truncated or reshaped file is refused and a normal day never is. */
export const MIN_SETS = 700;
export const MIN_MAIN_SETS = 150;
/** No set holds more cards than this (the largest of 2026, a reprint product, holds under 6 000). */
export const MAX_SIZE = 20000;

const isSize = (n) => Number.isInteger(n) && n >= 0 && n <= MAX_SIZE;
const validEntry = (code, base, total, type) =>
	/^[a-z0-9]{2,8}$/.test(code) && isSize(base) && isSize(total) && total > 0 && typeof type === "string" && /^[a-z_]{1,30}$/.test(type);

/** MTGJSON's parsed SetList.json -> the file to publish. Throws when it does not look like a SetList at all. */
export function buildSetSizes(setList) {
	const asOf = setList?.meta?.date;
	if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("SetList has no meta.date");
	if (!Array.isArray(setList.data)) throw new Error("SetList has no data list");
	const entries = [];
	let skipped = 0;
	for (const set of setList.data) {
		if (set?.isOnlineOnly) continue;
		const code = typeof set?.code === "string" ? set.code.toLowerCase() : "";
		if (!validEntry(code, set?.baseSetSize, set?.totalSetSize, set?.type)) {
			skipped++;
			continue;
		}
		entries.push([code, [set.baseSetSize, set.totalSetSize, set.type]]);
	}
	entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return { file: { v: 1, asOf, sets: Object.fromEntries(entries) }, skipped };
}

/** What is wrong with a file about to be published; an empty list = nothing. */
export function checkSetSizes(file) {
	if (file?.v !== 1) return ["the format version is not 1"];
	if (typeof file.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(file.asOf)) return ["asOf is not a day"];
	if (!file.sets || typeof file.sets !== "object") return ["there is no sets object"];
	const problems = [];
	let count = 0;
	let main = 0;
	for (const [code, entry] of Object.entries(file.sets)) {
		count++;
		if (!Array.isArray(entry) || entry.length !== 3 || !validEntry(code, ...entry)) problems.push(`${code}: bad entry ${JSON.stringify(entry)}`);
		else if (MAIN_TYPES.has(entry[2])) main++;
	}
	if (count < MIN_SETS) problems.push(`only ${count} sets (expected at least ${MIN_SETS})`);
	if (main < MIN_MAIN_SETS) problems.push(`only ${main} sets of the main types (expected at least ${MIN_MAIN_SETS})`);
	return problems.slice(0, 10);
}
