# Collector fixtures

Vendor payloads for the collector tests in `../collectors.test.ts`. Each file stands in for one official endpoint that `../sources.server.ts` (and the parsers in `../changelog.ts`) read, so a test can run the real collector against a whole payload with no network.

| File | Stands in for | Collector | Origin |
| --- | --- | --- | --- |
| `aws/currentevents.json` | `https://health.aws.amazon.com/public/currentevents` | `collectAws` | Hand-built |
| `grok/feed.xml` | `https://status.x.ai/feed.xml` | `collectGrok` | Hand-built |
| `mikrotik/NEWESTa*.*` | `https://upgrade.mikrotik.com/routeros/<file>`, one per channel | `collectMikrotik` | Hand-built |
| `mikrotik/<version>/CHANGELOG` | `https://download.mikrotik.com/routeros/<version>/CHANGELOG` | `collectMikrotik` | Hand-built |
| `gcp/incidents.json`, `gcp/products.json` | `https://status.cloud.google.com/incidents.json`, `.../products.json` | `collectGcp` | Hand-built |
| `play/incidents.json`, `play/products.json` | `https://status.play.google.com/incidents.json`, `.../products.json` | `collectAndroid` | Hand-built |
| `steam/cm-list.json` | `https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0` | `collectSteam` | Hand-built |
| `grok/components.json` | `https://status.x.ai/v2/components.json` (Instatus) | `collectGrok` | Hand-built |
| `grok/feed-prefixed.xml` | `https://status.x.ai/feed.xml`, with titles that lead with a service | `collectGrok` | Hand-built |
| `apple-os/releases.rss` | `https://developer.apple.com/news/releases/rss/releases.rss` | `collectAppleOs` | Recorded 2026-09-27, trimmed to 9 of 37 items |

## Hand-built and recorded

The hand-built files were written from the parsing code, because those vendors were not reachable from where the tests were written. The Google, Steam and Instatus component payloads follow the documented layouts (`products` with `title` and `id`, `affected_products` on incidents, `response.serverlist`, Instatus `components` with `children`) but were never recorded live: check them against a recording before trusting the exact field names, and note that `status.play.google.com/products.json` and `status.x.ai/v2/components.json` may not exist, which the collectors treat as "no list". They keep every field and element the collectors read, in the vendor's layout and value types (AWS sends `date` and `status` as strings, for instance), and drop the rest. Replace them with trimmed recordings when you can (below); the tests should only need new expected values.

Each file holds a few items chosen to exercise one rule per item: an active event next to a resolved one and a stale one, a newer release listed above an older one of the same family, a non-OS release that must be skipped, and so on. The comments in `../collectors.test.ts` name which item covers what.

## Conventions

- **Trim, don't invent.** Keep the vendor's own items, field names, nesting and formatting. Drop items to cover the cases you need; don't edit the ones you keep.
- **Pin the clock to the data.** The tests fake `Date` so the collectors' 14-day windows see the fixture's dates as recent or stale on purpose. The hand-built files sit around `2026-09-20T12:00:00Z`; a recorded file gets its own `vi.setSystemTime` in its test, chosen for what that test needs.
- **Dates on cards are UTC.** `vitest.config.ts` sets `TZ=UTC`, so an expected `Sep 21` holds on every machine.
- **Text, UTF-8, LF.** `scripts/ci/hygiene.sh` checks every tracked text file, including trailing whitespace. The AWS feed is UTF-16 on the wire; keep the fixture UTF-8, and the test encodes it before serving it.

## Refreshing a fixture

Record what the collectors receive, then trim it:

```bash
SOURCE_HEALTH_ATTEMPTS=1 npm run source-health -- --record /tmp/recorded
ls /tmp/recorded/developer.apple.com/news/releases/rss/
iconv -f UTF-16 -t UTF-8 /tmp/recorded/health.aws.amazon.com/public/currentevents > /tmp/currentevents.json
```

`--record` saves each response byte for byte under `<dir>/<host>/<path>`, whether or not the source read cleanly, so check that a file holds the payload and not an error page. Then run `npx vitest run src/lib/status/collectors.test.ts`. A failure after a refresh is the point of these tests: either the vendor changed its shape and the collector needs a fix, or an expected value needs updating to the new items.
