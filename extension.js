// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 TheBlackPrism

// UptimeRobot status indicator for GNOME Shell.
//
// Shows a coloured dot in the top bar summarising the state of the monitors
// of an UptimeRobot account, lists the monitors in a drop-down menu and
// sends a desktop notification whenever a monitor goes down or comes back
// up. All API access lives in api.js, which is shared with the preferences.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    DASHBOARD_URL,
    Health,
    UptimeRobotClient,
    isCancelledError,
    isPaused,
    monitorHealth,
    monitorKey,
    monitorLink,
    monitorName,
} from './api.js';

// Typing an API key in the preferences fires one settings change per
// keystroke; wait for the typing to settle before hitting the API.
const SETTINGS_DEBOUNCE_MS = 1000;

// Icons of the notification source and of the two kinds of notification.
const SOURCE_ICON = 'network-transmit-receive-symbolic';
const DOWN_ICON = 'network-error-symbolic';
const UP_ICON = 'emblem-ok-symbolic';

/**
 * Host name of a URL, used as a compact hint of where a menu entry leads.
 *
 * @param {string} uri absolute URL
 * @returns {string} the host, or the URL itself if it cannot be parsed
 */
function linkHost(uri) {
    try {
        return GLib.Uri.parse(uri, GLib.UriFlags.NONE).get_host() ?? uri;
    } catch {
        return uri;
    }
}

/**
 * Comma separated monitor names, e.g. for the body of a notification.
 *
 * @param {object[]} monitors monitor objects of the v3 API
 * @returns {string} the names, sorted alphabetically
 */
function monitorNames(monitors) {
    return monitors.map(monitorName).sort((a, b) => a.localeCompare(b)).join(', ');
}

