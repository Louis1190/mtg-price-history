#!/usr/bin/env node
// The daily job of the price-history data repository (the repository's workflow calls this script; it also runs
// by hand). It only ORCHESTRATES the pieces proven in this folder (build.mjs, verify.mjs, lib/): downloads what
// it needs from MTGJSON, appends one day (or rebuilds from MTGJSON's 90-day file the first time), and REFUSES to
// produce anything when a sanity gate fails, so a bad day can never replace good data.
//
//   node daily.mjs --out <dir> --work <dir> [--state <dir>] [--bootstrap] [--source <dir>] [--report <file>]
//
//   --state      the previous run's output (meta.json, s/, idmap.json). Absent, or --bootstrap: rebuild from AllPrices.
//   --out        where the new state goes (meta.json, s/, idmap.json); the site is s/ + meta.json of it.
//   --work       scratch space (downloads, intermediate files).
//   --source     use AllPrices.json.gz / AllPricesToday.json.gz / AllIdentifiers.json.gz / Meta.json from this folder
//                instead of downloading (a rehearsal on files already on disk).
//   --report     JSON of what happened. With $GITHUB_OUTPUT set, also writes `skipped=`, `asof=` and `mode=` for the workflow.
//
// MTGJSON is a free, volunteer-run service: this job asks for Meta.json (a few bytes) first and stops there when
// there is nothing newer, takes AllPricesToday (5 MB) otherwise, and downloads AllIdentifiers (230 MB) only when
// today's file holds a card the saved id map doesn't know. AllPrices (150 MB) is only for the first run.

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readEntries } from "./lib/json-entries.mjs";
import { readMetaFile } from "./lib/shards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MTGJSON = "https://mtgjson.com/api/v5/";
const USER_AGENT = "mtg-price-history/1.0 (+https://github.com/Louis1190/mtg-price-history)";
const NODE = [process.execPath, "--max-old-space-size=6144"];

// Gates. A healthy day only ever ADDS: no file and no series disappears, and nearly every series is live on the
// newest day. The live ratio of the first real set was 0.9 (vendors that stopped listing a card account for the rest).
const MIN_FILES_BOOTSTRAP = 4000;
const MIN_SERIES_BOOTSTRAP = 500000;
const MIN_LIVE_RATIO = 0.75;
const MAX_LIVE_DROP = 0.05;
const MAX_UNMAPPED_RATIO = 0.005;

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
if (!args.out || !args.work) {
	console.error("usage: node daily.mjs --out <dir> --work <dir> [--state <dir>] [--bootstrap] [--source <dir>] [--report <file>]");
	process.exit(2);
}
const t0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
mkdirSync(args.work, { recursive: true });
mkdirSync(args.out, { recursive: true });

async function download(name, dest) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(MTGJSON + name, { headers: { "User-Agent": USER_AGENT } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
			// Content-Length counts the bytes ON THE WIRE: when the server compressed the answer (MTGJSON does for Meta.json)
			// fetch has already decompressed it, so the sizes only compare for an answer sent as is (the .gz files).
			const expected = Number(res.headers.get("content-length") ?? 0);
			if (expected && !res.headers.get("content-encoding") && statSync(dest).size !== expected) throw new Error(`got ${statSync(dest).size} bytes of ${expected}`);
			return dest;
		} catch (e) {
			log(`downloading ${name}: attempt ${attempt} failed: ${e.message}`);
			if (attempt === 3) throw e;
			await new Promise((r) => setTimeout(r, attempt * 5000));
		}
	}
}

/** A file of MTGJSON: from --source when given, downloaded once into --work otherwise. */
async function file(name) {
	if (args.source) return join(args.source, name);
	const dest = join(args.work, name);
	if (!existsSync(dest)) {
		log(`downloading ${name}`);
		await download(name, dest);
	}
	return dest;
}

function run(script, scriptArgs) {
	return execFileSync(NODE[0], [NODE[1], join(HERE, script), ...scriptArgs], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "inherit"] });
}

