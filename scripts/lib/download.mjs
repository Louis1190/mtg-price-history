// Downloads ONE file of MTGJSON and checks it against the SHA-256 that MTGJSON publishes next to every file
// (`<file>.sha256`, 64 hex characters: see its FAQ). A corrupt or half-updated download must never reach the build.
//
// What the checksum covers: the BYTES WE WROTE. For the `.gz` files that is the file as served; for `Meta.json`,
// which the server compresses in transit, it is the decompressed content `fetch` hands over, and MTGJSON's
// `Meta.json.sha256` is the hash of exactly that (measured 2026-10-14, like `AllPricesToday.json.sha256` for the
// decompressed JSON): one rule for every file.
//
// A mismatch is retried like any other failure: right when a new build goes live, the file and its checksum can be
// served from two different builds for a few seconds, and the next attempt then agrees. After the last attempt the
// error is thrown, so the run fails (GitHub sends its e-mail) and nothing is published.
// A checksum file that does not exist (404) is NOT an error: it is the one thing that cannot be verified, the later
// gates (the file must unzip and parse, counts must not fall) still apply, and the caller reports it.

import { createHash } from "node:crypto";
import { createWriteStream, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** The hex digest inside a `.sha256` file's text (the first 64 hex characters), or null if there is none. */
export function parseChecksumFile(text) {
	const m = /^\s*([0-9a-fA-F]{64})(?![0-9a-fA-F])/.exec(text);
	return m ? m[1].toLowerCase() : null;
}

/**
 * Fetches `url` into `dest`. Resolves with { dest, lastModified, checksum } where checksum is "verified" or "missing"
 * (the server has no `.sha256` for it); rejects when every attempt failed or disagreed with the published checksum.
 * `dest` never holds a failed download: it is removed after each failed attempt.
 */
export async function downloadVerified(url, dest, { userAgent, attempts = 3, retryDelayMs = 5000, log = () => {} } = {}) {
	const headers = userAgent ? { "User-Agent": userAgent } : {};
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetch(url, { headers });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const hash = createHash("sha256");
			await pipeline(
				Readable.fromWeb(res.body),
				async function* (source) {
					for await (const chunk of source) {
						hash.update(chunk);
						yield chunk;
					}
				},
				createWriteStream(dest),
			);
			// Content-Length counts the bytes ON THE WIRE: when the server compressed the answer (MTGJSON does for Meta.json)
			// fetch has already decompressed it, so the sizes only compare for an answer sent as is (the .gz files).
			const expected = Number(res.headers.get("content-length") ?? 0);
			if (expected && !res.headers.get("content-encoding") && statSync(dest).size !== expected) throw new Error(`got ${statSync(dest).size} bytes of ${expected}`);

			const sumRes = await fetch(`${url}.sha256`, { headers });
			let checksum;
			if (sumRes.status === 404) {
				checksum = "missing";
				log(`no checksum published for ${url.split("/").pop()}: not verified`);
			} else {
				if (!sumRes.ok) throw new Error(`checksum file: HTTP ${sumRes.status}`);
				const published = parseChecksumFile(await sumRes.text());
				if (!published) throw new Error("checksum file: no SHA-256 in it");
				const actual = hash.digest("hex");
				if (actual !== published) throw new Error(`SHA-256 is ${actual.slice(0, 12)}…, MTGJSON publishes ${published.slice(0, 12)}…`);
				checksum = "verified";
			}
			return { dest, lastModified: res.headers.get("last-modified"), checksum };
		} catch (e) {
			rmSync(dest, { force: true });
			log(`downloading ${url.split("/").pop()}: attempt ${attempt} failed: ${e.message}`);
			if (attempt === attempts) throw e;
			await new Promise((r) => setTimeout(r, attempt * retryDelayMs));
		}
	}
}