const UptimeRobotIndicator = GObject.registerClass(
class UptimeRobotIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, _('UptimeRobot Status'));

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new UptimeRobotClient(
            `uptimerobot-gnome-extension/${extension.metadata['version-name'] ?? 'dev'}`);
        this._cancellable = new Gio.Cancellable();
        this._pollId = null;
        this._debounceId = null;
        this._refreshing = false;
        // Result of the last successful fetch, including hidden monitors, so
        // that toggling a monitor's visibility can re-render without a
        // network round-trip.
        this._monitors = null;
        // Health of every monitor (hidden ones included) as of the last
        // successful fetch, keyed by monitor ID; null until the first fetch
        // succeeded. Compared against each new fetch to detect status
        // changes worth a notification.
        this._lastHealth = null;
        // Notification source shared by all of our notifications. GNOME
        // Shell destroys it as soon as its last notification is dismissed,
        // so it is created lazily and dropped on destroy.
        this._notificationSource = null;

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
            this._settings.connect('changed::api-key', () => {
                // A different key may mean a different account whose
                // monitors happen to share IDs; do not compare across keys.
                this._lastHealth = null;
                this._scheduleRefresh();
            }),
            this._settings.connect('changed::refresh-interval', () => this._startPolling()),
            this._settings.connect('changed::hidden-monitors', () => this._render()),
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
        this._client.destroy();
        this._client = null;

        for (const id of this._settingsChangedIds)
            this._settings.disconnect(id);
        this._settingsChangedIds = [];
        this._settings = null;
        this._monitors = null;
        this._lastHealth = null;

        // Sent notifications stay in the notification list, but their
        // click handlers refer to this indicator, so take them down along
        // with it.
        this._notificationSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notificationSource = null;

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

    /** Fetch all monitors from the API and re-render the menu. */
    async _refresh() {
        if (this._refreshing || !this._settings)
            return;

        const apiKey = this._settings.get_string('api-key').trim();
        if (apiKey === '') {
            this._monitors = null;
            this._monitorsSection.removeAll();
            this._setHealth(Health.UNKNOWN, _('Add your API key in the settings'));
            return;
        }

        this._refreshing = true;
        try {
            const monitors = await this._client.fetchMonitors(apiKey, this._cancellable);
            if (!this._settings)
                return;
            this._monitors = monitors;
            this._notifyStatusChanges(monitors);
            this._render();
        } catch (e) {
            if (isCancelledError(e) || !this._settings)
                return;

            console.warn(`UptimeRobot: failed to fetch monitors: ${e.message}`);
            this._monitors = null;
            this._monitorsSection.removeAll();
            this._setHealth(Health.UNKNOWN, `${_('Error')}: ${e.message}`, true);
        } finally {
            this._refreshing = false;
        }
    }

    /**
     * Rebuild the dot colour, the summary line and the monitor list from
     * the last fetched monitors, honouring the `hidden-monitors` setting.
     */
    _render() {
        if (!this._settings || !this._monitors)
            return;

        const hidden = new Set(this._settings.get_strv('hidden-monitors'));
        const visible = this._monitors.filter(m => !hidden.has(monitorKey(m)));
        const hiddenCount = this._monitors.length - visible.length;

        const down = visible.filter(m => monitorHealth(m) === Health.DOWN).length;
        const paused = visible.filter(isPaused).length;
        const active = visible.length - paused;

        let health, summary;
        if (this._monitors.length === 0) {
            health = Health.UNKNOWN;
            summary = _('No monitors found');
        } else if (visible.length === 0) {
            health = Health.UNKNOWN;
            summary = _('All monitors are hidden');
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
        const sorted = [...visible].sort((a, b) =>
            rank[monitorHealth(a)] - rank[monitorHealth(b)] ||
            monitorName(a).localeCompare(monitorName(b)));
        for (const monitor of sorted)
            this._monitorsSection.addMenuItem(this._createMonitorItem(monitor));

        if (hiddenCount > 0) {
            const text = ngettext('%d monitor hidden', '%d monitors hidden', hiddenCount)
                .replace('%d', String(hiddenCount));
            this._monitorsSection.addMenuItem(new PopupMenu.PopupMenuItem(text, {reactive: false}));
        }

        this._setHealth(health, summary, true);
    }

    /**
     * One row of the monitor list: status dot, name and the host of the
     * page that opens when the row is clicked.
     *
     * @param {object} monitor a monitor object of the v3 API
     * @returns {PopupMenu.PopupBaseMenuItem} the menu item
     */
    _createMonitorItem(monitor) {
        const item = new PopupMenu.PopupBaseMenuItem();
        item.add_child(new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: `uptimerobot-menu-dot uptimerobot-dot-${monitorHealth(monitor)}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        let name = monitorName(monitor);
        if (isPaused(monitor))
            name = `${name} (${_('paused')})`;
        const nameLabel = new St.Label({
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        item.add_child(nameLabel);

        const link = monitorLink(monitor);
        item.add_child(new St.Label({
            text: link.isDashboard ? _('Dashboard') : linkHost(link.uri),
            style_class: 'uptimerobot-monitor-link',
            opacity: 150,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        item.connect('activate', () => this._openMonitor(monitor));
        return item;
    }

    /**
     * Open the monitored page (or the monitor's dashboard page for
     * non-HTTP monitors) in the default browser.
     *
     * @param {object} monitor a monitor object of the v3 API
     */
    _openMonitor(monitor) {
        this._openUri(monitorLink(monitor).uri);
    }

    /**
     * Open a URL in the default browser, reporting failures to the user.
     *
     * @param {string} uri absolute URL
     */
    _openUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (e) {
            console.warn(`UptimeRobot: could not open ${uri}: ${e.message}`);
            Main.notifyError(_('UptimeRobot: could not open link'), e.message);
        }
    }

    /**
     * Compare the freshly fetched monitors with the previous fetch and
     * notify about every shown monitor that went down or came back up.
     *
     * The first successful fetch (and the first one after an API key
     * change) only records the current state. Hidden monitors are tracked
     * too, so that un-hiding one does not trigger a stale notification,
     * but they never cause a notification themselves. Failed fetches keep
     * the last known state, so a change that happened while the API was
     * unreachable is still reported once it can be reached again.
     *
     * @param {object[]} monitors all monitors of the last fetch
     */
    _notifyStatusChanges(monitors) {
        const previous = this._lastHealth;
        const current = new Map(monitors.map(m => [monitorKey(m), monitorHealth(m)]));
        this._lastHealth = current;

        if (!previous || !this._settings.get_boolean('notify-status-changes'))
            return;

        const hidden = new Set(this._settings.get_strv('hidden-monitors'));
        const wentDown = [];
        const cameUp = [];
        for (const monitor of monitors) {
            const key = monitorKey(monitor);
            if (hidden.has(key))
                continue;

            const before = previous.get(key);
            const after = current.get(key);
            if (before === undefined || before === after)
                continue;

            if (after === Health.DOWN)
                wentDown.push(monitor);
            else if (after === Health.OK && before === Health.DOWN)
                cameUp.push(monitor);
        }

        if (wentDown.length > 0)
            this._notifyMonitors(wentDown, true);
        if (cameUp.length > 0)
            this._notifyMonitors(cameUp, false);
    }

    /**
     * Send one notification for a group of monitors that changed in the
     * same direction. A single monitor gets its own notification whose
     * activation opens the monitor's page; several monitors are summarised
     * in one notification that opens the UptimeRobot dashboard.
     *
     * @param {object[]} monitors the monitors that changed
     * @param {boolean} down true if they went down, false if they came up
     */
    _notifyMonitors(monitors, down) {
        let title, body, uri;
        if (monitors.length === 1) {
            const [monitor] = monitors;
            const name = monitorName(monitor);
            title = down ? `${name} ${_('is down')}` : `${name} ${_('is up again')}`;
            const link = monitorLink(monitor);
            uri = link.uri;
            const target = String(monitor.url ?? '').trim();
            body = link.isDashboard
                ? (target ? `${target} · ${_('Click to open the UptimeRobot dashboard')}` : _('Click to open the UptimeRobot dashboard'))
                : `${target} · ${_('Click to open')}`;
        } else {
            const n = monitors.length;
            title = (down
                ? ngettext('%d monitor is down', '%d monitors are down', n)
                : ngettext('%d monitor is up again', '%d monitors are up again', n))
                .replace('%d', String(n));
            body = monitorNames(monitors);
            uri = DASHBOARD_URL;
        }

        this._sendNotification({
            title,
            body,
            iconName: down ? DOWN_ICON : UP_ICON,
            urgency: down ? MessageTray.Urgency.HIGH : MessageTray.Urgency.NORMAL,
            uri,
        });
    }

    /**
     * Show a desktop notification under this extension's source. Supports
     * the GNOME 46+ property-based MessageTray API and the positional one
     * of GNOME 45.
     *
     * @param {object} params notification parameters
     * @param {string} params.title notification title
     * @param {string} params.body notification body
     * @param {string} params.iconName themed icon of the notification
     * @param {number} params.urgency one of MessageTray.Urgency
     * @param {string} params.uri URL opened when the notification is activated
     */
    _sendNotification({title, body, iconName, urgency, uri}) {
        try {
            const modern = typeof MessageTray.Source.prototype.addNotification === 'function';
            const source = this._getNotificationSource(modern);
            const gicon = new Gio.ThemedIcon({name: iconName});

            let notification;
            if (modern) {
                notification = new MessageTray.Notification({
                    source,
                    title,
                    body,
                    gicon,
                    urgency,
                    isTransient: false,
                });
            } else {
                notification = new MessageTray.Notification(source, title, body, {gicon});
                notification.setUrgency(urgency);
                notification.setTransient(false);
            }

            notification.connect('activated', () => this._openUri(uri));

            if (modern)
                source.addNotification(notification);
            else
                source.showNotification(notification);
        } catch (e) {
            console.warn(`UptimeRobot: could not send notification: ${e.message}`);
        }
    }

    /**
     * The notification source of this extension, created on demand. GNOME
     * Shell destroys a source once its last notification is gone, at which
     * point the reference is dropped so the next call creates a new one.
     *
     * @param {boolean} modern whether the GNOME 46+ MessageTray API is in use
     * @returns {MessageTray.Source} the source, already added to the tray
     */
    _getNotificationSource(modern) {
        if (this._notificationSource)
            return this._notificationSource;

        const title = _('UptimeRobot Status');
        const source = modern
            ? new MessageTray.Source({title, iconName: SOURCE_ICON})
            : new MessageTray.Source(title, SOURCE_ICON);
        source.connect('destroy', () => {
            if (this._notificationSource === source)
                this._notificationSource = null;
        });
        Main.messageTray.add(source);
        this._notificationSource = source;
        return source;
    }

    _setHealth(health, summary, withTimestamp = false) {
        this._icon.style_class = `system-status-icon uptimerobot-dot-${health}`;
        if (withTimestamp)
            summary = `${summary} · ${GLib.DateTime.new_now_local().format('%H:%M')}`;
        this._statusItem.label.text = summary;
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
