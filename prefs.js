// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const LYRIC_VIEWS = [
    ['original', 'Original'],
    ['romaji', 'Romaji'],
    ['lang:en', 'English'],
    ['lang:id', 'Indonesia'],
];

const MODE_LABELS = [
    ['fire', '🔥 Api'],
    ['ice', '❄️ Salju'],
    ['sakura', '🌸 Sakura'],
    ['sunset', '🍁 Senja'],
    ['day', '☀️ Siang'],
    ['night', '🌙 Malam'],
];

export default class AudioVibeWallpaperPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();

        const visualGroup = new Adw.PreferencesGroup({
            title: 'Tampilan',
        });
        page.add(visualGroup);

        const modeRow = new Adw.ComboRow({
            title: 'Mode visual',
            model: Gtk.StringList.new(MODE_LABELS.map(([, label]) => label)),
        });
        const modeIds = MODE_LABELS.map(([id]) => id);
        modeRow.selected = Math.max(0, modeIds.indexOf(settings.get_string('mode')));
        modeRow.connect('notify::selected', () =>
            settings.set_string('mode', modeIds[modeRow.selected]));
        settings.connect('changed::mode', () => {
            const index = modeIds.indexOf(settings.get_string('mode'));
            if (index >= 0 && index !== modeRow.selected)
                modeRow.selected = index;
        });
        visualGroup.add(modeRow);

        const autoRow = new Adw.SwitchRow({
            title: 'Ikuti jam',
            subtitle: 'Siang 06.00–15.00, senja 15.00–18.00, malam 18.00–06.00',
        });
        settings.bind('auto-mode-by-time', autoRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visualGroup.add(autoRow);

        const lyricsRow = new Adw.SwitchRow({title: 'Tampilkan lirik'});
        settings.bind('show-lyrics', lyricsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visualGroup.add(lyricsRow);

        const trackRow = new Adw.SwitchRow({
            title: 'Tampilkan info lagu',
            subtitle: 'Judul, artis, dan cover album',
        });
        settings.bind('show-track', trackRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visualGroup.add(trackRow);

        const viewRow = new Adw.ComboRow({
            title: 'Bahasa lirik',
            subtitle: 'Dipakai kalau lagunya punya versi itu; kalau tidak, tetap Original',
            model: Gtk.StringList.new(LYRIC_VIEWS.map(([, label]) => label)),
        });
        const viewIds = LYRIC_VIEWS.map(([id]) => id);
        viewRow.selected = Math.max(0, viewIds.indexOf(settings.get_string('lyric-view')));
        viewRow.connect('notify::selected', () =>
            settings.set_string('lyric-view', viewIds[viewRow.selected]));
        settings.connect('changed::lyric-view', () => {
            const index = viewIds.indexOf(settings.get_string('lyric-view'));
            if (index >= 0 && index !== viewRow.selected)
                viewRow.selected = index;
        });
        visualGroup.add(viewRow);

        const offsetRow = new Adw.SpinRow({
            title: 'Offset lirik (detik)',
            subtitle: 'Positif berarti lirik muncul lebih lambat',
            digits: 1,
            adjustment: new Gtk.Adjustment({
                lower: -15, upper: 15, step_increment: 0.5, page_increment: 1,
            }),
        });
        settings.bind('lyric-offset', offsetRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        visualGroup.add(offsetRow);

        const indicatorRow = new Adw.SwitchRow({
            title: 'Ikon di panel atas',
            subtitle: 'Satu-satunya cara ganti mode, karena wallpaper tidak bisa diklik',
        });
        settings.bind('show-indicator', indicatorRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        visualGroup.add(indicatorRow);

        const systemGroup = new Adw.PreferencesGroup({
            title: 'Sumber & daya',
            description: 'Perubahan di sini menjalankan ulang renderer.',
        });
        page.add(systemGroup);

        const pathRow = new Adw.EntryRow({
            title: 'Folder proyek',
            text: settings.get_string('project-path'),
        });
        pathRow.connect('apply', () =>
            settings.set_string('project-path', pathRow.text.trim()));
        systemGroup.add(pathRow);

        const portRow = new Adw.SpinRow({
            title: 'Port server',
            adjustment: new Gtk.Adjustment({
                lower: 1024, upper: 65535, step_increment: 1, page_increment: 10,
            }),
        });
        settings.bind('port', portRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        systemGroup.add(portRow);

        const serverRow = new Adw.SwitchRow({
            title: 'Jalankan server.py otomatis',
            subtitle: 'Kalau port sudah dipakai, server yang sudah jalan tetap dipakai',
        });
        settings.bind('manage-server', serverRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        systemGroup.add(serverRow);

        const pauseRow = new Adw.SwitchRow({
            title: 'Berhenti saat ada window fullscreen',
            subtitle: 'Hemat baterai: animasi dihentikan saat wallpaper tidak terlihat',
        });
        settings.bind('pause-on-fullscreen', pauseRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        systemGroup.add(pauseRow);

        window.add(page);
    }
}
