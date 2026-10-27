// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ikon panel: satu-satunya cara mengganti mode, bahasa lirik, dan offset,
// karena wallpaper berada di layer yang tidak menerima klik.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const MODES = [
    {id: 'fire', emoji: '🔥', label: 'Api'},
    {id: 'ice', emoji: '❄️', label: 'Salju'},
    {id: 'sakura', emoji: '🌸', label: 'Sakura'},
    {id: 'sunset', emoji: '🍁', label: 'Senja'},
    {id: 'day', emoji: '☀️', label: 'Siang'},
    {id: 'night', emoji: '🌙', label: 'Malam'},
];

export const LYRIC_VIEWS = [
    {id: 'original', label: 'Original'},
    {id: 'romaji', label: 'Romaji'},
    {id: 'lang:en', label: 'English'},
    {id: 'lang:id', label: 'Indonesia'},
];

const OFFSET_STEP = 0.5;
const OFFSET_LIMIT = 15;

function formatOffset(value) {
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}s`;
}

export const Indicator = GObject.registerClass(
class AudioVibeIndicator extends PanelMenu.Button {
    _init({settings, onReload, onPreferences}) {
        super._init(0.5, 'Audio Vibe Wallpaper');

        this._settings = settings;
        this._modeItems = new Map();
        this._viewItems = new Map();

        this._label = new St.Label({
            text: '🌙',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);

        for (const mode of MODES) {
            const item = new PopupMenu.PopupMenuItem(`${mode.emoji}  ${mode.label}`);
            item.connect('activate', () => {
                settings.set_boolean('auto-mode-by-time', false);
                settings.set_string('mode', mode.id);
            });
            this._modeItems.set(mode.id, item);
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const viewMenu = new PopupMenu.PopupSubMenuMenuItem('Bahasa lirik');
        for (const view of LYRIC_VIEWS) {
            const item = new PopupMenu.PopupMenuItem(view.label);
            item.connect('activate', () => settings.set_string('lyric-view', view.id));
            this._viewItems.set(view.id, item);
            viewMenu.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(viewMenu);

        this.menu.addMenuItem(this._buildOffsetItem());

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._autoItem = new PopupMenu.PopupSwitchMenuItem('Ikut jam',
            settings.get_boolean('auto-mode-by-time'));
        this._autoItem.connect('toggled', (_item, state) =>
            settings.set_boolean('auto-mode-by-time', state));
        this.menu.addMenuItem(this._autoItem);

        this._lyricsItem = new PopupMenu.PopupSwitchMenuItem('Lirik',
            settings.get_boolean('show-lyrics'));
        this._lyricsItem.connect('toggled', (_item, state) =>
            settings.set_boolean('show-lyrics', state));
        this.menu.addMenuItem(this._lyricsItem);

        this._trackItem = new PopupMenu.PopupSwitchMenuItem('Info lagu',
            settings.get_boolean('show-track'));
        this._trackItem.connect('toggled', (_item, state) =>
            settings.set_boolean('show-track', state));
        this.menu.addMenuItem(this._trackItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const reloadItem = new PopupMenu.PopupMenuItem('Muat ulang wallpaper');
        reloadItem.connect('activate', () => onReload());
        this.menu.addMenuItem(reloadItem);

        const preferencesItem = new PopupMenu.PopupMenuItem('Preferensi');
        preferencesItem.connect('activate', () => onPreferences());
        this.menu.addMenuItem(preferencesItem);

        this._settingsIds = [
            ['changed::auto-mode-by-time', () =>
                this._autoItem.setToggleState(settings.get_boolean('auto-mode-by-time'))],
            ['changed::show-lyrics', () =>
                this._lyricsItem.setToggleState(settings.get_boolean('show-lyrics'))],
            ['changed::show-track', () =>
                this._trackItem.setToggleState(settings.get_boolean('show-track'))],
        ].map(([signal, callback]) => settings.connect(signal, callback));
    }

    /**
     * Baris offset dibuat dari tombol, bukan menu item, supaya menu tidak
     * tertutup setiap kali ditekan — offset biasanya perlu beberapa klik.
     */
    _buildOffsetItem() {
        const item = new PopupMenu.PopupBaseMenuItem({
            activate: false,
            can_focus: false,
        });

        const box = new St.BoxLayout({
            x_expand: true,
            style: 'spacing: 6px;',
        });
        box.add_child(new St.Label({
            text: 'Offset lirik',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const earlier = new St.Button({
            label: '−',
            style_class: 'button',
            style: 'min-width: 32px;',
        });
        earlier.connect('clicked', () => this._nudgeOffset(-OFFSET_STEP));
        box.add_child(earlier);

        this._offsetButton = new St.Button({
            label: formatOffset(0),
            style_class: 'button',
            style: 'min-width: 64px;',
        });
        this._offsetButton.connect('clicked', () =>
            this._settings.set_double('lyric-offset', 0));
        box.add_child(this._offsetButton);

        const later = new St.Button({
            label: '+',
            style_class: 'button',
            style: 'min-width: 32px;',
        });
        later.connect('clicked', () => this._nudgeOffset(OFFSET_STEP));
        box.add_child(later);

        item.add_child(box);
        return item;
    }

    _nudgeOffset(delta) {
        const value = this._settings.get_double('lyric-offset') + delta;
        const clamped = Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, value));
        this._settings.set_double('lyric-offset', Math.round(clamped * 10) / 10);
    }

    setMode(mode, automatic) {
        const entry = MODES.find(item => item.id === mode) ?? MODES[0];
        this._label.text = automatic ? `${entry.emoji}⏱` : entry.emoji;

        for (const [id, item] of this._modeItems) {
            item.setOrnament(!automatic && id === mode
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NO_DOT);
        }
    }

    setLyrics(viewId, offset) {
        for (const [id, item] of this._viewItems) {
            item.setOrnament(id === viewId
                ? PopupMenu.Ornament.CHECK
                : PopupMenu.Ornament.NO_DOT);
        }
        if (this._offsetButton)
            this._offsetButton.label = formatOffset(offset);
    }

    destroy() {
        for (const signalId of this._settingsIds ?? [])
            this._settings.disconnect(signalId);
        this._settingsIds = [];
        super.destroy();
    }
});
