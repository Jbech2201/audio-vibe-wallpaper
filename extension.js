// SPDX-License-Identifier: GPL-3.0-or-later
//
// Audio Vibe Wallpaper
//
// Alur kerjanya:
//   1. server.py (bridge Spotify MPRIS + lirik) dijalankan kalau belum jalan.
//   2. renderer.js dijalankan sebagai Meta.WaylandClient; satu window WebKit
//      per monitor memuat http://127.0.0.1:<port>/?wallpaper=1
//   3. Begitu window muncul, window-nya disembunyikan dari daftar window dan
//      di-unmap lewat Meta.Window.inhibit_mapped(), tapi surface-nya tetap
//      digambar karena actor-nya di-clone ke layer wallpaper Shell.
//
// Hasilnya: visualisasi jalan di posisi wallpaper, di bawah semua window, dan
// tidak ikut muncul di Alt-Tab maupun overview.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Indicator} from './indicator.js';
import {RendererProcess} from './renderer-process.js';
import {WallpaperSurface} from './wallpaper.js';

const WINDOW_TITLE_PREFIX = 'audio-vibe-wallpaper:';
const SERVER_GRACE_MS = 1200;
const RESTART_DEBOUNCE_MS = 500;
const ACTOR_RETRY_MS = 100;
const ACTOR_RETRY_MAX = 30;
const RELOAD_RETRY_MS = 2000;
const RELOAD_RETRY_MAX = 10;
const AUTO_MODE_INTERVAL_S = 600;

/** Mode visual mengikuti jam kalau auto-mode-by-time aktif. */
function modeForHour(hour) {
    if (hour >= 6 && hour < 15)
        return 'day';
    if (hour >= 15 && hour < 18)
        return 'sunset';
    return 'night';
}

