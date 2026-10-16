# mtg-price-history

A daily price history of Magic: The Gathering cards, published as small static files on GitHub Pages
(`https://louis1190.github.io/mtg-price-history/`). Retail prices from **Cardmarket (EUR), TCGplayer and Card Kingdom (USD)**, for normal, foil and etched finishes, one price per day, from 2026-07-15 on, with every day
added by a scheduled job.

It exists for a [personal Obsidian plugin](https://github.com/Louis1190/obsidian-mtg-collection-tracker) that tracks a
physical collection and wants a price chart for a card without depending on a third-party API. It is **not a
service with guarantees**: the files are rebuilt every day from MTGJSON and may change shape or disappear.

## Files

```
meta.json            { "asOf": "2026-10-14", "mtgjson": { "date": ..., "version": ... }, "counts": ..., "sizes": ... }
s/<xyz>.json.gz      xyz = the first 3 hex characters of a Scryfall id: 4 096 files, ~10-40 KB each, gzip of
                     { "_": { "v": 1, "asOf": "2026-10-14", "newDays": { "cm": "2026-10-13", "tcg": "2026-10-14", "ck": "2026-10-14" } },
                       "<scryfallId>": { "<vendor>.<finish>": record, ... }, ... }
site.json            { "v": 1, "shards": "" } what the plugin reads first: where the shard files are ("" = right here, or the https address of
                     another host if they ever move). Edit site-static/site.json and run the workflow with `republish`.
mp/<xyz>.json.gz     the Mana Pool set for phones and tablets: the same 4 096 file names and layout as `s/`, holding only `mp.*` series (~1-6 KB each). See below.
movers/<period>-<view>.json   the market movers: the 20 biggest rises and falls over 1d, 7d and 30d, for all vendors together (`all`) and for each of
                     cardmarket, tcgplayer and cardkingdom: 12 files of about 8 KB, in the response shape of cardbase.dev's `/movers`
                     ({ "data": { "period", "gainers": [...], "losers": [...] }, "meta": { "as_of" } }). See below.
status.json          what the last run did (also keeps this repository's scheduled job alive)
```

- **`newDays`** (optional, in every file's `_`): each vendor's latest day on which its prices really moved. Cardmarket sometimes repeats the previous day's whole list; a reader that wants "the change
  since yesterday" reads it at that day, not at `asOf`. A reader that does not know the field ignores it.
- **vendor**: `cm` Cardmarket (price guide *trend*, EUR), `tcg` TCGplayer, `ck` Card Kingdom (both USD). Mana Pool (`mp`) is collected but **not published**:
  nothing reads it and its prices are the least reliable of the four (impossible values, prices a hundred times the other vendors').
  The files in `s/` hold three vendors; `meta.json` says `"unpublishedVendors": ["mp"]`. Mana Pool has a set of its own, `mp/` (below).
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

Prices above 1,000,000 are not kept (MTGJSON once published 21 million for a few Mana Pool prices, an integer overflow on its side): that day is a hole in the series.

Format version `v` is 1. A reader that meets another version should ignore the file.

## How it is made

`scripts/daily.mjs` runs four times a day (GitHub Actions, see `.github/workflows/daily.yml`). It reads MTGJSON's
`Meta.json`, stops when there is nothing newer, otherwise appends MTGJSON's `AllPricesToday` to the previous state,
checks every download against the SHA-256 that MTGJSON publishes next to it (the big files are fetched as `.xz`, 2-3 times smaller than `.gz`), checks that nothing went wrong (no file or series disappeared, nearly every series has a price for the newest day, every
file parses) and only then publishes. The first run rebuilds from MTGJSON's 90-day `AllPrices` and checks every series
against it. The working state travels between runs as one asset of the `state` release. A snapshot of it is also kept once a week (the last eight) in the `backups` release: our history older than MTGJSON's 90-day window exists nowhere else.
A failed download of the saved state stops the job (it never rebuilds on its own from MTGJSON's 90-day file, which would drop older days); the GitHub actions it uses are pinned to a commit. About once a week it also builds a fresh set from MTGJSON's 90-day `AllPrices` and records in `status.json` (`lastResync`) how many series
would differ from the published ones (days the job missed, prices MTGJSON corrected later). It is a report only: it changes nothing published.

## The Mana Pool set (`mp/`)

Mana Pool publishes its own price list, but it is 49 MB and its server allows no streaming, so a phone or tablet cannot read it. `scripts/publish-mp.mjs` (rules in
`scripts/lib/mp-files.mjs`) writes the `mp.*` series of the state into a second set, `mp/<xyz>.json.gz`, in the same layout as `s/`; the plugin reads it only on a phone or
tablet, where it shows the price as the lowest across all conditions (that is what MTGJSON's Mana Pool price is). It is a separate set, and not part of `s/`, so that nobody downloads
it for nothing. A series whose current price is above ten times TCGplayer's for the same printing and finish, and at least $5, is left out (MTGJSON's Mana Pool prices include
impossible values); when TCGplayer has no price that day nothing can be judged and the series is kept. The script reads what it wrote back and refuses (the files are then not published)
unless every series is exactly the state's and none is one the guard keeps out. This step's failure is tolerated: without the files a phone shows "—" for Mana Pool and nothing else changes.

## The market movers

`scripts/movers.mjs` (rules in `scripts/lib/movers.mjs`) turns the same state into twelve small lists, in a separate workflow step whose failure is tolerated
(without them the plugin asks another source; the day's prices are never held back). A list keeps a series only when it is live on the last day with a price on both days
compared, passes the plugin's anomaly filter (lower price at least 2, at most 5 times between the two prices, at most twice from 250 up), and has a lower price of at least 5.
For 7 and 30 days another vendor must also have moved the same way for the same card and finish (up 25 % or more, down 20 % or more): a one-day spike has not reached a second vendor yet,
so 24 hours does not ask for it. Ranked by percent, a printing's duplicate (same name, vendor, finish, prices) kept once. Cardmarket sometimes repeats the previous day's whole list (about one day in
eight): a vendor's "last day" is the latest one on which at least 2 % of its series really changed, and a file's `as_of` is that day. Mana Pool is not here.
The script reads what it wrote back and refuses (the files are then not published) unless every row follows the rules and every price is exactly the state's.

## Credits and terms

- The price data comes from [MTGJSON](https://mtgjson.com) (MIT License, see `NOTICE`), which collects it from the
  vendors. Prices belong to their respective vendors; they are provided as is, for personal use, without any
  warranty. This project is not affiliated with MTGJSON, Wizards of the Coast, Cardmarket, TCGplayer, Card Kingdom or Mana Pool.
- Card identifiers are Scryfall ids. No Scryfall data is republished here.
- The scripts are MIT licensed (`LICENSE`).
