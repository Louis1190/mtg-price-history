#!/usr/bin/env node
// Makes the MANA POOL set that phones and tablets read (lib/mp-files.mjs says why it is a set of its own and what the guard does).
//
//   node publish-mp.mjs --from <state dir> --out <dir> [--report <file>]
//
// <out> gets mp/<xyz>.json.gz, the same file layout as the main set (one file per first 3 hex characters of the Scryfall id, header
// `{ "_": { "v": 1, "asOf": ... } }`), holding only "mp.*" series. Then it reads <out> back and refuses (exit 1) unless every series written
// is exactly the state's, none is another vendor's, none is one the guard should have kept out, and written + kept out = the state's total:
// what goes on the site is checked once more, on the files that will be uploaded, after they were written. Without these files a phone shows
// "—" in the Mana Pool column and nothing else is affected, so the workflow lets this step fail without holding the day back.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MP_FOLDER, buildManaPoolFiles, isHiddenByGuard, isMpKey } from "./lib/mp-files.mjs";
import { dayOf } from "./lib/series-codec.mjs";
import { readMetaFile, readShards, serializeShard } from "./lib/shards.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.from || !args.out) {
	console.error("usage: node publish-mp.mjs --from <state dir> --out <dir> [--report <file>]");
	process.exit(2);
}
// A guard that hides more than this share of the series is a bug in the guard (or in the data), not a set of errors: nothing is published.
const MAX_HIDDEN_SHARE = 0.01;

const meta = readMetaFile(args.from);
const asOfDay = dayOf(meta.asOf);
const state = readShards(args.from);
const { shards, stateSeries, hiddenSeries } = buildManaPoolFiles(state, asOfDay);

const dir = join(args.out, MP_FOLDER);
mkdirSync(dir, { recursive: true });
const gzSizes = [];
for (const name of [...shards.keys()].sort()) {
	const { gz } = serializeShard(shards.get(name), meta.asOf);
	writeFileSync(join(dir, `${name}.json.gz`), gz);
	gzSizes.push(gz.length);
}
gzSizes.sort((a, b) => a - b);

// The check, on what was written.
const problems = [];
const headers = new Map();
const written = readShards(args.out, headers, MP_FOLDER);
for (const [name, h] of headers) if (JSON.stringify(h) !== JSON.stringify({ v: 1, asOf: meta.asOf })) problems.push(`${name}: the header is ${JSON.stringify(h)}, not v 1 with asOf ${meta.asOf}`);
let seriesWritten = 0;
let cards = 0;
for (const [name, byCard] of written) {
	for (const [sid, recs] of byCard) {
		cards++;
		for (const [key, rec] of Object.entries(recs)) {
			seriesWritten++;
			const stateRecs = state.get(name)?.get(sid);
			if (!isMpKey(key)) problems.push(`${sid} ${key} is not a Mana Pool series`);
			else if (JSON.stringify(stateRecs?.[key]) !== JSON.stringify(rec)) problems.push(`${sid} ${key} differs from the state`);
			else if (isHiddenByGuard(stateRecs, key, asOfDay)) problems.push(`${sid} ${key} is a price the guard keeps out`);
		}
	}
}
if (seriesWritten + hiddenSeries !== stateSeries) problems.push(`${seriesWritten} written + ${hiddenSeries} kept out is not the ${stateSeries} Mana Pool series of the state`);
const names = readdirSync(dir);
if (names.length !== written.size || names.some((n) => !/^[0-9a-f]{3}\.json\.gz$/.test(n))) problems.push("a file in mp/ is not a shard");
if (stateSeries > 0 && seriesWritten === 0) problems.push("the state has Mana Pool series and none was written");
if (stateSeries > 0 && hiddenSeries / stateSeries > MAX_HIDDEN_SHARE) problems.push(`the guard kept out ${hiddenSeries} of ${stateSeries} series (more than ${MAX_HIDDEN_SHARE * 100} %)`);

const q = (p) => gzSizes[Math.min(gzSizes.length - 1, Math.floor(p * gzSizes.length))];
const result = {
	ok: problems.length === 0,
	asOf: meta.asOf,
	files: gzSizes.length,
	cards,
	series: seriesWritten,
	stateSeries,
	hiddenSeries,
	gzBytes: gzSizes.reduce((a, b) => a + b, 0),
	gzMedian: q(0.5),
	gzMax: gzSizes[gzSizes.length - 1],
	problems: problems.slice(0, 5),
};
if (args.report) writeFileSync(args.report, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
