// SPDX-License-Identifier: GPL-3.0-or-later
//
// Layer wallpaper: meng-clone actor window renderer ke dalam
// Main.layoutManager._backgroundGroup, yaitu grup actor tempat GNOME Shell
// menggambar wallpaper. Semua akses ke API privat Shell dikumpulkan di file
// ini supaya kalau Shell berubah, yang perlu disesuaikan cuma satu tempat.
//
// Pola clone-ke-background ini mengikuti extension Jellyfish (GPL-3.0).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** Skala actor supaya menutup penuh monitor tanpa mengubah rasio. */
export function coverGeometry(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    return {
        x: Math.round((targetWidth - width) / 2),
        y: Math.round((targetHeight - height) / 2),
        width,
        height,
    };
}

export class WallpaperSurface {
    constructor() {
        this._entries = new Map();
        this._rebuildId = 0;
    }

    get size() {
        return this._entries.size;
    }

    hasMonitor(monitorIndex) {
        return this._entries.has(monitorIndex);
    }

    attach(monitorIndex, windowActor) {
        if (!windowActor)
            throw new Error('window renderer belum punya actor compositor');
        if (this._entries.has(monitorIndex))
            throw new Error(`monitor ${monitorIndex} sudah punya wallpaper`);

        const viewport = new Clutter.Actor({
            name: `audio-vibe-monitor-${monitorIndex}`,
            reactive: false,
            clip_to_allocation: true,
        });
        const clone = new Clutter.Clone({
            source: windowActor,
            reactive: false,
        });
        viewport.add_child(clone);
        Main.layoutManager._backgroundGroup.add_child(viewport);

        const entry = {
            source: windowActor,
            viewport,
            clone,
            frozen: false,
            destroyId: 0,
            allocationId: 0,
        };
        entry.destroyId = windowActor.connect('destroy', () => {
            entry.destroyId = 0;
            this._destroyEntry(monitorIndex, false);
        });
        entry.allocationId = windowActor.connect('notify::allocation',
            () => this._scheduleRebuild());

        this._entries.set(monitorIndex, entry);
        this._rebuild();
    }

    /**
     * Membekukan actor supaya Shell berhenti menggambar clone-nya. Dipakai
     * saat wallpaper tertutup window fullscreen.
     */
    setMonitorFrozen(monitorIndex, frozen) {
        const entry = this._entries.get(monitorIndex);
        if (!entry || entry.frozen === frozen)
            return;
        if (!entry.source.freeze || !entry.source.thaw)
            return;

        if (frozen)
            entry.source.freeze();
        else
            entry.source.thaw();
        entry.frozen = frozen;
    }

    setFrozenMonitors(monitors) {
        for (const monitorIndex of this._entries.keys())
            this.setMonitorFrozen(monitorIndex, monitors.has(monitorIndex));
    }

    rebuild() {
        this._rebuild();
    }

    detach() {
        if (this._rebuildId) {
            GLib.Source.remove(this._rebuildId);
            this._rebuildId = 0;
        }
        for (const monitorIndex of [...this._entries.keys()])
            this._destroyEntry(monitorIndex, true);
    }

    _scheduleRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        for (const [monitorIndex, entry] of this._entries) {
            const monitor = Main.layoutManager.monitors[monitorIndex];
            if (!monitor)
                continue;

            const sourceWidth = entry.source.get_width();
            const sourceHeight = entry.source.get_height();
            if (sourceWidth < 2 || sourceHeight < 2)
                continue;

            const geometry = coverGeometry(
                sourceWidth, sourceHeight, monitor.width, monitor.height);
            entry.viewport.set_position(monitor.x, monitor.y);
            entry.viewport.set_size(monitor.width, monitor.height);
            entry.clone.set_position(geometry.x, geometry.y);
            entry.clone.set_size(geometry.width, geometry.height);
        }
    }

    _destroyEntry(monitorIndex, disconnectSource) {
        const entry = this._entries.get(monitorIndex);
        if (!entry)
            return;
        this._entries.delete(monitorIndex);

        if (disconnectSource && entry.source) {
            if (entry.frozen && entry.source.thaw)
                entry.source.thaw();
            if (entry.destroyId)
                entry.source.disconnect(entry.destroyId);
            if (entry.allocationId)
                entry.source.disconnect(entry.allocationId);
        }
        entry.clone.set_source(null);
        entry.viewport.destroy();
    }
}
