// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renderer Audio Vibe Wallpaper.
//
// Satu window WebKit per monitor yang memuat halaman Audio Vibe dengan
// ?wallpaper=1. Window ini dijalankan extension sebagai Meta.WaylandClient,
// lalu actor-nya di-clone ke layer wallpaper GNOME Shell, jadi window aslinya
// tidak pernah terlihat di daftar window maupun overview.
//
// Perintah dari extension masuk lewat stdin, satu baris per perintah:
//   MODE <nama>        ganti mode visual
//   CHROME <0|1> <0|1> tampilkan lirik / info lagu
//   VIEW <id>          bahasa lirik: original, romaji, lang:en, lang:id
//   OFFSET <detik>     koreksi sinkronisasi lirik
//   PAUSE <0|1>        hentikan atau lanjutkan animasi
//   RELOAD             muat ulang halaman
//   QUIT               keluar

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix?version=2.0';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix?version=2.0';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit2 from 'gi://WebKit2?version=4.1';
import System from 'system';

const TITLE_PREFIX = 'audio-vibe-wallpaper:';

function parseArguments(argv) {
    const options = {url: '', monitors: []};

    for (let index = 0; index < argv.length; index++) {
        const value = argv[index + 1];
        switch (argv[index]) {
        case '--url':
            options.url = value || '';
            index++;
            break;
        case '--monitors':
            options.monitors = (value || '').split(',')
                .filter(item => item.length > 0)
                .map(item => {
                    const [monitorIndex, size] = item.split(':');
                    const [width, height] = (size || '').split('x');
                    const monitor = {
                        index: Number(monitorIndex),
                        width: Number(width),
                        height: Number(height),
                    };
                    if (!Number.isInteger(monitor.index) ||
                        !(monitor.width > 0) || !(monitor.height > 0))
                        throw new Error(`Spesifikasi monitor tidak valid: ${item}`);
                    return monitor;
                });
            index++;
            break;
        default:
            throw new Error(`Argumen tidak dikenal: ${argv[index]}`);
        }
    }

    if (!options.url)
        throw new Error('--url wajib diisi');
    if (!options.monitors.length)
        throw new Error('--monitors wajib diisi');

    return options;
}

function quoteForJs(value) {
    return JSON.stringify(String(value));
}

class Renderer {
    constructor(application, options) {
        this._application = application;
        this._options = options;
        this._views = [];
        this._windows = [];
        this._input = null;
        this._cancellable = null;

        for (const monitor of options.monitors)
            this._createWindow(monitor);

        this._readCommands();
    }

    _createWindow(monitor) {
        const view = new WebKit2.WebView({
            settings: new WebKit2.Settings({
                enable_developer_extras: false,
                enable_smooth_scrolling: false,
                enable_back_forward_navigation_gestures: false,
                hardware_acceleration_policy: WebKit2.HardwareAccelerationPolicy.ALWAYS,
            }),
        });
        view.set_background_color(new Gdk.RGBA({red: 0, green: 0, blue: 0, alpha: 1}));
        view.connect('context-menu', () => true);
        view.connect('load-changed', (_view, event) => {
            if (event === WebKit2.LoadEvent.FINISHED)
                print(`STATUS LOADED monitor=${monitor.index}`);
        });
        view.connect('load-failed', (_view, _event, uri, error) => {
            printerr(`ERROR gagal memuat ${uri}: ${error.message}`);
            return false;
        });

        const window = new Gtk.ApplicationWindow({
            application: this._application,
            title: `${TITLE_PREFIX}${monitor.index}`,
            decorated: false,
            deletable: false,
            resizable: false,
        });
        window.set_default_size(monitor.width, monitor.height);
        window.set_size_request(monitor.width, monitor.height);
        window.add(view);
        window.connect('delete-event', () => true);
        window.connect('map', () =>
            print(`STATUS WINDOW monitor=${monitor.index} ` +
                  `size=${monitor.width}x${monitor.height} ` +
                  `scale=${window.get_scale_factor()}`));
        window.show_all();

        view.load_uri(this._buildUri(monitor));

        this._views.push(view);
        this._windows.push(window);
    }

    _buildUri(monitor) {
        const url = this._options.url;
        return url.includes('?')
            ? `${url}&monitor=${monitor.index}`
            : `${url}?monitor=${monitor.index}`;
    }

    _evaluate(script) {
        for (const view of this._views) {
            try {
                if (view.evaluate_javascript)
                    view.evaluate_javascript(script, -1, null, null, null, null);
                else
                    view.run_javascript(script, null, null);
            } catch (error) {
                printerr(`ERROR evaluate_javascript: ${error.message}`);
            }
        }
    }

    _readCommands() {
        this._cancellable = new Gio.Cancellable();
        this._input = Gio.DataInputStream.new(
            new GioUnix.InputStream({fd: 0, close_fd: false}));
        this._readNextCommand();
    }

    _readNextCommand() {
        this._input.read_line_async(
            GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
                let line = null;
                try {
                    [line] = stream.read_line_finish_utf8(result);
                } catch (error) {
                    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        printerr(`ERROR baca stdin: ${error.message}`);
                    return;
                }

                // stdin tertutup berarti extension sudah dinonaktifkan.
                if (line === null) {
                    this._application.quit();
                    return;
                }

                try {
                    this._handleCommand(line.trim());
                } catch (error) {
                    printerr(`ERROR perintah "${line.trim()}": ${error.message}`);
                }
                this._readNextCommand();
            });
    }

    _handleCommand(line) {
        if (!line.length)
            return;

        const [command, ...args] = line.split(/\s+/);
        switch (command) {
        case 'MODE':
            this._evaluate(
                `window.audioVibe && window.audioVibe.setMode(${quoteForJs(args[0])})`);
            break;
        case 'CHROME':
            this._evaluate(
                `window.audioVibe && window.audioVibe.setChrome(` +
                `${args[0] === '1'}, ${args[1] === '1'})`);
            break;
        case 'PAUSE':
            this._evaluate(
                `window.audioVibe && window.audioVibe.setPaused(${args[0] === '1'})`);
            break;
        case 'VIEW':
            this._evaluate(
                `window.audioVibe && window.audioVibe.setView(${quoteForJs(args[0])})`);
            break;
        case 'OFFSET':
            this._evaluate(
                `window.audioVibe && window.audioVibe.setOffset(${Number(args[0]) || 0})`);
            break;
        case 'RELOAD':
            for (const view of this._views)
                view.reload();
            break;
        case 'QUIT':
            this._application.quit();
            break;
        default:
            throw new Error(`perintah tidak dikenal: ${command}`);
        }
        print(`STATUS CMD ${line}`);
    }

    destroy() {
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = null;
        this._input = null;
        for (const window of this._windows)
            window.destroy();
        this._windows = [];
        this._views = [];
    }
}

let renderer = null;
let application = null;

try {
    const options = parseArguments(ARGV);

    application = new Gtk.Application({
        application_id: 'io.github.jbech.AudioVibeWallpaper',
        flags: Gio.ApplicationFlags.NON_UNIQUE,
    });
    application.connect('activate', app => {
        if (renderer)
            return;
        try {
            renderer = new Renderer(app, options);
            print('STATUS READY');
        } catch (error) {
            printerr(`ERROR ${error.message}`);
            app.quit();
        }
    });
    application.connect('shutdown', () => {
        if (renderer)
            renderer.destroy();
        renderer = null;
    });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
        application.quit();
        return GLib.SOURCE_REMOVE;
    });
    application.run([]);
} catch (error) {
    printerr(`ERROR ${error.message}`);
    if (application)
        application.quit();
    System.exit(1);
}
