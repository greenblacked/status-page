# Changelog

All notable changes to Status Page are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each release's section becomes its GitHub Release notes, so write entries for someone reading the board, not the diff. [CONTRIBUTING.md](CONTRIBUTING.md#releases) describes how to cut a release.

## [Unreleased]

### Added

- The page footer links to the source on GitHub and to the MIT License (free to use, copy, modify and share, with the copyright notice kept), and says how often the board is checked: every two minutes in the page, with the server keeping vendor feeds for 45 seconds.
- **Tilt lighting** switch in **Settings and shortcuts** for phones and tablets (iPhone, iPad, Android): the light on the glass follows how you tilt the device. Off by default, on iPhone and iPad asks for motion access, and pauses under Reduce glass and Reduce Motion.

### Changed

- The MikroTik RouterOS and Apple OS cards no longer show an "Operational" badge, which a changelog has no state for. They show "New release" when something shipped in the last 14 days, and an Unknown badge only when the source cannot be read.

### Fixed

- Fixes for iPhone, iPad and Mac Safari: incident times now reach the browser only in ISO form, phone-number-like text is no longer turned into links, the Alerts button is hidden on iPhone and iPad where a page cannot show notifications, buttons no longer wait for a double-tap, the page stops scrolling behind an open dialog, and Android can shape the app icon to fit its launcher.

## [0.5.0] - 2026-09-30

### Changed

- Every service now shows its full card, healthy or not, so Operational services list their components and link to the vendor's page just like one that needs attention. The one-line tiles are gone.
- Needs attention is ordered by urgency (Outage, Degraded, Maintenance, then Unknown, the most recently started incident first within a state), and the most urgent service leads it as a card marked **Most urgent** that spans the width on wide screens. It follows each new snapshot.
- Cloudflare Workers now collect status on request with an in-memory cache per isolate. Deployment needs only the Cloudflare account ID and API token.
- The app is named Status Page across the board, browser metadata, feeds, documentation and release titles.
- A new look built for Apple devices: glass panels over a slow, drifting aurora, with a live dot that sends out a gentle ripple while the board is live. All text stays readable at WCAG AA contrast even with the glass effect set aside. The layout fits around the notch, the rounded corners and the home indicator.
- A calmer look for the board: deep ink in dark, warm paper in light, and a faint drafting grid under the glass. Colour is kept for what needs it: every status badge shares one neutral fill with a small coloured dot.
- A dial beside the counts ticks through each two-minute check, one tick a second, in step with **Next update**. With Reduce Motion on it stands still and moves on every few seconds.
- The headline's pulse and a card that has just changed now glow warm amber, the one warm colour on the board, so what moved is easy to spot. Red still always means an outage.
- Each card shows a small number, 01 to 14, that stays with the service whatever the sort, filter or search.
- The **Settings and shortcuts** dialog rises into place as it opens, the compact bar slides in more smoothly, and buttons and stars settle with a light spring when you let go.
- The **Keyboard shortcuts** list is now **Settings and shortcuts**, and switched-off shortcuts in it are dimmed in a colour that stays readable instead of fading to half opacity.
- A Cloudflare deploy whose smoke test fails is now rolled back to the previous version automatically. The smoke test waits until the version just deployed is the one answering, so the version before it can neither pass nor fail the test in its place.
- The optional uptime strip is tidier: builds without `VITE_STATUS_HISTORY=1` no longer ship its code, a strip's worst day reads like "Sep 26", and the history build is now tested in CI. `docker compose` passes the flag through to the build.

### Removed

- Workers KV and its Cron Trigger; persistent 30-day uptime history is unavailable, so the optional card strips have no data. The history endpoint returns an empty compatibility response.

### Added

