#!/usr/bin/env node
// Weekly resynchronisation of the stored price history with MTGJSON's 90-day file (see README.md, "Resynchronising").
//
//   node resync.mjs --prev <dir> --fresh <dir> --out <dir> [--dry-run] [--restore] [--mutate <name>]
//
//   --prev     the set we publish (what the daily job appended to)
//   --fresh    a set built by `build.mjs build` from the CURRENT AllPrices (the source's word on its whole window)
//   --out      where the reconciled set goes (not written with --dry-run, which only reports what WOULD change)
//   --restore  --prev is a SNAPSHOT older than the fresh set (restoring after a bad day, README.md "Backups and restoring"): every series
//              gains the days since the snapshot and the cards released since it are new series, which is what a snapshot lacks by
//              definition and would trip the 5 % gate for ever. The gate then counts only what could damage what we HOLD: values
//              changed, days removed, series that disappear. The independent check (verify.mjs resync) is unchanged and still decides.
//
// The rule is lib/resync.mjs's: inside the fresh set's window MTGJSON's current word wins, before it ours is kept.
// It refuses (exit 1, nothing written) when the result looks wrong: a fresh set older than ours, more series changed
// than a week of upstream corrections can explain, or series disappearing. A resync is an improvement, never a risk to
// what is already published: the caller keeps the previous set when this fails.

import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { mergeSeries } from "./lib/resync.mjs";
import { dayOf } from "./lib/series-codec.mjs";
import { readMetaFile, summarize, writeShards } from "./lib/shards.mjs";

// Refusal thresholds. A week of daily appends differs from MTGJSON's own history on the days its two files disagree
// (~0.5 % of the series on one day, measured 2026-10-13) and on the days we missed: far below 5 %.
const MAX_CHANGED_RATIO = 0.05;
const MAX_LOST_SERIES_RATIO = 0.005;

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		if (!argv[i].startsWith("--")) continue;
		const key = argv[i].slice(2);
		args[key] = argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[++i];
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.prev || !args.fresh || (!args.out && !args["dry-run"])) {
	console.error("usage: node resync.mjs --prev <dir> --fresh <dir> --out <dir> [--dry-run] [--restore] [--mutate <name>]");
	process.exit(2);
}
const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const out = (obj, code = 0) => {
	console.log(JSON.stringify({ ...obj, seconds: Math.round((Date.now() - t0) / 1000) }, null, 1));
	process.exit(code);
};

const prevMeta = readMetaFile(args.prev);
const freshMeta = readMetaFile(args.fresh);
const report = { dryRun: !!args["dry-run"], prevAsOf: prevMeta.asOf, freshAsOf: freshMeta.asOf, windowStart: freshMeta.firstDay };
if (prevMeta.format !== 1 || freshMeta.format !== 1) out({ ...report, refused: "unknown set format" }, 1);
if (freshMeta.asOf < prevMeta.asOf) out({ ...report, refused: `the fresh set is as of ${freshMeta.asOf}, older than ours (${prevMeta.asOf})` }, 1);
const windowStart = dayOf(freshMeta.firstDay);

const readShardFile = (dir, name) => {
	const file = join(dir, "s", `${name}.json.gz`);
	return existsSync(file) ? JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) : { _: null };
};
const names = new Set();
for (const dir of [args.prev, args.fresh]) for (const f of readdirSync(join(dir, "s"))) if (f.endsWith(".json.gz")) names.add(f.slice(0, -".json.gz".length));

