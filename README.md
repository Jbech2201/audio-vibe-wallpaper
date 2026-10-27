# Audio Vibe Wallpaper

Menjadikan visualisasi [Audio Vibe](../../../../audio-visual) sebagai wallpaper
hidup GNOME di Wayland: visual 6 mode tetap bereaksi pada Spotify, lirik ikut
jalan, semuanya di layer wallpaper (di bawah semua window).

## Pasang

```bash
cp -r audio-vibe-wallpaper@jbech ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/audio-vibe-wallpaper@jbech/schemas
```

Lalu logout/login — Wayland tidak bisa memuat extension yang baru dipasang
tanpa restart sesi, dan `org.gnome.Shell.Extensions.ReloadExtension` sudah
dimatikan permanen. Setelah login:

```bash
gnome-extensions enable audio-vibe-wallpaper@jbech
```

Hal yang sama berlaku untuk perubahan kode berikutnya: modul JS extension
tidak ikut ter-reload oleh `disable`/`enable`, jadi butuh logout/login.

## Cara kerja

```
extension.js ──spawn──> server.py            (bridge Spotify MPRIS + lirik)
     │
     ├──Meta.WaylandClient.new_subprocess──> renderer.js
     │                                        └─ Gtk.Window + WebKit2
     │                                           http://127.0.0.1:8765/?wallpaper=1
     │
     ├── window-created ─> hide_from_window_list() + inhibit_mapped()
     └── Clutter.Clone(window actor) ─> Main.layoutManager._backgroundGroup
```

Perintah ke renderer lewat stdin: `MODE`, `CHROME`, `VIEW`, `OFFSET`, `PAUSE`,
`RELOAD`, `QUIT`. Renderer meneruskannya ke halaman lewat
`window.audioVibe.*`.

Kuncinya `Meta.Window.inhibit_mapped()`: window renderer di-unmap sehingga tidak
terlihat dan tidak muncul di Alt-Tab maupun overview, tapi surface-nya tetap
dirender Mutter, jadi clone di layer wallpaper terus bergerak.

Pola clone-ke-background ini mengikuti extension
[Jellyfish](https://github.com/rhafaelcm/jellyfish) (GPL-3.0).

## Kontrol

Wallpaper tidak menerima klik (layer wallpaper memang tidak reaktif), jadi
semua kontrol lewat ikon emoji di panel atas:

| Aksi | Cara |
| --- | --- |
| Ganti mode | Klik ikon panel → pilih mode |
| Mode ikut jam | Menu panel → **Ikut jam** (siang 06–15, senja 15–18, malam 18–06) |
| Bahasa lirik | Menu panel → **Bahasa lirik** → Original / Romaji / English / Indonesia |
| Geser sinkronisasi lirik | Menu panel → baris **Offset lirik** → − / + (klik angkanya untuk reset) |
| Sembunyikan lirik / info lagu | Menu panel → **Lirik** / **Info lagu** |
| Muat ulang | Menu panel → **Muat ulang wallpaper** |
| Folder proyek, port, hemat daya | Menu panel → **Preferensi** |

Pilihan bahasa bersifat **preferensi yang bertahan**: tiap lagu baru dimuat,
halaman memakai versi itu lagi kalau tersedia. Kalau lagunya tidak punya
(romaji hanya untuk Korea/Jepang, terjemahan butuh internet), tampilannya
jatuh ke Original tanpa mengubah preferensi.

Kontrol playback (play/pause, next) tidak ada di sini — pakai Spotify atau
extension media controller yang sudah terpasang.

## Hemat daya

Saat ada window fullscreen, actor-nya dibekukan (`Meta.WindowActor.freeze()`)
dan loop `requestAnimationFrame` di halaman ikut dihentikan lewat perintah
`PAUSE` ke renderer. Bisa dimatikan di Preferensi.

## Syarat

- GNOME Shell 50 di **Wayland** (pola ini tidak dipakai di X11).
- `gjs`, `gir1.2-gtk-3.0`, `gir1.2-webkit2-4.1`, `python3-gi` — semuanya sudah
  bawaan Ubuntu 26.04.
- `server.py` dan `index.html` ada di folder proyek (default
  `~/audio-visual`). `index.html` harus versi yang mendukung `?wallpaper=1`.

## Catatan

- Wallpaper hanya terlihat kalau desktop tidak tertutup window. Untuk lirik yang
  selalu terlihat di atas window, pakai `spotify-lyrics-widget@jbech`.
- Di overview, GNOME menggambar background versinya sendiri untuk preview
  workspace, jadi visualisasi tidak ikut muncul di sana.
