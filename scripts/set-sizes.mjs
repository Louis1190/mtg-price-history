#!/usr/bin/env node
// Writes sets.json, the size of every paper set (lib/set-sizes.mjs says what it holds and why), then checks what it wrote.
//
//   node set-sizes.mjs --out <dir> --work <dir> [--source <dir>] [--report <file>]
//
//   --source   read SetList.json.xz / SetList.json.gz / SetList.json from this folder instead of downloading it (a rehearsal on a file on disk).
//
// The download is checked against the SHA-256 MTGJSON publishes next to the file (lib/download.mjs). The `.xz` when the `xz` program exists
// (under 2 MB), the `.gz` otherwise or if the `.xz` cannot be used. The script reads its output back and exits 1 unless it is exactly what the
// source gives and passes the gates. The daily workflow runs this step apart from the prices and tolerates its failure: without the file a reader
// keeps the one it read last, and a bug here must never hold back the day's prices.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { downloadVerified } from "./lib/download.mjs";
import { buildSetSizes, checkSetSizes } from "./lib/set-sizes.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.out || !args.work) {
	console.error("usage: node set-sizes.mjs --out <dir> --work <dir> [--source <dir>] [--report <file>]");
	process.exit(2);
}
const MTGJSON = "https://mtgjson.com/api/v5/";
const USER_AGENT = "mtg-price-history/1.0 (+https://github.com/Louis1190/mtg-price-history)";
const HAVE_XZ = spawnSync("xz", ["--version"], { stdio: "ignore" }).status === 0;
const log = (text) => console.error(text);
mkdirSync(args.work, { recursive: true });
mkdirSync(args.out, { recursive: true });

function readJson(path) {
	if (path.endsWith(".xz")) {
		const res = spawnSync("xz", ["-dc", path], { maxBuffer: 1 << 28 });
		if (res.status !== 0) throw new Error("xz could not read the file");
		return JSON.parse(res.stdout.toString("utf8"));
	}
	const bytes = readFileSync(path);
	return JSON.parse((path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

let checksum = "not downloaded";
async function setList() {
	const names = [...(HAVE_XZ ? ["SetList.json.xz"] : []), "SetList.json.gz"];
	if (args.source) {
		const found = [...names, "SetList.json"].map((n) => join(args.source, n)).find((p) => existsSync(p));
		if (!found) throw new Error(`no SetList file in ${args.source}`);
		return readJson(found);
	}
	let last;
	for (const name of names) {
		try {
			const dest = join(args.work, name);
			checksum = (await downloadVerified(MTGJSON + name, dest, { userAgent: USER_AGENT, log })).checksum;
			return readJson(dest);
		} catch (e) {
			last = e;
			log(`${name} unusable: ${e.message}`);
		}
	}
	throw last;
}

let result;
try {
	const source = await setList();
	const { file, skipped } = buildSetSizes(source);
	const target = join(args.out, "sets.json");
	writeFileSync(target, JSON.stringify(file));

	// The check, on what was written.
	const written = JSON.parse(readFileSync(target, "utf8"));
	const problems = checkSetSizes(written);
	if (JSON.stringify(written) !== JSON.stringify(buildSetSizes(source).file)) problems.push("the file is not what the source gives");
	for (const set of source.data) {
		if (set.isOnlineOnly) continue;
		const entry = written.sets?.[String(set.code).toLowerCase()];
		if (entry && (entry[0] !== set.baseSetSize || entry[1] !== set.totalSetSize || entry[2] !== set.type)) {
			problems.push(`${set.code}: the file says ${JSON.stringify(entry)}, the source ${set.baseSetSize}, ${set.totalSetSize}, ${set.type}`);
			break;
		}
	}
	result = { ok: problems.length === 0, asOf: file.asOf, sets: Object.keys(file.sets).length, skipped, bytes: JSON.stringify(file).length, checksum, problems };
} catch (e) {
	result = { ok: false, checksum, problems: [e.message] };
}
if (args.report) writeFileSync(args.report, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
