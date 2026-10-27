// SPDX-License-Identifier: GPL-3.0-or-later
//
// Proses renderer dijalankan lewat Meta.WaylandClient.new_subprocess() supaya
// Mutter tahu window-nya milik Shell: window bisa disembunyikan dari daftar
// window, Alt-Tab, dan overview, tapi tetap digambar sehingga clone-nya di
// layer wallpaper terus ter-update.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

const STOP_TIMEOUT_MS = 1500;

export class RendererProcess {
    constructor(onLine, onExit) {
        this._onLine = onLine;
        this._onExit = onExit;
        this._process = null;
        this._waylandClient = null;
        this._output = null;
        this._input = null;
        this._outputCancellable = null;
        this._stopTimeoutId = 0;
        this._stopping = false;
    }

    get running() {
        return this._process !== null;
    }

    start(argv, cwd, environment = {}) {
        if (this._process)
            throw new Error('renderer sudah jalan');

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_MERGE,
        });
        launcher.set_cwd(cwd);
        for (const [name, value] of Object.entries(environment))
            launcher.setenv(name, value, true);

        try {
            this._waylandClient = Meta.WaylandClient.new_subprocess(
                global.context, launcher, argv);
            this._process = this._waylandClient.get_subprocess();
        } finally {
            if (launcher.close)
                launcher.close();
        }

        this._stopping = false;
        this._input = this._process.get_stdin_pipe();
        this._outputCancellable = new Gio.Cancellable();
        this._output = Gio.DataInputStream.new(this._process.get_stdout_pipe());
        this._readOutput();

        this._process.wait_async(null, (process, result) => {
            let error = null;
            try {
                process.wait_finish(result);
            } catch (caughtError) {
                error = caughtError;
            }
            const stopping = this._stopping;
            this._cleanup();
            if (this._onExit)
                this._onExit(stopping, error);
        });
    }

    ownsWindow(window) {
        if (!this._waylandClient || !this._process)
            return false;
        try {
            return this._waylandClient.owns_window(window);
        } catch (_error) {
            return false;
        }
    }

    hideFromWindowList(window) {
        if (!this._waylandClient)
            return;
        if (window.hide_from_window_list)
            window.hide_from_window_list();
        else
            this._waylandClient.hide_from_window_list(window);
    }

    send(line) {
        if (!this._input || this._stopping)
            return;
        try {
            this._input.write_all(`${line}\n`, null);
            this._input.flush(null);
        } catch (error) {
            logError(error, `Audio Vibe Wallpaper: gagal kirim "${line}" ke renderer`);
        }
    }

    stop() {
        if (!this._process || this._stopping)
            return;

        // Kirim QUIT dulu: send() mengabaikan perintah setelah _stopping aktif.
        this.send('QUIT');
        this._stopping = true;

        // Kalau renderer tidak keluar sendiri, hentikan paksa.
        this._stopTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, STOP_TIMEOUT_MS, () => {
                this._stopTimeoutId = 0;
                if (this._process)
                    this._process.force_exit();
                return GLib.SOURCE_REMOVE;
            });
    }

    _readOutput() {
        if (!this._output)
            return;
        this._output.read_line_async(
            GLib.PRIORITY_DEFAULT, this._outputCancellable, (stream, result) => {
                let line = null;
                try {
                    [line] = stream.read_line_finish_utf8(result);
                } catch (_error) {
                    return;
                }
                if (line === null)
                    return;
                if (this._onLine)
                    this._onLine(line.trim());
                this._readOutput();
            });
    }

    _cleanup() {
        if (this._stopTimeoutId) {
            GLib.Source.remove(this._stopTimeoutId);
            this._stopTimeoutId = 0;
        }
        if (this._outputCancellable) {
            this._outputCancellable.cancel();
            this._outputCancellable = null;
        }
        this._output = null;
        this._input = null;
        this._process = null;
        this._waylandClient = null;
    }
}
