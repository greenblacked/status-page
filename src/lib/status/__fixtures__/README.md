# Collector fixtures

Vendor payloads for the collector tests in `../collectors.test.ts`. Each file stands in for one official endpoint that `../sources.server.ts` (and the parsers in `../changelog.ts`) read, so a test can run the real collector against a whole payload with no network.

| Directory | Stands in for | Collector |
| --- | --- | --- |
| `aws/currentevents.json` | `https://health.aws.amazon.com/public/currentevents` | `collectAws` |
| `grok/feed.xml` | `https://status.x.ai/feed.xml` | `collectGrok` |
| `mikrotik/NEWESTa*.*` | `https://upgrade.mikrotik.com/routeros/<file>`, one per channel | `collectMikrotik` |
| `mikrotik/<version>/CHANGELOG` | `https://download.mikrotik.com/routeros/<version>/CHANGELOG` | `collectMikrotik` |
| `apple-os/releases.rss` | `https://developer.apple.com/news/releases/rss/releases.rss` | `collectAppleOs` |

## How they were made

The first versions were written by hand from the parsing code, because the vendors were not reachable from where the tests were written. They keep every field and element the collectors read, in the vendor's layout, and drop the rest. Replace them with trimmed real responses when you can (below); the tests should not need to change beyond their expected values.

Each file holds a few items chosen to exercise one rule per item: an active event next to a resolved one and a stale one, a newer release listed above an older one of the same family, and so on. The comments in `../collectors.test.ts` name which item covers what.

## Conventions

- **Dates are fixed.** The tests pin the clock to `2026-09-20T12:00:00Z`, and every date in these files sits within a few days of it (or, for "stale", 30 days before), near noon UTC so that card dates such as `Sep 18` read the same in any time zone from UTC-11 to UTC+11. When you refresh a file, move its dates next to that clock rather than moving the clock.
- **Text, UTF-8, LF.** `scripts/ci/hygiene.sh` checks every tracked text file. The AWS feed is UTF-16 on the wire; the test encodes the JSON file to UTF-16 before serving it, so keep the file itself UTF-8.
- **Trim, don't invent.** Keep the vendor's field names, nesting and value types (AWS sends `date` and `status` as strings, for instance), even when a collector does not read a field today.

## Refreshing a fixture

Fetch the endpoint, keep two or three items, and adjust the dates as above:

```bash
curl -sS https://status.x.ai/feed.xml > /tmp/feed.xml
curl -sS https://developer.apple.com/news/releases/rss/releases.rss > /tmp/releases.rss
curl -sS https://upgrade.mikrotik.com/routeros/NEWESTa7.stable
curl -sS https://health.aws.amazon.com/public/currentevents | iconv -f UTF-16 -t UTF-8 > /tmp/currentevents.json
```

Then run `npx vitest run src/lib/status/collectors.test.ts`. A failure after a refresh is the point of these tests: either the vendor changed its shape and the collector needs a fix, or an expected value in the test needs updating to the new items.
