# Changelog

## Unreleased

### Added

- The project is now licensed under the GNU GPL, version 3 or later (`LICENSE`). Source files carry SPDX headers.

## 2.0.0 – 2026-09-03

### Changed

- Monitors are fetched from the UptimeRobot v3 REST API (`GET /v3/monitors` with the API key as bearer token). Pagination follows the `nextLink` cursor with 200 monitors per page. Status values are the strings `UP`, `DOWN`, `LOOKS_DOWN`, `PAUSED`, `STARTED` (…).
- The API client and the monitor helpers moved into `api.js`, shared between the extension and the preferences.
- GNOME Shell 50 added to the supported versions.

### Added

- Clicking a monitor in the menu opens its page: the monitored URL for HTTP(S)/keyword monitors, the monitor's dashboard page for ping/port/DNS monitors. The host (or *Dashboard*) is shown at the right of each entry.
- New *Monitors* section in the settings listing every monitor with a switch. Hidden monitors are neither listed in the menu nor considered for the colour of the dot. *Show all* / *Hide all* buttons and a reload button are provided. Stored in the new `hidden-monitors` setting.
- The menu shows how many monitors are hidden.
- Clearer error messages for invalid keys (401) and rate limiting (429).

### Fixed

- The description of the *Account* group in the settings contained an unescaped `&` that triggered a markup warning.

## 1.0.0

- Initial release: green/red/grey dot, monitor list, refresh interval.