function setOutput(key, value) {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function finish(report, code = 0) {
	report.seconds = Math.round((Date.now() - t0) / 1000);
	if (args.report) writeFileSync(args.report, JSON.stringify(report, null, 1));
	setOutput("skipped", String(!!report.skipped));
	if (report.asOf) setOutput("asof", report.asOf);
	setOutput("mode", report.mode);
	console.log(JSON.stringify(report, null, 1));
	process.exit(code);
}

function fail(report, message) {
	report.error = message;
	log(`REFUSED: ${message}`);
	finish(report, 1);
}

/** Every shard file parses and carries the header of the format we publish, for THIS day. */
function checkShardFiles(dir, asOf) {
	let files = 0;
	let series = 0;
	let live = 0;
	for (const name of readdirSync(join(dir, "s"))) {
		if (!name.endsWith(".json.gz")) return { error: `unexpected file s/${name}` };
		let obj;
		try {
			obj = JSON.parse(gunzipSync(readFileSync(join(dir, "s", name))).toString("utf8"));
		} catch {
			return { error: `s/${name} does not parse` };
		}
		if (obj._?.v !== 1 || obj._?.asOf !== asOf) return { error: `s/${name} has header ${JSON.stringify(obj._)}, expected v=1 asOf=${asOf}` };
		files++;
		const day = Math.floor(Date.parse(`${asOf}T00:00:00Z`) / 86400000);
		for (const [sid, recs] of Object.entries(obj)) {
			if (sid === "_") continue;
			for (const rec of Object.values(recs)) {
				series++;
				if (rec[1] === day) live++;
			}
		}
	}
	return { files, series, live, liveRatio: series ? live / series : 0 };
}

const bootstrap = !!args.bootstrap || !args.state || !existsSync(join(String(args.state), "meta.json"));
const report = { mode: bootstrap ? "bootstrap" : "update", skipped: false };

// 1. What day is MTGJSON on?
const metaPath = args.source ? join(args.source, "Meta.json") : await download("Meta.json", join(args.work, "Meta.json"));
const mtgjson = JSON.parse(readFileSync(metaPath, "utf8")).meta;
report.mtgjson = mtgjson;
log(`MTGJSON is at ${mtgjson.version} (${mtgjson.date}); mode ${report.mode}`);

let prev = null;
if (!bootstrap) {
	prev = readMetaFile(args.state);
	report.previousAsOf = prev.asOf;
	if (mtgjson.date <= prev.asOf) {
		report.skipped = true;
		report.asOf = prev.asOf;
		report.note = `nothing newer than ${prev.asOf}`;
		log(report.note);
		finish(report);
	}
}

// 2. Build.
const idmapPath = join(args.work, "idmap.json");
if (bootstrap) {
	run("build.mjs", ["idmap", "--identifiers", await file("AllIdentifiers.json.gz"), "--out", idmapPath]);
	const prices = await file("AllPrices.json.gz");
	run("build.mjs", ["build", "--prices", prices, "--idmap", idmapPath, "--out", args.out]);
	log("verifying every series against the source");
	try {
		run("verify.mjs", ["source", "--prices", prices, "--idmap", idmapPath, "--shards", args.out]);
	} catch {
		fail(report, "the shard files do not reproduce the source (verify.mjs source failed)");
	}
} else {
	const saved = join(args.state, "idmap.json");
	if (existsSync(saved)) copyFileSync(saved, idmapPath);
	const todayFile = await file("AllPricesToday.json.gz");
	// Does today's file hold a card the saved id map does not know? Then (and only then) refresh the id map.
	const countUnmapped = async () => {
		const idmap = existsSync(idmapPath) ? JSON.parse(readFileSync(idmapPath, "utf8")) : {};
		let unmapped = 0;
		let total = 0;
		for await (const { key } of readEntries(todayFile)) {
			total++;
			if (!idmap[key]) unmapped++;
		}
		return { unmapped, total };
	};
	let { unmapped, total } = await countUnmapped();
	if (unmapped > 0) {
		log(`${unmapped} of ${total} cards unknown to the saved id map: refreshing it from AllIdentifiers`);
		run("build.mjs", ["idmap", "--identifiers", await file("AllIdentifiers.json.gz"), "--out", idmapPath]);
		({ unmapped, total } = await countUnmapped());
	}
	report.unmapped = { unmapped, total };
	if (unmapped / Math.max(total, 1) > MAX_UNMAPPED_RATIO) fail(report, `${unmapped} of ${total} cards have no Scryfall id even after refreshing the id map`);
	run("build.mjs", ["update", "--prev", args.state, "--today", todayFile, "--idmap", idmapPath, "--out", args.out]);
}
copyFileSync(idmapPath, join(args.out, "idmap.json"));

// 3. Gates.
const out = readMetaFile(args.out);
report.asOf = out.asOf;
report.counts = out.counts;
report.sizes = out.sizes;
if (out.asOf !== mtgjson.date) fail(report, `the new set is as of ${out.asOf} but MTGJSON says ${mtgjson.date}`);
const files = checkShardFiles(args.out, out.asOf);
if (files.error) fail(report, files.error);
report.liveRatio = Number(files.liveRatio.toFixed(4));
if (bootstrap) {
	if (files.files < MIN_FILES_BOOTSTRAP) fail(report, `only ${files.files} shard files (expected at least ${MIN_FILES_BOOTSTRAP})`);
	if (files.series < MIN_SERIES_BOOTSTRAP) fail(report, `only ${files.series} series (expected at least ${MIN_SERIES_BOOTSTRAP})`);
} else {
	if (files.files < prev.sizes.files) fail(report, `${files.files} shard files, down from ${prev.sizes.files}`);
	if (files.series < prev.counts.series) fail(report, `${files.series} series, down from ${prev.counts.series}`);
}
if (files.liveRatio < MIN_LIVE_RATIO) fail(report, `only ${(files.liveRatio * 100).toFixed(1)}% of the series have a price on ${out.asOf}`);
if (!bootstrap && prev.counts.liveRatio !== undefined && files.liveRatio < prev.counts.liveRatio - MAX_LIVE_DROP) {
	fail(report, `live ratio fell from ${prev.counts.liveRatio} to ${report.liveRatio}`);
}
// The next run compares against this one.
writeFileSync(join(args.out, "meta.json"), JSON.stringify({ ...out, counts: { ...out.counts, liveRatio: report.liveRatio } }, null, 1));
log(`done: as of ${out.asOf}, ${files.files} files, ${files.series} series, ${(files.liveRatio * 100).toFixed(1)}% live`);
finish(report);
