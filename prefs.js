import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
            description: _('A read-only API key is sufficient. You can create one in your UptimeRobot dashboard under Integrations & API.'),
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
    }
}
