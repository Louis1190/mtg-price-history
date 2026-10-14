// Prototype of "option A": turns MTGJSON's price files into the shard set the plugin would download.
// See README.md. Three modes:
//
//   node build.mjs idmap  --identifiers AllIdentifiers.json.gz --out <idmap.json>
//       uuid -> [scryfallId, cardmarketId, name, set, number] (one-off, ~2 min, the file is 230 MB)
//   node build.mjs build  --prices AllPrices.json.gz --idmap <idmap.json> --out <dir> [--until YYYY-MM-DD]
//       the whole 90-day history -> <dir>/s/*.json.gz + <dir>/meta.json
//   node build.mjs update --prev <dir> --today AllPricesToday.json.gz --idmap <idmap.json> --out <dir>
//       append one day to an existing set (what the daily job would do)
//
// Run with `node --max-old-space-size=8192`: the whole set lives in memory while it is built.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readEntries, readMeta } from "./lib/json-entries.mjs";
import { multiUuidSids, seriesOfEntry, shardOf, unionPoints } from "./lib/model.mjs";
import { appendPoint, dayOf, decodeSeries, diffPoints, encodeSeries } from "./lib/series-codec.mjs";
import { readMetaFile, readShards, summarize, writeShards } from "./lib/shards.mjs";

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
		else args._.push(argv[i]);
	}
	return args;
}

// Deliberately broken encoders, to prove verify.mjs notices (see README, "Proving the checks can fail").
const MUTANTS = {
	"drop-last-change": (p) => {
		const r = encodeSeries(p);
		if (r.length > 3) r.pop();
		return r;
	},
	"shift-start": (p) => {
		const r = encodeSeries(p);
		r[0] += 1;
		return r;
	},
};

const args = parseArgs(process.argv.slice(2));
const mode = args._[0];
const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

