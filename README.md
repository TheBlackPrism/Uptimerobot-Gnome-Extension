# UptimeRobot GNOME Shell Extension

A GNOME Shell extension that shows the state of your [UptimeRobot](https://uptimerobot.com) monitors as a dot in the top bar:

| Dot | Meaning |
|-----|---------|
| 🟢 green | every shown, active monitor is up |
| 🔴 red | at least one shown monitor is down (or "looks down") |
| ⚪ grey | status unknown: no API key configured, the API could not be reached, all shown monitors are paused, or all monitors are hidden |

Clicking the dot opens a menu that

- shows a summary line and the time of the last check,
- lists each shown monitor with its own status dot and the host it links to,
- opens the monitor's page in your browser when you click a monitor (see [Monitor links](#monitor-links)),
- tells you how many monitors are currently hidden,
- offers *Refresh now* and *Settings* entries.

## Requirements

- GNOME Shell 45 – 50 (the extension uses the ESM extension API introduced in GNOME 45; for a newer release, add its version number to `shell-version` in `metadata.json` before installing)
- An UptimeRobot account and an API key (a **read-only** key is enough — create one in the UptimeRobot dashboard under *Integrations & API*). The key is used as a bearer token against the [UptimeRobot v3 API](https://uptimerobot.com/api/v3/).

## Installation

```sh
git clone https://github.com/TheBlackPrism/Uptimerobot-Gnome-Extension.git
cd Uptimerobot-Gnome-Extension
make install
```

`make install` bundles the extension with `gnome-extensions pack` (which also compiles the GSettings schema) and installs it into `~/.local/share/gnome-shell/extensions/`.

Then log out and back in (on X11 you can instead press <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r` and press <kbd>Enter</kbd>) and enable the extension:

```sh
gnome-extensions enable uptimerobot@theblackprism.ch
```

### Upgrading

Run `make install` again and log out and back in. Your API key and refresh interval are kept; all monitors are shown until you hide some.

## Configuration

Open the extension's settings (via the *Settings* entry in the dot's menu, or through the *Extensions* app) and paste your API key. The dot updates a second after you stop typing.

### Account

- **API key** – main or read-only UptimeRobot API key.

### Polling

- **Refresh interval** – seconds between two checks (60 – 3600, default 300). UptimeRobot itself only checks monitors every 5 minutes on free plans, so polling more often than that rarely gains anything. The status is also refreshed every time you open the menu.

### Monitors

As soon as an API key is entered, the settings load every monitor of the account and list them with a switch each:

- Switch a monitor **off** to hide it. Hidden monitors are not listed in the menu and are ignored when the colour of the dot is computed — a hidden monitor that goes down does not turn the dot red.
- Switch it **on** again to show it.
- *Show all* / *Hide all* flip every switch at once; the ↻ button reloads the list from the API.
- Monitors you create later are shown automatically, because the extension stores the *hidden* monitors rather than the shown ones.

Changes apply immediately; the extension re-renders its menu from the last fetched data without contacting the API again. Each row's subtitle shows where a click on that monitor in the menu leads.

## Monitor links

Clicking a monitor in the menu opens a page in your default browser:

- For **HTTP(S) and keyword monitors** the monitored URL itself is opened (the menu shows its host name on the right).
- For **ping, port and DNS monitors** the API only provides a host name or IP address, so the monitor's page in the UptimeRobot dashboard (`https://dashboard.uptimerobot.com/monitors/<id>`) is opened instead. Such entries are marked *Dashboard* in the menu.

## How it works

The extension calls `GET https://api.uptimerobot.com/v3/monitors?limit=200` with the header `Authorization: Bearer <API key>` and follows the `nextLink` of every page until all monitors are collected. From each monitor it uses `id`, `friendlyName`, `url` and `status`:

| `status` | Effect |
|----------|--------|
| `DOWN`, `LOOKS_DOWN` (also `SEEMS_DOWN`) | red dot |
| `UP` | counts as healthy |
| `STARTED`, `NOT_CHECKED_YET` | counts as healthy (no result yet) |
| `PAUSED` | ignored |

Only monitors that are not hidden take part. Paused monitors never turn the dot red; if *all* shown monitors are paused the dot stays grey. Status values are compared case-insensitively, and unknown values are treated like "not checked yet".

HTTP errors are reported in the menu's summary line: 401 means the API key is invalid, 429 that UptimeRobot's rate limit was hit (lower the polling frequency).

### Files

| File | Purpose |
|------|---------|
| `extension.js` | Top-bar indicator and menu, running inside GNOME Shell |
| `prefs.js` | Preferences dialog (GTK 4 / libadwaita), running in its own process |
| `api.js` | v3 API client and monitor helpers shared by both of the above |
| `schemas/*.gschema.xml` | GSettings schema: `api-key`, `refresh-interval`, `hidden-monitors` |
| `stylesheet.css` | Colours of the dots and the link hint in the menu |
| `Makefile` | `pack`, `install`, `uninstall`, `clean` targets |

### Settings keys

| Key | Type | Description |
|-----|------|-------------|
| `api-key` | string | UptimeRobot API key |
| `refresh-interval` | int (60 – 3600) | seconds between two checks |
| `hidden-monitors` | array of strings | IDs of hidden monitors; empty means everything is shown |

They can also be changed from the command line, e.g.:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/uptimerobot@theblackprism.ch/schemas \
    set org.gnome.shell.extensions.uptimerobot hidden-monitors "['123456789']"
```

## Development

- `make pack` builds the zip without installing it.
- Extension logs: `journalctl --user -f -o cat /usr/bin/gnome-shell | grep UptimeRobot`.
- Preferences logs: `journalctl --user -f -o cat | grep -i -E 'uptimerobot|JS ERROR'`.
- `api.js` can be exercised outside GNOME Shell with `gjs -m`, which makes it easy to test API changes without restarting the shell.

## Uninstall

```sh
make uninstall
```

The settings (including the API key) stay in dconf; reset them with `dconf reset -f /org/gnome/shell/extensions/uptimerobot/` if you want them gone as well.
