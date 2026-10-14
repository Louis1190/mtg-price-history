// Streams the entries of ONE object of a huge JSON file without ever holding the file in memory.
//
// MTGJSON's AllPrices.json is ~1.5 GB once unzipped (more than V8 can hold in one string), shaped
// {"meta":{...},"data":{"<uuid>":{...},"<uuid>":{...}}}. This reader walks the bytes once, tracking
// string/escape state and nesting depth, and hands over each entry of `data` as an already parsed
// value, so a caller sees one small object at a time.
//
// Assumes what MTGJSON files guarantee: the entry keys of `data` are plain strings (no escapes) and
// every entry is itself an object. Not a general JSON streamer.

import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";

const QUOTE = 34;
const BACKSLASH = 92;
const LBRACE = 123;
const RBRACE = 125;
const LBRACKET = 91;
const RBRACKET = 93;

/** Raw bytes of a (possibly gzipped) file as a stream of chunks. */
export function openChunks(file, chunkSize = 1 << 20) {
	const raw = createReadStream(file, { highWaterMark: chunkSize });
	return file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
}

/** The `meta` object (date + version) of an MTGJSON file: it sits at the very start. */
export async function readMeta(file) {
	let head = "";
	const stream = openChunks(file);
	for await (const chunk of stream) {
		head += chunk.toString("utf8");
		const m = head.match(/"meta"\s*:\s*(\{[^}]*\})/);
		if (m) {
			stream.destroy();
			return JSON.parse(m[1]);
		}
		if (head.length > 1 << 16) break;
	}
	stream.destroy();
	throw new Error(`no meta object at the start of ${file}`);
}

/** Async generator of {key, value} for each entry of the top-level object `dataKey`. */
export async function* readEntries(file, dataKey = "data", chunkSize = 1 << 20) {
	let depth = 0;
	let inStr = false;
	let esc = false;
	let keyBytes = null; // bytes of the string being read, only collected where a key can be
	let topKey = ""; // last string seen at depth 1 (the name of a top-level property)
	let inData = false;
	let curKey = ""; // last string seen at depth 2 inside data (the entry key)
	let collecting = false;
	let parts = [];

	for await (const chunk of openChunks(file, chunkSize)) {
		const n = chunk.length;
		let start = 0; // where the entry being collected starts inside this chunk
		for (let i = 0; i < n; i++) {
			const c = chunk[i];
			if (inStr) {
				if (esc) {
					esc = false;
					if (keyBytes) keyBytes.push(c);
					continue;
				}
				if (c === BACKSLASH) {
					esc = true;
					continue;
				}
				if (c === QUOTE) {
					inStr = false;
					if (keyBytes) {
						const s = Buffer.from(keyBytes).toString("utf8");
						if (depth === 1) topKey = s;
						else curKey = s;
						keyBytes = null;
					}
					continue;
				}
				if (keyBytes) keyBytes.push(c);
				continue;
			}
			switch (c) {
				case QUOTE:
					inStr = true;
					keyBytes = depth === 1 || (depth === 2 && inData) ? [] : null;
					break;
				case LBRACE:
				case LBRACKET:
					depth++;
					if (depth === 2 && c === LBRACE && topKey === dataKey) inData = true;
					else if (depth === 3 && inData) {
						collecting = true;
						start = i;
						parts = [];
					}
					break;
				case RBRACE:
				case RBRACKET:
					if (depth === 3 && collecting) {
						parts.push(chunk.subarray(start, i + 1));
						const text = parts.length === 1 ? parts[0].toString("utf8") : Buffer.concat(parts).toString("utf8");
						collecting = false;
						parts = [];
						yield { key: curKey, value: JSON.parse(text) };
					} else if (depth === 2 && inData) {
						inData = false;
					}
					depth--;
					break;
			}
		}
		if (collecting) parts.push(chunk.subarray(start));
	}
}
