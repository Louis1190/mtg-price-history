// Independent checks of a shard set. See README.md.
//
//   node verify.mjs source  --prices AllPrices.json.gz --idmap idmap.json --shards <dir> [--until YYYY-MM-DD]
//       streams the SOURCE again and checks every series against what the shard FILES decode to
//       (both directions: nothing missing, nothing extra). Exit code 1 on any difference.
//   node verify.mjs compare --a <dir> --b <dir>
//       are two sets the same, series by series (and, separately, byte for byte)?
//   node verify.mjs sources --prices AllPrices.json.gz --today AllPricesToday.json.gz
//       on the newest day, how many series do MTGJSON's own two files disagree on? (the daily update
//       can only reproduce what the two files say, so this is the count of differences it MAY show)

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEntries } from "./lib/json-entries.mjs";
import { multiUuidSids, seriesOfEntry, shardOf, unionPoints } from "./lib/model.mjs";
import { dayOf, decodeSeries, diffPoints } from "./lib/series-codec.mjs";
import { readShards } from "./lib/shards.mjs";

const args = {};
const mode = process.argv[2];
for (let i = 3; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
const t0 = Date.now();
const report = (obj) => console.log(JSON.stringify({ ...obj, seconds: (Date.now() - t0) / 1000 }, null, 1));

if (mode === "source") {
	const idmap = JSON.parse(readFileSync(args.idmap, "utf8"));
	const multi = multiUuidSids(idmap);
	const untilDay = args.until ? dayOf(args.until) : Infinity;
	const shards = readShards(args.shards);
	const stored = new Map(); // "sid|key" -> record
	let misplaced = 0;
	for (const [name, byCard] of shards) {
		for (const [sid, recs] of byCard) {
			if (shardOf(sid) !== name) misplaced++;
			for (const [key, rec] of Object.entries(recs)) stored.set(`${sid}|${key}`, rec);
		}
	}

	const seen = new Set();
	let sourceSeries = 0;
	let missing = 0;
	let wrong = 0;
	const examples = [];
	const check = (sid, key, points) => {
		const id = `${sid}|${key}`;
		seen.add(id);
		const rec = stored.get(id);
		if (!rec) {
			missing++;
			if (examples.length < 5) examples.push(`missing ${id}`);
			return;
		}
		const diff = diffPoints(decodeSeries(rec), points);
		if (diff !== null) {
			wrong++;
			if (examples.length < 5) examples.push(`wrong ${id}: ${diff}`);
		}
	};
	const pending = new Map(); // "sid|key" -> candidates, for printings that have several uuids
	for await (const { key: uuid, value } of readEntries(args.prices)) {
		const ids = idmap[uuid];
		if (!ids) continue;
		const sid = ids[0];
		for (const { key, points } of seriesOfEntry(value, untilDay)) {
			sourceSeries++;
			if (!multi.has(sid)) {
				check(sid, key, points);
				continue;
			}
			const id = `${sid}|${key}`;
			if (!pending.has(id)) pending.set(id, []);
			pending.get(id).push({ uuid, points });
		}
	}
	for (const [id, candidates] of pending) {
		const [sid, key] = id.split("|");
		check(sid, key, unionPoints(candidates));
	}
	// Anything stored that the source never produced.
	let extra = 0;
	for (const id of stored.keys()) {
		if (!seen.has(id)) {
			extra++;
			if (examples.length < 5) examples.push(`extra ${id}`);
		}
	}
	const ok = missing === 0 && wrong === 0 && extra === 0 && misplaced === 0;
	report({ ok, sourceSeries, storedSeries: stored.size, missingFromShards: missing, differentFromSource: wrong, notInSource: extra, misplaced, examples });
	process.exit(ok ? 0 : 1);
} else if (mode === "compare") {
	const a = readShards(args.a);
	const b = readShards(args.b);
	let seriesA = 0;
	let seriesB = 0;
	let different = 0;
	let onlyA = 0;
	let onlyB = 0;
	const examples = [];
	for (const [name, byCardA] of a) {
		const byCardB = b.get(name);
		for (const [sid, recsA] of byCardA) {
			const recsB = byCardB?.get(sid);
			for (const [key, recA] of Object.entries(recsA)) {
				seriesA++;
				const recB = recsB?.[key];
				if (!recB) {
					onlyA++;
					if (examples.length < 5) examples.push(`only in A: ${sid} ${key}`);
					continue;
				}
				const diff = diffPoints(decodeSeries(recA), decodeSeries(recB));
				if (diff !== null) {
					different++;
					if (examples.length < 5) examples.push(`${sid} ${key}: ${diff}`);
				}
			}
		}
	}
	for (const [name, byCardB] of b) for (const [sid, recsB] of byCardB) for (const key of Object.keys(recsB)) {
		seriesB++;
		if (!a.get(name)?.get(sid)?.[key]) {
			onlyB++;
			if (examples.length < 5) examples.push(`only in B: ${sid} ${key}`);
		}
	}
	// Same decoded content AND same bytes? (bytes differing with equal content would only mean a different encoding)
	let identicalFiles = 0;
	let differentFiles = 0;
	const filesA = readdirSync(join(args.a, "s"));
	for (const f of filesA) {
		try {
			if (readFileSync(join(args.a, "s", f)).equals(readFileSync(join(args.b, "s", f)))) identicalFiles++;
			else differentFiles++;
		} catch {
			differentFiles++;
		}
	}
	const ok = different === 0 && onlyA === 0 && onlyB === 0;
	report({ ok, seriesA, seriesB, different, onlyA, onlyB, filesIdenticalByteForByte: identicalFiles, filesDifferent: differentFiles, examples });
	process.exit(ok ? 0 : 1);
} else if (mode === "sources") {
	const todayLast = new Map();
	let todayDay = 0;
	for await (const { key, value } of readEntries(args.today)) {
		for (const s of seriesOfEntry(value)) {
			const last = s.points[s.points.length - 1];
			todayLast.set(`${key}|${s.key}`, last);
			if (last[0] > todayDay) todayDay = last[0];
		}
	}
	const byVendor = {};
	let disagree = 0;
	let compared = 0;
	for await (const { key, value } of readEntries(args.prices)) {
		for (const s of seriesOfEntry(value)) {
			const t = todayLast.get(`${key}|${s.key}`);
			const last = s.points[s.points.length - 1];
			if (!t || last[0] !== t[0]) continue;
			compared++;
			const vendor = s.key.split(".")[0];
			byVendor[vendor] ??= { same: 0, differ: 0 };
			if (last[1] === t[1]) byVendor[vendor].same++;
			else {
				byVendor[vendor].differ++;
				disagree++;
			}
		}
	}
	report({ day: todayDay, compared, disagree, byVendor });
} else {
	console.error("usage: node verify.mjs source|compare|sources (see the header of this file)");
	process.exit(2);
}
