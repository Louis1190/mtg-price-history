#!/usr/bin/env node
// Writes the market movers (see lib/movers.mjs) that the plugin's Home block reads, then checks what it wrote.
//
//   node movers.mjs --from <state dir> --out <dir> [--report <file>]
//
// <out> gets movers/<period>-<view>.json (3 periods x 4 views: all, cardmarket, tcgplayer, cardkingdom). The names come from the state's
// idmap.json (MTGJSON's, never Scryfall's). It then reads <out> back and refuses (exit 1) unless every file parses, every row follows the rules
// and every price is exactly the state's: what goes on the site is checked once more, on the files that will be uploaded.
// The daily workflow runs this step apart from the prices and tolerates its failure: without these files the plugin keeps asking cardbase for
// the movers, which is stale but harmless, and a bug here must never hold back the day's prices.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FINISH_NAMES, FLOOR, LIST_LIMIT, MOVER_VENDORS, PERIODS, buildMoverFiles, isImplausible, moverFileName, vendorLastNewDays } from "./lib/movers.mjs";
import { dayOf, priceOnDay } from "./lib/series-codec.mjs";
import { readMetaFile, readShards } from "./lib/shards.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.from || !args.out) {
	console.error("usage: node movers.mjs --from <state dir> --out <dir> [--report <file>]");
	process.exit(2);
}
const t0 = Date.now();
const meta = readMetaFile(args.from);
const asOfDay = dayOf(meta.asOf);
const state = readShards(args.from);
const names = new Map();
for (const v of Object.values(JSON.parse(readFileSync(join(args.from, "idmap.json"), "utf8")))) names.set(v[0], v[2]);

const { files, report } = buildMoverFiles(state, asOfDay, (sid) => names.get(sid));
for (const [name, text] of Object.entries(files)) {
	const file = join(args.out, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

// The check, on what was written.
const problems = [];
const problem = (text) => problems.length < 20 && problems.push(text);
const VENDOR_BY_NAME = Object.fromEntries(Object.entries(MOVER_VENDORS).map(([code, name]) => [name, code]));
const FINISH_BY_NAME = Object.fromEntries(Object.entries(FINISH_NAMES).map(([code, name]) => [name, code]));
const lastNewDays = vendorLastNewDays(state, asOfDay);
// Found by card id alone, not through the shard it should be in: this check must not depend on the thing that decides where a card lives.
const recordsOf = new Map();
for (const byCard of state.values()) for (const [sid, recs] of byCard) recordsOf.set(sid, recs);
let rows = 0;
for (const period of Object.keys(PERIODS)) {
	for (const view of ["all", ...Object.keys(MOVER_VENDORS)]) {
		const name = moverFileName(period, view);
		let body;
		try {
			body = JSON.parse(readFileSync(join(args.out, name), "utf8"));
		} catch {
			problem(`${name}: not readable`);
			continue;
		}
		if (body?.data?.period !== period) problem(`${name}: wrong period`);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(body?.meta?.as_of ?? "")) problem(`${name}: no as_of`);
		for (const [side, list, dir] of [["gainers", body?.data?.gainers, 1], ["losers", body?.data?.losers, -1]]) {
			if (!Array.isArray(list) || list.length > LIST_LIMIT) {
				problem(`${name}: ${side} is not a list of at most ${LIST_LIMIT}`);
				continue;
			}
			list.forEach((r, i) => {
				rows++;
				const code = VENDOR_BY_NAME[r.vendor];
				const f = FINISH_BY_NAME[r.finish];
				if (!code || !f) return problem(`${name}: ${r.scryfall_id} has vendor ${r.vendor}, finish ${r.finish}`);
				if (view !== "all" && code !== view) problem(`${name}: ${r.scryfall_id} is ${r.vendor}`);
				if (!r.name || typeof r.name !== "string") problem(`${name}: ${r.scryfall_id} has no name`);
				if (Math.sign(r.change_pct) !== dir) problem(`${name}: ${r.scryfall_id} is in ${side} with ${r.change_pct} %`);
				if (i > 0 && (list[i - 1].change_pct - r.change_pct) * dir < 0) problem(`${name}: ${side} is not sorted at ${i}`);
				if (isImplausible(r.price_from, r.price_to) || Math.min(r.price_from, r.price_to) < FLOOR) problem(`${name}: ${r.scryfall_id} breaks the rules (${r.price_from} -> ${r.price_to})`);
				// Every price is the state's own, read again straight from the record.
				const rec = recordsOf.get(r.scryfall_id)?.[`${code}.${f}`];
				const end = lastNewDays[code];
				if (!rec || Math.round(r.price_to * 100) !== priceOnDay(rec, end) || Math.round(r.price_from * 100) !== priceOnDay(rec, end - PERIODS[period])) problem(`${name}: ${r.scryfall_id} ${code}.${f} differs from the state`);
			});
		}
	}
}
const result = { ok: problems.length === 0, ...report, rows, seconds: Math.round((Date.now() - t0) / 1000), problems };
if (args.report) writeFileSync(args.report, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
