#!/usr/bin/env node
// Weekly snapshot of the state into the `backups` release of this repository (the policy is lib/backup-policy.mjs).
//
//   node backup.mjs --dir <the set to save: meta.json, s/, idmap.json> --work <scratch dir>
//
// Needs the GitHub CLI and GH_TOKEN (the workflow has both). Fails loudly (exit 1) if the snapshot cannot be uploaded or the uploaded
// file is not the size of the local one: a backup nobody checks is the kind that is empty the day it is needed.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { planBackup } from "./lib/backup-policy.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.dir || !args.work) {
	console.error("usage: node backup.mjs --dir <set> --work <scratch dir>");
	process.exit(2);
}
const RELEASE = "backups";
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const log = (...a) => console.error("backup:", ...a);

const asOf = JSON.parse(readFileSync(join(args.dir, "meta.json"), "utf8")).asOf;
try {
	gh("release", "view", RELEASE);
} catch {
	gh("release", "create", RELEASE, "--title", "backups", "--latest=false", "--notes", "Weekly snapshots of the state of the daily job (the last eight). Not meant to be downloaded except to restore: see the README.");
	log("created the release");
}
const listAssets = () => JSON.parse(gh("release", "view", RELEASE, "--json", "assets")).assets;
const plan = planBackup({ assets: listAssets().map((a) => a.name), asOf });
if (!plan.take) {
	log(`nothing to do for ${asOf} (the newest snapshot is less than a week old)`);
	console.log(JSON.stringify({ took: false, asOf }));
	process.exit(0);
}
mkdirSync(args.work, { recursive: true });
const file = join(args.work, plan.name);
execFileSync("tar", ["-cf", file, "-C", args.dir, "."], { stdio: "inherit" });
const size = statSync(file).size;
gh("release", "upload", RELEASE, file, "--clobber");
const uploaded = listAssets().find((a) => a.name === plan.name);
if (!uploaded || uploaded.size !== size) {
	console.error(`the snapshot did not upload intact: ${uploaded ? `${uploaded.size} bytes there, ${size} here` : "not in the release"}`);
	process.exit(1);
}
for (const name of plan.prune) {
	gh("release", "delete-asset", RELEASE, name, "--yes");
	log(`dropped ${name}`);
}
log(`saved ${plan.name} (${(size / 1048576).toFixed(1)} MB)`);
console.log(JSON.stringify({ took: true, asOf, name: plan.name, size, dropped: plan.prune }));
