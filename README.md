# csgo-price-feed

Skin prices for the case opening game. **This repo exists only to
publish one JSON file** — no game code lives here, which is why it can
safely be public.

`feed/prices.json` is regenerated every two days by a GitHub Action and
read directly by the Roblox game from `raw.githubusercontent.com`.

## Why it exists

Skinport's API answers **only** brotli-encoded requests — every other
`Accept-Encoding` gets a `406`:

```
br               -> 200
gzip             -> 406
deflate          -> 406
identity         -> 406
```

And Roblox refuses to send that header at all:

```
HttpService:RequestAsync{ Headers = { ["Accept-Encoding"] = "br" } }
-- Header "Accept-Encoding" is not allowed!
```

So there is no request Roblox can make that Skinport will answer.
This repo does the brotli part on a schedule, and Roblox reads a plain
static file instead.

It also means the game makes **no** request to Skinport at runtime, so
nothing is rate limited and nothing can go down mid-session.

## What's in the file

```json
{
  "generatedAt": 1788547964,
  "currency": "USD",
  "skins":   { "skin-8d6879f0a2bc": 0.07, ... },
  "crates":  { "crate-4904": 0.24, ... },
  "catalog": { "crate-4904": { "name": "Kilowatt Case",
                               "type": "Case", "items": 30 }, ... }
}
```

- `skins` — median price across the wear variants actually listed
- `crates` — the container's own market price, where it has one
- `catalog` — every crate that exists upstream, so the game's admin
  panel can spot cases Valve shipped that the build doesn't have yet

Roughly 58 KB, ~1,576 skins.

## The schedule

`.github/workflows/update-prices.yml` runs at 04:17 UTC every second
day, and can be run by hand from the **Actions** tab. It only commits
when a price actually moved, so the history stays meaningful.

If the upstream data looks broken (fewer than 500 skins priced) the
build fails rather than overwriting a good file with junk.

## Keeping it in sync

`feed-builder.mjs` is a verbatim copy of `tools/feed-builder.mjs` in the
game project. If you change it there, copy it here.

## The URL the game uses

```
https://raw.githubusercontent.com/<you>/csgo-price-feed/main/feed/prices.json
```

That goes in `PriceConfig.FeedUrl` in the game.
