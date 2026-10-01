# Collector fixtures

Vendor payloads for the collector tests in `../collectors.test.ts`. Each file stands in for one official endpoint that `../sources.server.ts` (and the parsers in `../changelog.ts`) read, so a test can run the real collector against a whole payload with no network.

| File | Stands in for | Collector | Origin |
| --- | --- | --- | --- |
| `aws/currentevents.json` | `https://health.aws.amazon.com/public/currentevents` | `collectAws` | Hand-built |
| `grok/feed.xml` | `https://status.x.ai/feed.xml` | `collectGrok` | Hand-built |
| `mikrotik/NEWESTa*.*` | `https://upgrade.mikrotik.com/routeros/<file>`, one per channel | `collectMikrotik` | Hand-built |
| `mikrotik/<version>/CHANGELOG` | `https://download.mikrotik.com/routeros/<version>/CHANGELOG` | `collectMikrotik` | Hand-built |
| `aws/currentevents-multiple.json` | `https://health.aws.amazon.com/public/currentevents`, with a "Multiple services" event carrying `impacted_services` | `collectAws` | Hand-built |
| `gcp/incidents.json`, `gcp/products.json` | `https://status.cloud.google.com/incidents.json`, `.../products.json` | `collectGcp` | Hand-built |
| `play/incidents.json`, `play/products.json` | `https://status.play.google.com/incidents.json`, `.../products.json` | `collectAndroid` | Hand-built |
| `steam/cm-list.json` | `https://api.steampowered.com/ISteamDirectory/GetCMListForConnect/v1/?cellid=0` | `collectSteam` | Hand-built |
| `grok/components.json` | `https://status.x.ai/v2/components.json` (Instatus) | `collectGrok` | Hand-built |
| `grok/feed-prefixed.xml` | `https://status.x.ai/feed.xml`, with titles that lead with `[Service]` | `collectGrok` | Hand-built in the layout of third-party recordings of the live feed (`INC…` guids, `<h3>Status: RESOLVED</h3>` descriptions) |
| `windows/windows11-release-information.html` | `https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information` | `collectWindows` | Hand-built in the page's documented layout (a table with Version, Servicing option, Availability date, Latest revision date and Latest build columns, then a history table per version). Not recorded: Microsoft's hosts were not reachable where it was written, and its dates and builds are illustrative |
| `apple-os/releases.rss` | `https://developer.apple.com/news/releases/rss/releases.rss` | `collectAppleOs` | Recorded 2026-09-27, trimmed to 9 of 37 items |

## Hand-built and recorded

The hand-built files were written from the parsing code, because those vendors were not reachable from where the tests were written. Nothing under `gcp/`, `play/`, `steam/` or `grok/components.json` was recorded from the vendor. The Google `incidents.json` fields (`affected_products`, `status_impact`, `currently_affected_locations`) and the `products` list shape were cross-checked against third-party parsers of those endpoints. The Steam `GetCMListForConnect` shape (`response.serverlist` of `{ endpoint, legacy_endpoint, type, dc, realm, load, wtd_load }` objects, `success`) and the `[Service] summary` titles of the xAI feed come from third-party recordings; the Instatus `components.json` layout is the documented one and was not recorded at all. `status.play.google.com/products.json` and `status.x.ai/v2/components.json` may not exist, which the collectors treat as "no list". The Windows page is hand-built from the table layout Microsoft documents on it, with made-up builds and dates (26H2 on 2026-09-29 is a stand-in, not a recording), so the collector's column names are a guess until it is recorded: `npm run source-health -- --record` saves the page, and the columns in `../windows-release.ts` (`findColumns`) are the thing to check against it. Refresh all of these from a recording when you can. Component rows built from Instatus (if that endpoint is ever reachable) can be worse than the card's badge, which follows the feed alone.

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
