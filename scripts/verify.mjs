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
//   node verify.mjs resync --prev <dir> --fresh <dir> --merged <dir>
//       is <merged> what a resync must give? Written independently of lib/resync.mjs: inside the window of <fresh>
//       every day of <merged> equals <fresh>'s (both directions), before the window it equals <prev>'s, no series
//       appears from nowhere, no file is misplaced. Streams shard by shard.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEntries } from "./lib/json-entries.mjs";
import { multiUuidSids, seriesOfEntry, shardOf, unionPoints } from "./lib/model.mjs";
import { dayOf, decodeSeries, diffPoints } from "./lib/series-codec.mjs";
import { gunzipSync } from "node:zlib";
import { readMetaFile, readShards } from "./lib/shards.mjs";

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
	// Same decoded content AND same bytes? Bytes can differ with equal content when the two sets were compressed by
	// different zlib builds (another machine): the series comparison above is what counts.
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
} else if (mode === "resync") {
	const windowStart = dayOf(readMetaFile(args.fresh).firstDay);
	const names = new Set();
	for (const d of [args.prev, args.fresh, args.merged]) for (const f of readdirSync(join(d, "s"))) names.add(f);
	const load = (dir, name) => (existsSync(join(dir, "s", name)) ? JSON.parse(gunzipSync(readFileSync(join(dir, "s", name))).toString("utf8")) : { _: null });
	const mergedMeta = readMetaFile(args.merged);
	let series = 0;
	let windowWrong = 0;
	let olderWrong = 0;
	let fromNowhere = 0;
	let lostOlder = 0;
	let misplaced = 0;
	let badHeader = 0;
	let olderKept = 0;
	const examples = [];
	const note = (msg) => examples.length < 6 && examples.push(msg);
	for (const name of [...names].sort()) {
		const prev = load(args.prev, name);
		const fresh = load(args.fresh, name);
		const merged = load(args.merged, name);
		if (merged._ && merged._.asOf !== mergedMeta.asOf) badHeader++;
		for (const sid of Object.keys(merged)) if (sid !== "_" && shardOf(sid) !== name.slice(0, -".json.gz".length)) misplaced++;
		const sids = new Set([...Object.keys(prev), ...Object.keys(fresh), ...Object.keys(merged)]);
		sids.delete("_");
		for (const sid of sids) {
			const keys = new Set([...Object.keys(prev[sid] ?? {}), ...Object.keys(fresh[sid] ?? {}), ...Object.keys(merged[sid] ?? {})]);
			for (const key of keys) {
				const id = `${sid} ${key}`;
				const p = prev[sid]?.[key] ? decodeSeries(prev[sid][key]) : [];
				const f = fresh[sid]?.[key] ? decodeSeries(fresh[sid][key]) : [];
				const m = merged[sid]?.[key] ? decodeSeries(merged[sid][key]) : [];
				if (m.length) series++;
				if (m.length && !p.length && !f.length) {
					fromNowhere++;
					note(`from nowhere: ${id}`);
				}
				const mWindow = m.filter(([d]) => d >= windowStart);
				const mOlder = m.filter(([d]) => d < windowStart);
				const pOlder = p.filter(([d]) => d < windowStart);
				olderKept += pOlder.length;
				const dw = diffPoints(mWindow, f);
				if (dw !== null) {
					windowWrong++;
					note(`window ${id}: ${dw}`);
				}
				const dold = diffPoints(mOlder, pOlder);
				if (dold !== null) {
					olderWrong++;
					if (mOlder.length < pOlder.length) lostOlder++;
					note(`older ${id}: ${dold}`);
				}
			}
		}
	}
	const ok = windowWrong === 0 && olderWrong === 0 && fromNowhere === 0 && misplaced === 0 && badHeader === 0;
	report({ ok, windowStart: readMetaFile(args.fresh).firstDay, series, olderPointsChecked: olderKept, windowDifferentFromFresh: windowWrong, olderDifferentFromPrev: olderWrong, olderHistoryLost: lostOlder, seriesFromNowhere: fromNowhere, misplaced, badHeader, examples });
	process.exit(ok ? 0 : 1);
} else {
	console.error("usage: node verify.mjs source|compare|sources|resync (see the header of this file)");
	process.exit(2);
}
