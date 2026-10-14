# mtg-price-history

A daily price history of Magic: The Gathering cards, published as small static files on GitHub Pages
(`https://louis1190.github.io/mtg-price-history/`). Retail prices from **Cardmarket (EUR), TCGplayer, Card Kingdom
and Mana Pool (USD)**, for normal, foil and etched finishes, one price per day, from 2026-07-15 on, with every day
added by a scheduled job.

It exists for a [personal Obsidian plugin](https://github.com/Louis1190/obsidian-mtg-collection-tracker) that tracks a
physical collection and wants a price chart for a card without depending on a third-party API. It is **not a
service with guarantees**: the files are rebuilt every day from MTGJSON and may change shape or disappear.

## Files

```
meta.json            { "asOf": "2026-10-14", "mtgjson": { "date": ..., "version": ... }, "counts": ..., "sizes": ... }
s/<xyz>.json.gz      xyz = the first 3 hex characters of a Scryfall id: 4 096 files, ~10-40 KB each, gzip of
                     { "_": { "v": 1, "asOf": "2026-10-14" },
                       "<scryfallId>": { "<vendor>.<finish>": record, ... }, ... }
site.json            { "v": 1, "shards": "" } what the plugin reads first: where the shard files are ("" = right here, or the https address of
                     another host if they ever move). Edit site-static/site.json and run the workflow with `republish`.
status.json          what the last run did (also keeps this repository's scheduled job alive)
```

- **vendor**: `cm` Cardmarket (price guide *trend*, EUR), `tcg` TCGplayer, `ck` Card Kingdom, `mp` Mana Pool (all USD).
- **finish**: `n` normal, `f` foil, `e` etched.
- **record** = `[start, end, [offset, cents], ...]`, in days since 1970-01-01. Only *changes* are stored: from day
  `start + offset` the price is `cents` until the next entry; `null` means "no data from that day" (a hole).
  `end` is the last day with data (it equals `asOf` while the series is live). Prices are integers in hundredths.

```js
function decode([start, end, ...changes]) {          // -> [[day, cents], ...] for every day with data
	const out = []; let i = 0, cur = null;
	for (let day = start; day <= end; day++) {
		while (i < changes.length && changes[i][0] <= day - start) cur = changes[i++][1];
		if (cur !== null) out.push([day, cur]);
	}
	return out;
}
```

Format version `v` is 1. A reader that meets another version should ignore the file.

## How it is made

`scripts/daily.mjs` runs four times a day (GitHub Actions, see `.github/workflows/daily.yml`). It reads MTGJSON's
`Meta.json`, stops when there is nothing newer, otherwise appends MTGJSON's `AllPricesToday` to the previous state,
checks every download against the SHA-256 that MTGJSON publishes next to it (the big files are fetched as `.xz`, 2-3 times smaller than `.gz`), checks that nothing went wrong (no file or series disappeared, nearly every series has a price for the newest day, every
file parses) and only then publishes. The first run rebuilds from MTGJSON's 90-day `AllPrices` and checks every series
against it. The working state travels between runs as one asset of the `state` release.
About once a week it also builds a fresh set from MTGJSON's 90-day `AllPrices` and records in `status.json` (`lastResync`) how many series
would differ from the published ones (days the job missed, prices MTGJSON corrected later). It is a report only: it changes nothing published.

## Credits and terms

- The price data comes from [MTGJSON](https://mtgjson.com) (MIT License, see `NOTICE`), which collects it from the
  vendors. Prices belong to their respective vendors; they are provided as is, for personal use, without any
  warranty. This project is not affiliated with MTGJSON, Wizards of the Coast, Cardmarket, TCGplayer, Card Kingdom or Mana Pool.
- Card identifiers are Scryfall ids. No Scryfall data is republished here.
- The scripts are MIT licensed (`LICENSE`).
