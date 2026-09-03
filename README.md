# UptimeRobot GNOME Shell Extension

A GNOME Shell extension that shows the state of your [UptimeRobot](https://uptimerobot.com) monitors as a dot in the top bar:

| Dot | Meaning |
|-----|---------|
| 🟢 green | every active monitor is up |
| 🔴 red | at least one monitor is down (or "seems down") |
| ⚪ grey | status unknown: no API key configured, the API could not be reached, or all monitors are paused |

Clicking the dot opens a menu that lists each monitor with its own status dot, shows when the status was last fetched, and offers *Refresh now* and *Settings* entries.

## Requirements

- GNOME Shell 45 – 49 (the extension uses the ESM extension API introduced in GNOME 45; for a newer release, add its version number to `shell-version` in `metadata.json` before installing)
- An UptimeRobot account and an API key (a **read-only** key is enough — create one in the UptimeRobot dashboard under *Integrations & API*)

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

## Configuration

Open the extension's settings (via the *Settings* entry in the dot's menu, or through the *Extensions* app) and paste your API key. The dot updates a second after you stop typing.

Available settings:

- **API key** – main or read-only UptimeRobot API key.
- **Refresh interval** – seconds between two checks (60 – 3600, default 300). UptimeRobot itself only checks monitors every 5 minutes on free plans, so polling more often than that rarely gains anything.

The status is also refreshed every time you open the menu.

## How it works

The extension calls the [UptimeRobot v2 API](https://uptimerobot.com/api/) endpoint `getMonitors` and evaluates the `status` of every monitor:

- `8` (seems down) or `9` (down) → red
- `2` (up) or `1` (not checked yet) → counts as healthy
- `0` (paused) → ignored

Paused monitors never turn the dot red; if *all* monitors are paused the dot stays grey.

## Uninstall

```sh
make uninstall
```
