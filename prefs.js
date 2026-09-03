// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 TheBlackPrism

// Preferences dialog of the UptimeRobot extension.
//
// Runs in a separate GTK 4 / libadwaita process, not inside GNOME Shell.
// The monitor list is loaded straight from the UptimeRobot API through the
// shared client in api.js so that it works even while the extension itself
// is not running (e.g. right after installation).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    UptimeRobotClient,
    isCancelledError,
    isPaused,
    monitorKey,
    monitorLink,
    monitorName,
} from './api.js';

// Reload the monitor list this long after the API key was last edited.
const RELOAD_DEBOUNCE_MS = 1000;

/**
 * Preferences group listing every monitor of the account with a switch that
 * controls whether it is shown. The switches are backed by the
 * `hidden-monitors` setting (a list of hidden monitor IDs), so a monitor is
 * "on" when its ID is absent from that list.
 */
const MonitorsGroup = GObject.registerClass(
class MonitorsGroup extends Adw.PreferencesGroup {
    _init(settings) {
        super._init({
            title: _('Monitors'),
            description: _('Switch a monitor off to hide it. Hidden monitors are not listed in the menu and do not influence the colour of the dot.'),
        });

        this._settings = settings;
        this._client = new UptimeRobotClient('uptimerobot-gnome-extension-prefs');
        this._cancellable = null;
        this._debounceId = null;
        this._monitors = [];
        this._rows = new Map(); // monitor key -> Adw.SwitchRow
        this._syncingSwitches = false;

        const header = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        this._showAllButton = new Gtk.Button({label: _('Show all'), sensitive: false});
        this._showAllButton.connect('clicked', () => this._setHidden([]));
        header.append(this._showAllButton);
        this._hideAllButton = new Gtk.Button({label: _('Hide all'), sensitive: false});
        this._hideAllButton.connect('clicked', () => this._setHidden(this._monitors.map(monitorKey)));
        header.append(this._hideAllButton);
        this._reloadButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: _('Reload monitors'),
        });
        this._reloadButton.connect('clicked', () => this.reload());
        header.append(this._reloadButton);
        this.header_suffix = header;

        // Single row used for "loading", "error" and "no key" messages.
        this._spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER});
        this._statusRow = new Adw.ActionRow({use_markup: false});
        this._statusRow.add_prefix(this._spinner);
        this.add(this._statusRow);

        this._settingsChangedIds = [
            settings.connect('changed::hidden-monitors', () => this._syncSwitches()),
            settings.connect('changed::api-key', () => this._scheduleReload()),
        ];

        this.reload();
    }

    /** Cancel pending work and disconnect from settings; call before closing. */
    shutdown() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        for (const id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];
        this._client.destroy();
    }

    _scheduleReload() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELOAD_DEBOUNCE_MS, () => {
            this._debounceId = null;
            this.reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** (Re)load the monitor list from the API. */
    async reload() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._clearRows();

        const apiKey = this._settings.get_string('api-key').trim();
        if (apiKey === '') {
            this._setStatus(_('Enter your API key above to load your monitors.'));
            return;
        }

        this._setStatus(_('Loading monitors…'), true);
        this._reloadButton.sensitive = false;
        try {
            const monitors = await this._client.fetchMonitors(apiKey, cancellable);
            if (cancellable.is_cancelled())
                return;
            this._monitors = monitors.sort((a, b) => monitorName(a).localeCompare(monitorName(b)));
            this._populate();
        } catch (e) {
            if (isCancelledError(e) || cancellable.is_cancelled())
                return;
            this._setStatus(`${_('Could not load monitors')}: ${e.message}`);
        } finally {
            if (!cancellable.is_cancelled())
                this._reloadButton.sensitive = true;
        }
    }

    _populate() {
        if (this._monitors.length === 0) {
            this._setStatus(_('No monitors found in this account.'));
            return;
        }

        this._statusRow.visible = false;
        this._spinner.stop();

        const hidden = new Set(this._settings.get_strv('hidden-monitors'));
        for (const monitor of this._monitors) {
            const key = monitorKey(monitor);
            const link = monitorLink(monitor);

            let title = monitorName(monitor);
            if (isPaused(monitor))
                title = `${title} (${_('paused')})`;
            let subtitle = link.uri;
            if (link.isDashboard) {
                const target = String(monitor.url ?? '').trim();
                subtitle = target
                    ? `${target} · ${_('click opens the UptimeRobot dashboard')}`
                    : _('click opens the UptimeRobot dashboard');
            }

            const row = new Adw.SwitchRow({
                title,
                subtitle,
                use_markup: false,
                title_lines: 1,
                subtitle_lines: 1,
                active: !hidden.has(key),
            });
            row.connect('notify::active', () => this._onSwitchToggled(key, row.active));
            this.add(row);
            this._rows.set(key, row);
        }
        this._updateButtons();
    }

    _clearRows() {
        for (const row of this._rows.values())
            this.remove(row);
        this._rows.clear();
        this._monitors = [];
        this._updateButtons();
    }

    _setStatus(text, loading = false) {
        this._statusRow.title = text;
        this._statusRow.visible = true;
        this._spinner.visible = loading;
        if (loading)
            this._spinner.start();
        else
            this._spinner.stop();
    }

    _onSwitchToggled(key, active) {
        if (this._syncingSwitches)
            return;
        const hidden = new Set(this._settings.get_strv('hidden-monitors'));
        if (active)
            hidden.delete(key);
        else
            hidden.add(key);
        this._setHidden([...hidden]);
    }

    _setHidden(keys) {
        this._settings.set_strv('hidden-monitors', keys);
    }

    /** Reflect the current `hidden-monitors` setting in the switches. */
    _syncSwitches() {
        const hidden = new Set(this._settings.get_strv('hidden-monitors'));
        this._syncingSwitches = true;
        for (const [key, row] of this._rows)
            row.active = !hidden.has(key);
        this._syncingSwitches = false;
        this._updateButtons();
    }

    _updateButtons() {
        const hidden = new Set(this._settings.get_strv('hidden-monitors'));
        const total = this._monitors.length;
        const shown = this._monitors.filter(m => !hidden.has(monitorKey(m))).length;
        this._showAllButton.sensitive = total > 0 && shown < total;
        this._hideAllButton.sensitive = shown > 0;
    }
});

export default class UptimeRobotPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('UptimeRobot'),
            icon_name: 'network-transmit-receive-symbolic',
        });
        window.add(page);

        const accountGroup = new Adw.PreferencesGroup({
            title: _('Account'),
            // Group descriptions are Pango markup, hence the escaped ampersand.
            description: _('A read-only API key is sufficient. You can create one in your UptimeRobot dashboard under Integrations &amp; API.'),
            header_suffix: new Gtk.LinkButton({
                label: _('Open dashboard'),
                uri: 'https://dashboard.uptimerobot.com/',
                valign: Gtk.Align.CENTER,
            }),
        });
        page.add(accountGroup);

        const apiKeyRow = new Adw.PasswordEntryRow({title: _('API key')});
        settings.bind('api-key', apiKeyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        accountGroup.add(apiKeyRow);

        const pollingGroup = new Adw.PreferencesGroup({title: _('Polling')});
        page.add(pollingGroup);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between status checks'),
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        pollingGroup.add(intervalRow);

        const monitorsGroup = new MonitorsGroup(settings);
        page.add(monitorsGroup);

        window.connect('close-request', () => {
            monitorsGroup.shutdown();
            return false;
        });
    }
}
