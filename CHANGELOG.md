# Changelog

All notable changes to Status Bar are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release's section becomes its GitHub Release notes, so write entries for someone reading the board, not the diff. [CONTRIBUTING.md](CONTRIBUTING.md#releases) describes how to cut a release.

## [Unreleased]

### Added

- A **Single-key shortcuts** switch in the keyboard shortcuts list (`?`) turns off the letter and number keys, for speech input or anyone who presses them by accident. `/`, `?` and `Esc` keep working, and the choice is kept in this browser.
- A **Skip to services** link, the first stop when you press Tab, jumps past the header straight to the cards.
- Screen readers hear how many services a search or filter leaves, such as "3 of 14 services shown", when the headline changes, and when a refresh fails.
- A card with an incident shows when the vendor says it began and how long it has run, such as "since 14:05 UTC · 2h 10m".

### Changed

- On the hosted Cloudflare deployment, a scheduled job now collects the board every two minutes into a KV namespace instead of each request's isolate collecting it itself, and **Refresh** shows that snapshot instead of forcing a new sweep.
- A Cloudflare deploy whose smoke test fails is now rolled back to the previous version automatically.

### Fixed

- **Refresh** no longer greys out during every background check, which dropped keyboard focus back to the top of the page. It stays usable and says when a check is running.
- Buttons, links and the search box show their keyboard focus ring in Windows High Contrast and other forced-colours modes, where it used to disappear.
- When the browser blocks notifications, the bell stays reachable from the keyboard and tells screen readers why alerts are unavailable, instead of silently dropping out of the Tab order.

### Security

- Every page and API response now carries security headers: a Content-Security-Policy that allows only the board's own origin and forbids framing, HSTS, `nosniff`, a referrer policy and a permissions policy.

## [0.4.0] - 2026-09-26

### Added

- Prometheus metrics at `/metrics`: each service's state, incidents and source reachability, ready for Grafana dashboards and Alertmanager rules. `/healthz` answers liveness probes without touching the vendors.
- Star the services you care about: starred services sort first, and the **Starred** filter shows only them. Stars are kept in this browser.
- Keyboard shortcuts: `/` to search, `1`–`6` for the filters, `I` for Issues only, `S` for Starred, `R` to refresh and `Esc` to clear. Press `?` for the list.
- Search and filters are kept in the page address, so a filtered board can be bookmarked or pasted into a chat, such as `/?category=cloud&issues=true`.

## [0.3.0] - 2026-09-25

### Added

- A public JSON API at `/api/status.json`, with the board's overall health, headline and every service's status and incidents.
- An Atom feed at `/feed.xml` with one entry per service that needs attention. Subscribe Slack, Microsoft Teams, Discord or a feed reader to it for alerts without code.
- Shields.io status badges at `/api/badge/<service>`, and `/api/badge/board` for the whole board.
- Opt-in browser notifications: switch on the bell and the board tells you when a service changes while its tab is in the background.
- Every pull request merged with a `feat`, `fix` or breaking change is released on its own: CI picks the next version from the commit type, tags it and publishes a GitHub Release.

### Changed

- Livelier board: cards catch a soft light under the pointer, the summary counts roll to their new values, the headline dot pulses while something is wrong, a card that just changed flashes, and **Refresh** glides cards to their new places. All of it switches off when the system asks for reduced motion.

## [0.2.0] - 2026-09-25

### Changed

- The board opens with one line naming the worst problem, such as "Outage: Apple", with links to every service that needs attention.
- Services that need attention come first, worst first. Operational services are compact one-line tiles, and the release trackers have their own section.
- The filters show how many services each one matches, and the browser tab shows how many need attention.

### Fixed

- An incident's text no longer appears up to three times on one card, and a long component detail no longer pushes its status badge out of the card.
- A card with an incident links to that incident instead of the vendor's front page.
- A Statuspage service in maintenance names the maintenance on its card instead of showing a blank summary.
- Google Cloud and Google Play incident links point to the incident, not to a malformed address.

## [0.1.1] - 2026-09-25

### Fixed

- Grok incidents and Apple OS release names read as the vendor wrote them: codes such as `&amp;` in the RSS feeds are decoded, and an update that mentions something like "latency < 500ms" no longer loses the rest of its text.
- Steam turns Degraded, and names the source that failed, when only one of its two sources answers. When neither answers, the card is Unknown with the real error instead of Outage.
- A failed player-count request no longer blanks the CS2 Europe card; the count is left out.
- CS2 Europe's "fewer than 40% of relay points" rule is exact for every number of points.

## [0.1.0] - 2026-09-24

First tagged release.

### Added

- One board for fourteen services, each read from one official vendor source:
  - Cloud: Google Cloud and AWS
  - Gaming: Steam, CS2 Europe, Epic Games and Fortnite
  - Platforms: Spotify, Apple and Android / Google Play
  - AI: Grok, ChatGPT and Claude
  - Updates: MikroTik RouterOS and Apple OS releases
- Five health states: Operational, Maintenance, Degraded, Outage and Unknown. A source that times out or changes its format shows Unknown with the reason. It is never counted as operational.
- Summary cards across the top of the board: how many services are operational, what needs attention, and how many sources could be read.
- Server-side snapshots refresh every two minutes. A page load right after the snapshot expires gets the last snapshot while a fresh one loads. The Refresh button cannot trigger more than one vendor sweep every 15 seconds.
- Each failed collector writes one `collector_failed` JSON log line with the service, the failure kind (http, timeout, network or parser) and the latency.
- Docker Compose services that run the checks in the shared [github-base-images](https://github.com/greenblacked/github-base-images) CI images, with no local Node needed.
- CI:
  - typecheck, tests, build and a server-render smoke test on the pinned Node 22 and on Node 24;
  - CodeQL and dependency review;
  - one triage comment per pull request that explains failed checks;
  - an hourly job that checks the live vendor endpoints and opens one issue for each broken source.

[Unreleased]: https://github.com/greenblacked/status-page/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/greenblacked/status-page/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/greenblacked/status-page/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/greenblacked/status-page/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/greenblacked/status-page/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/greenblacked/status-page/releases/tag/v0.1.0
