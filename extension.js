import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const API_URL = 'https://api.uptimerobot.com/v2/getMonitors';
// getMonitors returns at most 50 monitors per request.
const PAGE_SIZE = 50;
const MAX_MONITORS = 1000;
// Typing an API key in the preferences fires one settings change per
// keystroke; wait for the typing to settle before hitting the API.
const SETTINGS_DEBOUNCE_MS = 1000;

// Monitor status codes of the UptimeRobot v2 API.
const MonitorStatus = {
    PAUSED: 0,
    NOT_CHECKED_YET: 1,
    UP: 2,
    SEEMS_DOWN: 8,
    DOWN: 9,
};

const Health = {
    UNKNOWN: 'unknown',
    OK: 'ok',
    DOWN: 'down',
};

function monitorHealth(monitor) {
    switch (monitor.status) {
    case MonitorStatus.DOWN:
    case MonitorStatus.SEEMS_DOWN:
        return Health.DOWN;
    case MonitorStatus.UP:
        return Health.OK;
    default:
        return Health.UNKNOWN;
    }
}

const UptimeRobotIndicator = GObject.registerClass(
class UptimeRobotIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('UptimeRobot Status'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._session = new Soup.Session({
            timeout: 30,
            user_agent: 'uptimerobot-gnome-extension',
        });
        this._cancellable = new Gio.Cancellable();
        this._pollId = null;
        this._debounceId = null;
        this._refreshing = false;

        this._icon = new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: `system-status-icon uptimerobot-dot-${Health.UNKNOWN}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._monitorsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._monitorsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem(_('Refresh now'));
        refreshItem.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refreshItem);

        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settingsItem);

        this.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                this._refresh();
        });

        this._settingsChangedIds = [
            this._settings.connect('changed::api-key', () => this._scheduleRefresh()),
            this._settings.connect('changed::refresh-interval', () => this._startPolling()),
        ];

        this._setHealth(Health.UNKNOWN, _('Checking…'));
        this._refresh();
        this._startPolling();
    }

    destroy() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = null;
        }
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = null;
        }

        this._cancellable.cancel();
        this._session.abort();
        this._session = null;

        for (const id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];
        this._settings = null;

        super.destroy();
    }

    _startPolling() {
        if (this._pollId)
            GLib.source_remove(this._pollId);

        const interval = this._settings.get_int('refresh-interval');
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scheduleRefresh() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);

        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTINGS_DEBOUNCE_MS, () => {
            this._debounceId = null;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        if (this._refreshing || !this._settings)
            return;

        const apiKey = this._settings.get_string('api-key').trim();
        if (apiKey === '') {
            this._monitorsSection.removeAll();
            this._setHealth(Health.UNKNOWN, _('Add your API key in the settings'));
            return;
        }

        this._refreshing = true;
        try {
            const monitors = await this._fetchAllMonitors(apiKey);
            if (!this._settings)
                return;
            this._showMonitors(monitors);
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!this._settings)
                return;

            console.warn(`UptimeRobot: failed to fetch monitors: ${e.message}`);
            this._monitorsSection.removeAll();
            this._setHealth(Health.UNKNOWN, `${_('Error')}: ${e.message}`, true);
        } finally {
            this._refreshing = false;
        }
    }

    _showMonitors(monitors) {
        const down = monitors.filter(m => monitorHealth(m) === Health.DOWN).length;
        const paused = monitors.filter(m => m.status === MonitorStatus.PAUSED).length;
        const active = monitors.length - paused;

        let health, summary;
        if (monitors.length === 0) {
            health = Health.UNKNOWN;
            summary = _('No monitors found');
        } else if (down > 0) {
            health = Health.DOWN;
            summary = active === 1 ? _('Monitor is down') : `${down} of ${active} monitors down`;
        } else if (active > 0) {
            health = Health.OK;
            summary = active === 1 ? _('Monitor is up') : `All ${active} monitors up`;
        } else {
            health = Health.UNKNOWN;
            summary = _('All monitors are paused');
        }

        this._monitorsSection.removeAll();
        const rank = {[Health.DOWN]: 0, [Health.OK]: 1, [Health.UNKNOWN]: 2};
        const sorted = [...monitors].sort((a, b) =>
            rank[monitorHealth(a)] - rank[monitorHealth(b)] ||
            (a.friendly_name ?? '').localeCompare(b.friendly_name ?? ''));
        for (const monitor of sorted)
            this._monitorsSection.addMenuItem(this._createMonitorItem(monitor));

        this._setHealth(health, summary, true);
    }

    _createMonitorItem(monitor) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
        item.add_child(new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: `uptimerobot-menu-dot uptimerobot-dot-${monitorHealth(monitor)}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        let name = monitor.friendly_name || monitor.url || `#${monitor.id}`;
        if (monitor.status === MonitorStatus.PAUSED)
            name = `${name} (${_('paused')})`;
        item.add_child(new St.Label({
            text: name,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return item;
    }

    _setHealth(health, summary, withTimestamp = false) {
        this._icon.style_class = `system-status-icon uptimerobot-dot-${health}`;
        if (withTimestamp)
            summary = `${summary} · ${GLib.DateTime.new_now_local().format('%H:%M')}`;
        this._statusItem.label.text = summary;
    }

    async _fetchAllMonitors(apiKey) {
        const monitors = [];
        let offset = 0;
        for (;;) {
            const response = await this._request(apiKey, offset);
            const page = response.monitors ?? [];
            monitors.push(...page);

            const total = response.pagination?.total ?? monitors.length;
            offset += PAGE_SIZE;
            if (page.length === 0 || monitors.length >= total || monitors.length >= MAX_MONITORS)
                break;
        }
        return monitors;
    }

    _request(apiKey, offset) {
        return new Promise((resolve, reject) => {
            const form = `api_key=${encodeURIComponent(apiKey)}&format=json` +
                `&limit=${PAGE_SIZE}&offset=${offset}`;
            const message = Soup.Message.new_from_encoded_form('POST', API_URL, form);

            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        if (message.get_status() !== Soup.Status.OK)
                            throw new Error(`HTTP ${message.get_status()} ${message.get_reason_phrase() ?? ''}`.trim());

                        const text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
                        const response = JSON.parse(text);
                        if (response.stat !== 'ok')
                            throw new Error(response.error?.message ?? response.error?.type ?? 'unknown API error');

                        resolve(response);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }
});

export default class UptimeRobotExtension extends Extension {
    enable() {
        this._indicator = new UptimeRobotIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
