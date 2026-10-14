// Reading and writing the shard directory.
//
//   <dir>/meta.json            what the set covers (as-of day, MTGJSON version, counts)
//   <dir>/s/<xyz>.json.gz      one file per first 3 hex characters of the Scryfall id (4 096 at most)
//                              { "_": { "v": 1, "asOf": "2026-10-13" },
//                                "<scryfallId>": { "<vendor>.<finish>": record, ... }, ... }
//                              `_` first: the format version and the as-of day travel WITH each file, so a
//                              reader never needs a second request to know how old what it holds is.
//
// In memory a set is Map<shardName, Map<scryfallId, {seriesKey: record}>>.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { dateOf } from "./series-codec.mjs";

export const SHARD_FORMAT_VERSION = 1;

export function readShards(dir) {
	const shards = new Map();
	const sdir = join(dir, "s");
	for (const name of readdirSync(sdir)) {
		if (!name.endsWith(".json.gz")) continue;
		const obj = JSON.parse(gunzipSync(readFileSync(join(sdir, name))).toString("utf8"));
		const byCard = new Map();
		for (const [sid, series] of Object.entries(obj)) if (sid !== "_") byCard.set(sid, series);
		shards.set(name.slice(0, -".json.gz".length), byCard);
	}
	return shards;
}

export function readMetaFile(dir) {
	return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
}

/** Deterministic: sorted keys, fixed gzip level, no timestamps in the gzip header. */
export function serializeShard(byCard, asOf) {
	const obj = { _: { v: SHARD_FORMAT_VERSION, asOf } };
	for (const sid of [...byCard.keys()].sort()) {
		const series = byCard.get(sid);
		const sorted = {};
		for (const key of Object.keys(series).sort()) sorted[key] = series[key];
		obj[sid] = sorted;
	}
	const raw = Buffer.from(JSON.stringify(obj), "utf8");
	return { raw: raw.length, gz: gzipSync(raw, { level: 9 }) };
}

/** Writes every shard + meta.json. Returns the size figures. */
export function writeShards(dir, shards, meta) {
	mkdirSync(join(dir, "s"), { recursive: true });
	const gzSizes = [];
	let rawTotal = 0;
	let gzTotal = 0;
	for (const name of [...shards.keys()].sort()) {
		const { raw, gz } = serializeShard(shards.get(name), meta.asOf);
		writeFileSync(join(dir, "s", `${name}.json.gz`), gz);
		gzSizes.push(gz.length);
		rawTotal += raw;
		gzTotal += gz.length;
	}
	gzSizes.sort((a, b) => a - b);
	const pick = (q) => gzSizes[Math.min(gzSizes.length - 1, Math.floor(q * gzSizes.length))];
	const sizes = {
		files: gzSizes.length,
		rawBytes: rawTotal,
		gzBytes: gzTotal,
		gzMin: gzSizes[0],
		gzMedian: pick(0.5),
		gzP95: pick(0.95),
		gzMax: gzSizes[gzSizes.length - 1],
	};
	writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, sizes }, null, 1));
	return sizes;
}

/** As-of day and counts of a set, read from its records. */
export function summarize(shards) {
	let cards = 0;
	let series = 0;
	let changes = 0;
	let holes = 0;
	let firstDay = Infinity;
	let asOfDay = -Infinity;
	for (const byCard of shards.values()) {
		for (const recs of byCard.values()) {
			cards++;
			for (const rec of Object.values(recs)) {
				series++;
				if (rec[0] < firstDay) firstDay = rec[0];
				if (rec[1] > asOfDay) asOfDay = rec[1];
				for (let i = 2; i < rec.length; i++) {
					changes++;
					if (rec[i][1] === null) holes++;
				}
			}
		}
	}
	return { cards, series, changes, holes, firstDay: dateOf(firstDay), asOf: dateOf(asOfDay) };
}