export default class AudioVibeWallpaperExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._surface = new WallpaperSurface();
        this._process = null;
        this._server = null;
        this._indicator = null;

        this._identifications = new Map();
        this._actorRetries = new Map();
        this._managedWindows = new Map();

        this._startTimeoutId = 0;
        this._restartTimeoutId = 0;
        this._reloadTimeoutId = 0;
        this._reloadRetries = 0;
        this._autoModeTimeoutId = 0;

        this._windowCreatedId = global.display.connect('window-created',
            (_display, window) => this._onWindowCreated(window));
        this._fullscreenId = global.display.connect('in-fullscreen-changed',
            () => this._applyPauseState());
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._scheduleRestart());

        this._settingsIds = [
            ['changed::mode', () => this._applyMode()],
            ['changed::auto-mode-by-time', () => this._updateAutoMode()],
            ['changed::show-lyrics', () => this._applyChrome()],
            ['changed::lyric-view', () => this._applyLyrics()],
            ['changed::lyric-offset', () => this._applyLyrics()],
            ['changed::show-track', () => this._applyChrome()],
            ['changed::project-path', () => this._scheduleRestart()],
            ['changed::port', () => this._scheduleRestart()],
            ['changed::manage-server', () => this._scheduleRestart()],
            ['changed::pause-on-fullscreen', () => this._applyPauseState()],
            ['changed::show-indicator', () => this._updateIndicator()],
        ].map(([signal, callback]) => this._settings.connect(signal, callback));

        this._updateIndicator();
        this._updateAutoMode();
        this._start();
    }

    disable() {
        this._clearTimeout('_startTimeoutId');
        this._clearTimeout('_restartTimeoutId');
        this._clearTimeout('_reloadTimeoutId');
        this._clearTimeout('_autoModeTimeoutId');

        if (this._windowCreatedId)
            global.display.disconnect(this._windowCreatedId);
        if (this._fullscreenId)
            global.display.disconnect(this._fullscreenId);
        if (this._monitorsChangedId)
            Main.layoutManager.disconnect(this._monitorsChangedId);
        this._windowCreatedId = 0;
        this._fullscreenId = 0;
        this._monitorsChangedId = 0;

        for (const signalId of this._settingsIds ?? [])
            this._settings.disconnect(signalId);
        this._settingsIds = [];

        this._stop();

        if (this._indicator)
            this._indicator.destroy();
        this._indicator = null;

        this._surface.detach();
        this._surface = null;
        this._settings = null;
    }

    /* ---------------------------------------------------------------
       Mode & tampilan
       --------------------------------------------------------------- */

    get effectiveMode() {
        if (this._settings.get_boolean('auto-mode-by-time'))
            return modeForHour(new Date().getHours());
        return this._settings.get_string('mode');
    }

    _applyMode() {
        const mode = this.effectiveMode;
        if (this._process)
            this._process.send(`MODE ${mode}`);
        if (this._indicator)
            this._indicator.setMode(mode, this._settings.get_boolean('auto-mode-by-time'));
    }

    _applyChrome() {
        if (!this._process)
            return;
        const lyrics = this._settings.get_boolean('show-lyrics') ? '1' : '0';
        const track = this._settings.get_boolean('show-track') ? '1' : '0';
        this._process.send(`CHROME ${lyrics} ${track}`);
    }

    _applyLyrics() {
        if (!this._process)
            return;
        this._process.send(`VIEW ${this._settings.get_string('lyric-view')}`);
        this._process.send(`OFFSET ${this._settings.get_double('lyric-offset')}`);
        if (this._indicator)
            this._indicator.setLyrics(
                this._settings.get_string('lyric-view'),
                this._settings.get_double('lyric-offset'));
    }

    _updateAutoMode() {
        this._clearTimeout('_autoModeTimeoutId');
        if (this._settings.get_boolean('auto-mode-by-time')) {
            this._autoModeTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, AUTO_MODE_INTERVAL_S, () => {
                    this._applyMode();
                    return GLib.SOURCE_CONTINUE;
                });
        }
        this._applyMode();
    }

    _updateIndicator() {
        const wanted = this._settings.get_boolean('show-indicator');
        if (wanted && !this._indicator) {
            this._indicator = new Indicator({
                settings: this._settings,
                onReload: () => this.reload(),
                onPreferences: () => this.openPreferences(),
            });
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            this._applyMode();
            this._applyLyrics();
        } else if (!wanted && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    /* ---------------------------------------------------------------
       Siklus hidup server & renderer
       --------------------------------------------------------------- */

    reload() {
        this._scheduleRestart(0);
    }

    _scheduleRestart(delay = RESTART_DEBOUNCE_MS) {
        this._clearTimeout('_restartTimeoutId');
        this._restartTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, delay, () => {
                this._restartTimeoutId = 0;
                this._stop();
                this._start();
                return GLib.SOURCE_REMOVE;
            });
    }

    _start() {
        const path = this._settings.get_string('project-path');
        for (const name of ['server.py', 'index.html']) {
            const file = Gio.File.new_for_path(GLib.build_filenamev([path, name]));
            if (!file.query_exists(null)) {
                Main.notifyError('Audio Vibe Wallpaper',
                    `${name} tidak ada di ${path}. Perbaiki lewat Preferensi.`);
                return;
            }
        }

        if (this._settings.get_boolean('manage-server'))
            this._startServer(path);

        // Beri server waktu untuk mengikat port sebelum WebKit memuat halaman.
        this._clearTimeout('_startTimeoutId');
        this._startTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SERVER_GRACE_MS, () => {
                this._startTimeoutId = 0;
                this._startRenderer(path);
                return GLib.SOURCE_REMOVE;
            });
    }

    _startServer(path) {
        if (this._server)
            return;

        const python = GLib.find_program_in_path('python3');
        if (!python) {
            Main.notifyError('Audio Vibe Wallpaper', 'python3 tidak ditemukan.');
            return;
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE,
        });
        launcher.set_cwd(path);
        launcher.setenv('PYTHONUNBUFFERED', '1', true);

        try {
            this._server = launcher.spawnv([
                python, 'server.py',
                '--port', String(this._settings.get_int('port')),
            ]);
        } catch (error) {
            logError(error, 'Audio Vibe Wallpaper: gagal menjalankan server.py');
            this._server = null;
            return;
        } finally {
            if (launcher.close)
                launcher.close();
        }

        const server = this._server;
        server.wait_async(null, (process, result) => {
            try {
                process.wait_finish(result);
            } catch (_error) {
                // Diabaikan: status keluar sudah cukup informatif di log.
            }
            if (this._server === server) {
                // Paling sering karena port sudah dipakai server.py lain, dan
                // itu tidak masalah: renderer tetap memakai server yang ada.
                log(`Audio Vibe Wallpaper: server.py berhenti (status ${process.get_exit_status()})`);
                this._server = null;
            }
        });
    }

    _startRenderer(path) {
        if (this._process)
            return;

        const gjs = GLib.find_program_in_path('gjs');
        if (!gjs) {
            Main.notifyError('Audio Vibe Wallpaper', 'gjs tidak ditemukan.');
            return;
        }

        const monitors = Main.layoutManager.monitors
            .map((monitor, index) => `${index}:${monitor.width}x${monitor.height}`)
            .join(',');
        if (!monitors) {
            Main.notifyError('Audio Vibe Wallpaper', 'Tidak ada monitor terdeteksi.');
            return;
        }

        const rendererPath = GLib.build_filenamev([this.path, 'renderer.js']);
        const argv = [gjs, '-m', rendererPath, '--url', this._buildUrl(), '--monitors', monitors];

        this._reloadRetries = 0;
        const process = new RendererProcess(
            line => this._onRendererLine(process, line),
            (stopping, error) => this._onRendererExit(process, stopping, error));
        this._process = process;

        try {
            process.start(argv, path, {GDK_BACKEND: 'wayland'});
        } catch (error) {
            logError(error, 'Audio Vibe Wallpaper: gagal menjalankan renderer');
            Main.notifyError('Audio Vibe Wallpaper', `Renderer gagal jalan: ${error.message}`);
            if (this._process === process)
                this._process = null;
        }
    }

    _buildUrl() {
        const port = this._settings.get_int('port');
        const parameters = [
            'wallpaper=1',
            `mode=${this.effectiveMode}`,
            `lyrics=${this._settings.get_boolean('show-lyrics') ? 1 : 0}`,
            `track=${this._settings.get_boolean('show-track') ? 1 : 0}`,
            `view=${encodeURIComponent(this._settings.get_string('lyric-view'))}`,
            `offset=${this._settings.get_double('lyric-offset')}`,
        ];
        return `http://127.0.0.1:${port}/?${parameters.join('&')}`;
    }

    _stop() {
        this._clearTimeout('_startTimeoutId');
        this._clearTimeout('_reloadTimeoutId');

        for (const monitorIndex of [...this._managedWindows.keys()])
            this._releaseManagedWindow(monitorIndex);
        for (const window of [...this._identifications.keys()])
            this._cancelIdentification(window);
        for (const monitorIndex of [...this._actorRetries.keys()])
            this._cancelActorRetry(monitorIndex);

        if (this._surface)
            this._surface.detach();

        if (this._process) {
            this._process.stop();
            this._process = null;
        }
        if (this._server) {
            const server = this._server;
            this._server = null;
            server.force_exit();
        }
    }

    _onRendererLine(process, line) {
        // Renderer lama masih bisa bersuara setelah penggantinya lahir.
        if (this._process !== process)
            return;

        if (line.startsWith('STATUS')) {
            log(`Audio Vibe Wallpaper: renderer: ${line}`);
            if (line.startsWith('STATUS READY')) {
                this._applyMode();
                this._applyChrome();
                this._applyLyrics();
            }
            return;
        }
        if (line.includes('gagal memuat')) {
            this._scheduleReload();
            return;
        }
        if (line.startsWith('ERROR'))
            log(`Audio Vibe Wallpaper: renderer: ${line}`);
    }

    _onRendererExit(process, stopping, error) {
        // Proses yang baru saja dimatikan sering keluar SETELAH penggantinya
        // dibuat; tanpa pengecekan ini referensi renderer baru ikut terhapus
        // dan proses itu bocor sampai sesi berakhir.
        if (this._process !== process)
            return;

        this._process = null;
        if (stopping)
            return;
        if (error)
            logError(error, 'Audio Vibe Wallpaper: renderer berhenti tak terduga');
        Main.notifyError('Audio Vibe Wallpaper',
            'Renderer berhenti. Pakai menu panel untuk memuat ulang.');
    }

    /** Halaman gagal dimuat, biasanya karena server.py belum siap. */
    _scheduleReload() {
        if (this._reloadTimeoutId || this._reloadRetries >= RELOAD_RETRY_MAX)
            return;
        this._reloadRetries++;
        this._reloadTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, RELOAD_RETRY_MS, () => {
                this._reloadTimeoutId = 0;
                if (this._process)
                    this._process.send('RELOAD');
                return GLib.SOURCE_REMOVE;
            });
    }

    /* ---------------------------------------------------------------
       Window renderer
       --------------------------------------------------------------- */

    _onWindowCreated(window) {
        if (!this._process || !this._process.ownsWindow(window) ||
            this._identifications.has(window))
            return;

        this._process.hideFromWindowList(window);
        window.lower();

        const identification = {
            titleId: window.connect('notify::title', () => this._identify(window)),
            unmanagedId: window.connect('unmanaged', () =>
                this._cancelIdentification(window)),
            raisedId: window.connect_after('raised', () => window.lower()),
        };
        this._identifications.set(window, identification);
        this._identify(window);
    }

    _identify(window) {
        if (!this._identifications.has(window) || !this._process ||
            !this._process.ownsWindow(window))
            return;

        const title = window.get_title() || '';
        if (!title.startsWith(WINDOW_TITLE_PREFIX))
            return;

        const monitorIndex = Number(title.slice(WINDOW_TITLE_PREFIX.length));
        if (!Number.isInteger(monitorIndex) ||
            !Main.layoutManager.monitors[monitorIndex]) {
            log(`Audio Vibe Wallpaper: judul window tak terduga "${title}"`);
            return;
        }
        if (this._surface.hasMonitor(monitorIndex) ||
            this._actorRetries.has(monitorIndex))
            return;

        this._cancelIdentification(window);

        if (window.move_to_monitor)
            window.move_to_monitor(monitorIndex);
        window.lower();

        this._actorRetries.set(monitorIndex, {window, timeoutId: 0, count: 0});
        this._tryAttach(monitorIndex);
    }

    _tryAttach(monitorIndex) {
        const retry = this._actorRetries.get(monitorIndex);
        if (!retry || !this._process || !this._process.ownsWindow(retry.window))
            return;

        const actor = retry.window.get_compositor_private();
        const ready = actor && actor.get_width() >= 2 && actor.get_height() >= 2;

        if (ready) {
            this._cancelActorRetry(monitorIndex);
            try {
                this._surface.attach(monitorIndex, actor);
                this._manageWindow(monitorIndex, retry.window);
                this._applyPauseState();
                log(`Audio Vibe Wallpaper: wallpaper monitor ${monitorIndex} aktif ` +
                    `(actor ${Math.round(actor.get_width())}x${Math.round(actor.get_height())}, ` +
                    `window disembunyikan: ${retry.window.is_mapped_inhibited()})`);
            } catch (error) {
                logError(error, 'Audio Vibe Wallpaper: gagal memasang wallpaper');
                Main.notifyError('Audio Vibe Wallpaper',
                    `Gagal memasang wallpaper: ${error.message}`);
            }
            return;
        }

        if (retry.count >= ACTOR_RETRY_MAX) {
            this._cancelActorRetry(monitorIndex);
            Main.notifyError('Audio Vibe Wallpaper',
                `Window renderer monitor ${monitorIndex} tidak pernah siap.`);
            return;
        }

        retry.count++;
        retry.timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, ACTOR_RETRY_MS, () => {
                const current = this._actorRetries.get(monitorIndex);
                if (current)
                    current.timeoutId = 0;
                this._tryAttach(monitorIndex);
                return GLib.SOURCE_REMOVE;
            });
    }

    /**
     * Setelah actor di-clone, window aslinya di-unmap dengan inhibit_mapped()
     * supaya tidak terlihat dan tidak muncul di overview. Surface-nya tetap
     * dirender Mutter, jadi clone di layer wallpaper terus bergerak.
     */
    _manageWindow(monitorIndex, window) {
        if (!window.inhibit_mapped || !window.is_mapped_inhibited)
            throw new Error('API Meta.Window.inhibit_mapped tidak tersedia');

        const signalIds = [
            window.connect_after('raised', () => window.lower()),
            window.connect('notify::above', () => {
                if (window.above)
                    window.unmake_above();
            }),
            window.connect('unmanaged', () => {
                this._managedWindows.delete(monitorIndex);
                this._scheduleRestart();
            }),
        ];
        this._managedWindows.set(monitorIndex, {window, signalIds});

        if (window.above)
            window.unmake_above();
        window.lower();
        window.inhibit_mapped();
        if (!window.is_mapped_inhibited())
            throw new Error('Mutter menolak menyembunyikan window renderer');
    }

    _releaseManagedWindow(monitorIndex) {
        const managed = this._managedWindows.get(monitorIndex);
        if (!managed)
            return;
        this._managedWindows.delete(monitorIndex);

        for (const signalId of managed.signalIds) {
            try {
                managed.window.disconnect(signalId);
            } catch (_error) {
                // Meta.Window mungkin sudah unmanaged.
            }
        }
        try {
            if (managed.window.is_mapped_inhibited())
                managed.window.uninhibit_mapped();
        } catch (_error) {
            // Window sudah hilang bersama renderer.
        }
    }

    _cancelIdentification(window) {
        const identification = this._identifications.get(window);
        if (!identification)
            return;
        this._identifications.delete(window);
        for (const signalId of Object.values(identification)) {
            try {
                window.disconnect(signalId);
            } catch (_error) {
                // Meta.Window mungkin sudah unmanaged.
            }
        }
    }

    _cancelActorRetry(monitorIndex) {
        const retry = this._actorRetries.get(monitorIndex);
        if (!retry)
            return;
        this._actorRetries.delete(monitorIndex);
        if (retry.timeoutId)
            GLib.Source.remove(retry.timeoutId);
    }

    /* ---------------------------------------------------------------
       Hemat daya
       --------------------------------------------------------------- */

    /**
     * Monitor yang tertutup window fullscreen dibekukan: actor-nya berhenti
     * digambar dan loop animasi di halaman ikut dihentikan.
     */
    _applyPauseState() {
        if (!this._surface)
            return;

        const frozen = new Set();
        if (this._settings.get_boolean('pause-on-fullscreen')) {
            const count = Main.layoutManager.monitors.length;
            for (let index = 0; index < count; index++) {
                if (global.display.get_monitor_in_fullscreen(index))
                    frozen.add(index);
            }
        }
        this._surface.setFrozenMonitors(frozen);

        if (this._process) {
            const allFrozen = this._surface.size > 0 &&
                frozen.size >= Main.layoutManager.monitors.length;
            this._process.send(`PAUSE ${allFrozen ? 1 : 0}`);
        }
    }

    _clearTimeout(name) {
        if (this[name]) {
            GLib.Source.remove(this[name]);
            this[name] = 0;
        }
    }
}