const totals = { prevSeries: 0, freshSeries: 0, mergedSeries: 0, unchangedSeries: 0, changedSeries: 0, correctedSeries: 0, createdSeries: 0, droppedSeries: 0, added: 0, changed: 0, removed: 0, keptOlderPoints: 0 };
const byVendor = {};
const examples = [];
const merged = new Map();
for (const name of [...names].sort()) {
	const prevShard = readShardFile(args.prev, name);
	const freshShard = readShardFile(args.fresh, name);
	const byCard = new Map();
	const sids = new Set([...Object.keys(prevShard), ...Object.keys(freshShard)]);
	sids.delete("_");
	for (const sid of [...sids].sort()) {
		const prevRecs = prevShard[sid] ?? {};
		const freshRecs = freshShard[sid] ?? {};
		const recs = {};
		for (const key of new Set([...Object.keys(prevRecs), ...Object.keys(freshRecs)])) {
			const r = mergeSeries(prevRecs[key], freshRecs[key], windowStart, args.mutate);
			if (prevRecs[key]) totals.prevSeries++;
			if (freshRecs[key]) totals.freshSeries++;
			const touched = r.added + r.changed + r.removed > 0;
			if (!prevRecs[key]) totals.createdSeries++;
			else if (!r.rec) totals.droppedSeries++;
			else if (touched) {
				totals.changedSeries++;
				if (r.changed + r.removed > 0) totals.correctedSeries++; // a value or a day we hold that MTGJSON says otherwise (not only days we lack)
			}
			else totals.unchangedSeries++;
			if (touched) {
				const v = key.split(".")[0];
				byVendor[v] ??= { series: 0, added: 0, changed: 0, removed: 0 };
				byVendor[v].series++;
				byVendor[v].added += r.added;
				byVendor[v].changed += r.changed;
				byVendor[v].removed += r.removed;
				if (examples.length < 8) examples.push({ sid, key, added: r.added, changed: r.changed, removed: r.removed });
			}
			totals.added += r.added;
			totals.changed += r.changed;
			totals.removed += r.removed;
			totals.keptOlderPoints += r.keptOlder;
			if (r.rec) {
				recs[key] = r.rec;
				totals.mergedSeries++;
			}
		}
		if (Object.keys(recs).length) byCard.set(sid, recs);
	}
	if (byCard.size) merged.set(name, byCard);
}
log(`merged ${merged.size} shards`);

const touchedSeries = totals.changedSeries + totals.createdSeries + totals.droppedSeries;
// A restore from a snapshot: only what could damage what we hold counts (README.md, "Backups and restoring").
const gatedSeries = args.restore ? totals.correctedSeries + totals.droppedSeries : touchedSeries;
const ratioOf = (n) => Number((n / Math.max(totals.prevSeries, 1)).toFixed(5));
Object.assign(report, totals, { restore: !!args.restore, touchedRatio: ratioOf(touchedSeries), gatedRatio: ratioOf(gatedSeries), byVendor, examples });
if (gatedSeries / Math.max(totals.prevSeries, 1) > MAX_CHANGED_RATIO) {
	const verb = args.restore ? "have a value or a day corrected, or disappear" : "would change";
	out({ ...report, refused: `${gatedSeries} of ${totals.prevSeries} series ${verb} (more than ${MAX_CHANGED_RATIO * 100} %)` }, 1);
}
if (totals.mergedSeries < totals.prevSeries * (1 - MAX_LOST_SERIES_RATIO)) out({ ...report, refused: `${totals.mergedSeries} series left, from ${totals.prevSeries}` }, 1);
if (args["dry-run"]) out(report);

const summary = summarize(merged);
const sizes = writeShards(args.out, merged, {
	...prevMeta,
	format: 1,
	mtgjson: freshMeta.mtgjson,
	asOf: summary.asOf,
	firstDay: summary.firstDay,
	builtAt: new Date().toISOString(),
	resyncedFrom: prevMeta.asOf,
	resyncedAsOf: freshMeta.asOf,
	counts: { ...prevMeta.counts, ...summary },
});
// The id map belongs next to the set (the daily job reads it from the state): carried over, so the result can serve as the state at once.
if (existsSync(join(args.prev, "idmap.json"))) copyFileSync(join(args.prev, "idmap.json"), join(args.out, "idmap.json"));
log(`written: ${sizes.files} files`);
out({ ...report, sizes });
