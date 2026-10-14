#!/usr/bin/env node
// Makes the copy of the state that is PUBLISHED: the same files without the vendors in lib/publish.mjs.
//
//   node publish.mjs --from <state dir> --out <dir>
//
// <out> gets s/<xyz>.json.gz and meta.json (with the sizes and counts of the PUBLISHED files, and the list of vendors left out). Then it reads
// <out> back and refuses (exit 1) unless every published series is exactly the state's and no left-out vendor is in it: what goes on the site is
// checked once more, on the files that will be uploaded, after they were written.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { UNPUBLISHED_VENDORS, withoutVendors } from "./lib/publish.mjs";
import { readMetaFile, readShards, summarize, writeShards } from "./lib/shards.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.from || !args.out) {
	console.error("usage: node publish.mjs --from <state dir> --out <dir>");
	process.exit(2);
}
const meta = readMetaFile(args.from);
const state = readShards(args.from);
const { shards, removedSeries, removedCards } = withoutVendors(state, UNPUBLISHED_VENDORS);
const summary = summarize(shards);
const sizes = writeShards(args.out, shards, { ...meta, unpublishedVendors: UNPUBLISHED_VENDORS, counts: { ...meta.counts, ...summary } });

// The check, on what was written.
const problems = [];
if (!existsSync(join(args.out, "meta.json"))) problems.push("no meta.json");
const written = readShards(args.out);
let seriesWritten = 0;
let seriesInState = 0;
for (const byCard of state.values()) for (const recs of byCard.values()) seriesInState += Object.keys(recs).length;
for (const [name, byCard] of written) {
	for (const [sid, recs] of byCard) {
		for (const [key, rec] of Object.entries(recs)) {
			seriesWritten++;
			if (UNPUBLISHED_VENDORS.includes(key.split(".")[0])) problems.push(`${sid} ${key} is a left-out vendor`);
			else if (JSON.stringify(state.get(name)?.get(sid)?.[key]) !== JSON.stringify(rec)) problems.push(`${sid} ${key} differs from the state`);
		}
	}
}
if (seriesWritten + removedSeries !== seriesInState) problems.push(`${seriesWritten} written + ${removedSeries} left out is not the ${seriesInState} of the state`);
if (readdirSync(join(args.out, "s")).length !== written.size) problems.push("a file in s/ is not a shard");
const result = { ok: problems.length === 0, asOf: meta.asOf, stateSeries: seriesInState, published: seriesWritten, leftOutSeries: removedSeries, cardsOnlyOnLeftOutVendors: removedCards, files: sizes.files, gzBytes: sizes.gzBytes, stateGzBytes: meta.sizes?.gzBytes, problems: problems.slice(0, 5) };
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