- Google Cloud, Android / Google Play, Steam, Grok and AWS cards now list components where a vendor publishes them: Google's product catalogue (`products.json`), Steam's connection managers (from the server objects `GetCMListForConnect` returns), the services named in current AWS events, with the newest event's region, and Grok's `[Service]` incident titles (xAI's component list is tried too, but it may not exist or may be blocked). Components are listed in the board's urgency order, and nothing is invented when a vendor publishes none.
- The production board lives at [status.szolotov.com](https://status.szolotov.com). Builds of `stage` are a Worker Preview named `stage` of the same Cloudflare Worker, at [stage.status.szolotov.com](https://stage.status.szolotov.com), and never receive production traffic. `dev` deploys nothing: the owner promotes work from `dev` to `stage` to `main`.
- An optional uptime strip on service cards, built only with `VITE_STATUS_HISTORY=1` and shown when `/api/history.json` has days; off by default, and empty until a history source exists.
- A **Single-key shortcuts** switch in **Settings and shortcuts** (`?`) turns off every shortcut but `Esc`, for speech input or anyone who presses them by accident. The search box stays a Tab away, the **Settings and shortcuts** button at the foot of the page, shown on every screen size, opens the list again, and the choice is kept in this browser.
- A **Reduce glass** switch in **Settings and shortcuts** turns the frosted panels solid and stops the background moving. Safari does not pass the system's Reduce Transparency setting to web pages, so this is the way to get it on an iPhone, iPad or Mac; browsers that do pass it on get the same result automatically. The choice is kept in this browser.
- A light appearance. The board now follows your system's light or dark setting and switches when it does.
- Scroll past the top of the board and a compact bar floats in with the live signal, the headline, **Alerts** and **Refresh**, so you never have to scroll back up to refresh.
- **Add to Home Screen** on an iPhone or iPad opens the board full screen under its own name and icon.
- With **Increase Contrast** on, panels turn nearly opaque with solid borders and secondary text gets darker (or lighter, on dark).
- A **Skip to services** link, the first stop when you press Tab, jumps past the header straight to the cards.
- Screen readers hear how many services a search or filter leaves, such as "3 of 14 services shown" or "0 of 14 services shown. No services match that filter.", when the headline changes, and when a refresh fails.
- A card with an incident shows when the vendor says it began and how long it has run, such as "since 14:05 UTC · 2h 10m". Maintenance that has not started yet shows when it is due instead, such as "scheduled for 22:00 UTC".
- The headline says when the snapshot on screen was taken, such as "as of 14:05 UTC".
- `/readyz` answers `503` when the board is more than ten minutes old or no source could be read, and `200` otherwise, with the snapshot's age and how many services are Unknown. Uptime monitors can watch it; `/healthz` stays the liveness probe.
- On the hosted Cloudflare deployment, every response names the Worker version that served it in an `X-Worker-Version` header.

### Fixed

- A production deploy that fails after uploading the Worker now says the new version is live and unchecked, so you know to look at it and roll back if needed.
- One AWS or Apple event with an unreadable timestamp no longer turns the whole card Unknown; that event just shows without a start time.
- The staging deployment no longer shows up in search results: it sends `X-Robots-Tag: noindex` and a `/robots.txt` that disallows crawling. Production, and any self-hosted build, now serves a `/robots.txt` that allows it.
- When no board can be produced at all, `/api/status.json`, `/feed.xml`, the badges and `/metrics` answer `503` with `Retry-After`, so feed readers, Shields.io and scrapers treat it as temporary instead of as a server error.
- On a device whose clock runs ahead of the server's, the page no longer throws away its server-rendered board and redraws it from scratch as it loads.
- **Next update** now counts down to the board's actual refetch. It used to reach 0:00 with nothing happening, because the board fetched on its own two-minute timer from whenever the page was opened.
- A service named under the headline now opens its card even when a search or filter hides it: the filters clear and the card comes into view with keyboard focus on it. It used to do nothing.
- The board no longer says **Live** over a snapshot that has stopped updating: after six minutes without a fresh one it shows **Stale** and how long ago the last one arrived. It times this by the device's own clock, so a clock that runs fast or slow does not set it off, and a snapshot already more than half an hour old when the page opens shows **Stale** at once.
- **Refresh** no longer greys out during every background check, which dropped keyboard focus back to the top of the page. It stays usable and says when a check is running.
- Buttons, links and the search box show their keyboard focus ring in Windows High Contrast and other forced-colours modes, where it used to disappear.
- When the browser blocks notifications, the bell stays reachable from the keyboard and tells screen readers why alerts are unavailable, instead of silently dropping out of the Tab order.

### Security

- Incident links from vendor feeds are used only when they are https addresses on that vendor's own status site; any other link, such as a plain `http:` or `javascript:` address or another site, is replaced by the vendor's status page on the card, in the API and in the feed.
- A vendor response larger than 4 MiB is refused as it streams in, and its card shows Unknown with the reason, so one broken or hostile source cannot exhaust the server's memory.
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

[Unreleased]: https://github.com/greenblacked/status-page/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/greenblacked/status-page/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/greenblacked/status-page/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/greenblacked/status-page/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/greenblacked/status-page/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/greenblacked/status-page/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/greenblacked/status-page/releases/tag/v0.1.0