if (mode === "idmap") {
	const out = {};
	let n = 0;
	let noScryfall = 0;
	for await (const { key, value } of readEntries(args.identifiers)) {
		const id = value.identifiers ?? {};
		if (!id.scryfallId) {
			noScryfall++;
			continue;
		}
		out[key] = [id.scryfallId, id.mcmId ?? null, value.name ?? "", value.setCode ?? "", value.number ?? ""];
		if (++n % 20000 === 0) log(`${n} cards read`);
	}
	mkdirSync(dirname(args.out), { recursive: true });
	writeFileSync(args.out, JSON.stringify(out));
	log(`idmap: ${n} uuids with a Scryfall id, ${noScryfall} without -> ${args.out}`);
} else if (mode === "build") {
	const idmap = JSON.parse(readFileSync(args.idmap, "utf8"));
	const meta = await readMeta(args.prices);
	const untilDay = args.until ? dayOf(args.until) : Infinity;
	const encode = args.mutate ? MUTANTS[args.mutate] : encodeSeries;
	if (args.mutate && !encode) throw new Error(`unknown mutant ${args.mutate}`);
	log(`MTGJSON ${meta.version} (${meta.date}), ${Object.keys(idmap).length} ids known${args.until ? `, days after ${args.until} ignored` : ""}${args.mutate ? `, MUTANT ${args.mutate}` : ""}`);

	const multi = multiUuidSids(idmap);
	const shards = new Map();
	const st = { uuids: 0, unmapped: 0, noPaperPrice: 0, sourceSeries: 0, mergedSeries: 0, points: 0, nonCent: 0, badCurrency: 0, inlineMismatch: 0 };
	const unmappedSample = [];
	const pending = new Map(); // sid -> Map<seriesKey, [{uuid, points}]>: printings known under several uuids

	const store = (sid, key, points) => {
		const rec = encode(points);
		// The first of the checks: what we just encoded decodes back to what we read.
		if (diffPoints(decodeSeries(rec), points) !== null) st.inlineMismatch++;
		const name = shardOf(sid);
		let byCard = shards.get(name);
		if (!byCard) shards.set(name, (byCard = new Map()));
		let recs = byCard.get(sid);
		if (!recs) byCard.set(sid, (recs = {}));
		recs[key] = rec;
	};

	for await (const { key: uuid, value } of readEntries(args.prices)) {
		st.uuids++;
		const ids = idmap[uuid];
		if (!ids) {
			st.unmapped++;
			if (unmappedSample.length < 5) unmappedSample.push(uuid);
			continue;
		}
		const sid = ids[0];
		const series = seriesOfEntry(value, untilDay, st);
		if (series.length === 0) {
			st.noPaperPrice++;
			continue;
		}
		for (const { key, points } of series) {
			st.sourceSeries++;
			st.points += points.length;
			if (multi.has(sid)) {
				let byKey = pending.get(sid);
				if (!byKey) pending.set(sid, (byKey = new Map()));
				let list = byKey.get(key);
				if (!list) byKey.set(key, (list = []));
				list.push({ uuid, points });
			} else {
				store(sid, key, points);
			}
		}
		if (st.uuids % 20000 === 0) log(`${st.uuids} MTGJSON entries`);
	}
	for (const [sid, byKey] of pending) {
		for (const [key, candidates] of byKey) {
			if (candidates.length > 1) st.mergedSeries++;
			store(sid, key, unionPoints(candidates));
		}
	}
	const multiUuidSidCount = multi.size;
	log(`read ${st.uuids} entries, writing ${shards.size} shards`);
	const summary = summarize(shards);
	mkdirSync(args.out, { recursive: true });
	const sizes = writeShards(args.out, shards, {
		format: 1,
		mtgjson: meta,
		asOf: summary.asOf,
		firstDay: summary.firstDay,
		builtAt: new Date().toISOString(),
		mutant: args.mutate ?? null,
		counts: { ...st, multiUuidSids: multiUuidSidCount, ...summary },
	});
	log("done");
	console.log(JSON.stringify({ stats: { ...st, multiUuidSids: multiUuidSidCount }, summary, sizes, unmappedSample, seconds: (Date.now() - t0) / 1000 }, null, 1));
} else if (mode === "update") {
	const idmap = JSON.parse(readFileSync(args.idmap, "utf8"));
	const meta = await readMeta(args.today);
	const prevMeta = readMetaFile(args.prev);
	log(`previous set: as of ${prevMeta.asOf}; today file: ${meta.date}`);
	const shards = readShards(args.prev);
	const st = { uuids: 0, unmapped: 0, appended: 0, created: 0, alreadyThere: 0, nonCent: 0, badCurrency: 0 };
	// Group today's series by printing first: a double-faced card arrives under two uuids, and the
	// day must be applied once, from their union (same rule as the build).
	const today = new Map(); // sid -> Map<seriesKey, [{uuid, points}]>
	for await (const { key: uuid, value } of readEntries(args.today)) {
		st.uuids++;
		const ids = idmap[uuid];
		if (!ids) {
			st.unmapped++;
			continue;
		}
		let byKey = today.get(ids[0]);
		if (!byKey) today.set(ids[0], (byKey = new Map()));
		for (const { key, points } of seriesOfEntry(value, Infinity, st)) {
			let list = byKey.get(key);
			if (!list) byKey.set(key, (list = []));
			list.push({ uuid, points });
		}
	}
	for (const [sid, byKey] of today) {
		const name = shardOf(sid);
		let byCard = shards.get(name);
		if (!byCard) shards.set(name, (byCard = new Map()));
		let recs = byCard.get(sid);
		if (!recs) byCard.set(sid, (recs = {}));
		for (const [key, candidates] of byKey) {
			for (const [day, cents] of unionPoints(candidates)) {
				const before = recs[key];
				const endBefore = before?.[1];
				recs[key] = appendPoint(before, day, cents);
				if (before === undefined) st.created++;
				else if (day <= endBefore) st.alreadyThere++;
				else st.appended++;
			}
		}
	}
	const summary = summarize(shards);
	mkdirSync(args.out, { recursive: true });
	const sizes = writeShards(args.out, shards, {
		format: 1,
		mtgjson: meta,
		asOf: summary.asOf,
		firstDay: summary.firstDay,
		builtAt: new Date().toISOString(),
		updatedFrom: prevMeta.asOf,
		counts: { ...st, ...summary },
	});
	log("done");
	console.log(JSON.stringify({ stats: st, summary, sizes, seconds: (Date.now() - t0) / 1000 }, null, 1));
} else {
	console.error("usage: node build.mjs idmap|build|update (see the header of this file)");
	process.exit(2);
}
