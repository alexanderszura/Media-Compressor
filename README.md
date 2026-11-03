# Media Compressor

A small Tauri v2 desktop app (TypeScript + Rust) for trimming a video and compressing it with FFmpeg. The trim screen is modeled on LosslessCut.

## Requirements

- **Node.js** 18 or newer
- **Rust** (stable), installed with [rustup](https://rustup.rs). On Windows you also need the MSVC build tools, which come with "Desktop development with C++" in the Visual Studio Build Tools installer. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- **FFmpeg is installed automatically.** On first launch the app checks for FFmpeg. If it's missing, or older than version 5, the app downloads the newest stable static build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (~190 MB, one time). It checks the download's SHA-256 and puts `ffmpeg.exe` and `ffprobe.exe` in `%LOCALAPPDATA%\com.aszura.mediacompressor\ffmpeg`. Use **Settings → Download latest FFmpeg** to update it.
  - The app looks for FFmpeg in four places, in this order: a custom folder set in Settings, the copy the app installed, the folder next to the app's `.exe`, then `PATH`.
  - Automatic install is Windows-only. BtbN publishes no macOS builds, and its Linux builds come as `.tar.xz` archives. On those platforms the setup screen tells you how to install FFmpeg yourself.

## Run

```bash
npm install
npm run tauri dev      # dev mode with hot reload
npm run tauri build    # release build plus installer in src-tauri/target/release/bundle
```

Tests:

```bash
npm test                       # TypeScript utils (vitest)
npm run typecheck              # tsc
cd src-tauri && cargo test     # arg builder, media server, real encodes/previews if ffmpeg is on PATH
cargo test -- --ignored real_install   # actually downloads FFmpeg (~190 MB)
```

## Using it

1. **Open a file.** Drop a video on the window, click the drop zone, or press **Ctrl+O**.
2. **Trim it.** Seek to the start of the part you want and press **I**. Seek to the end and press **O**. You can also drag the orange edges on the timeline, which shows the frame live while you drag.
3. Press **Next** (or **Enter**) to open the export settings.
4. **Configure the export:**
   - **File name.** Filled in from the format set in Settings. You can edit it, and **Reset** rebuilds it from the format.
   - **Video.** Choose **Bitrate** (kbps) or **Target file size** (MB). In target-size mode the video bitrate is calculated for you after subtracting the audio. You can also set the encoder (x264, x265, NVENC), the speed preset, the resolution, and two-pass encoding.
   - **Audio tracks.** Each track can be set to one of three options:
     - **Master**: all Master tracks are mixed into a single track.
     - **Keep**: the track is kept as its own separate track.
     - **Remove**: the track is dropped.
   - **Track names.** Each output track gets a name box. The Master track's box is above the list, and each **Keep** track has its own box in its row. They're pre-filled from **Settings → Audio track names**, and the names are written into the exported file.
   - **Preview.** Renders just the cut, quickly and at low resolution, with your audio choices applied. You can then watch it and hear the Master mix and kept tracks exactly as they'll be exported. Tick or untick tracks under **Listen to** to switch between them or hear several together.
5. Click **Export**. Where the file goes depends on **Settings → Save location**: either the input file's folder (the default) or a fixed folder you choose. To send a single export somewhere else, click **Change…** on the export screen. If the file already exists, you have to click Export a second time to overwrite it. The app never overwrites the original file.

### Keyboard

| Key | Action |
| --- | --- |
| `I` / `O` | Set cut start / cut end |
| `Space` | Play / pause |
| `←` / `→` | Seek 1 s (`Shift` = 10 s) |
| `,` / `.` or `Ctrl+←/→` | Previous / next frame |
| `Home` / `End` | Jump to start / end |
| `M` | Mute |
| `P` | Play cut (from the start mark to the end mark) |
| `Enter` | Next (go to export settings) |
| `Esc` | Back / close dialog |
| `Ctrl` + mouse wheel on timeline | Zoom |

### Default track names

Under **Settings → Audio track names** you can set:
- **Master (mixed) track**: the default name for the mix, e.g. `Game + Mic`. Leave it empty to use `Master (Tracks 1 + 3)`.
- **Track 1, 2, 3…**: the default name for each source track number, e.g. 1 = Game, 2 = Discord, 3 = Mic. This is handy if your recordings always use the same track layout, like OBS does. Leave a box empty to keep the name stored in the file. If Master contains only one track, that track's name is used for it.

### Filename format variables

| Variable | Example |
| --- | --- |
| `${FILENAME}` | `Game Clip` (no extension) |
| `${EXT}` | `.mp4` (includes the dot) |
| `${CUT_FROM}` | `00.01.05.250` |
| `${CUT_TO}` | `00.02.10.000` |

The default format is `${FILENAME}-CUT${EXT}`. Characters that Windows doesn't allow in file names are replaced with `_`.

Settings are saved to `%APPDATA%\com.aszura.mediacompressor\settings.json`.

## Previewing and seeking

The player streams the video from a small built-in server on `127.0.0.1`. Every URL carries a random token, so other programs can't use the server to read your files. Streaming this way makes jumping to a new spot in the video much faster than WebView2's built-in file protocol. If that stream ever fails, the app automatically falls back to the built-in protocol.

When you open a file, the app checks its codecs against what your WebView2 can play:

| File | What happens |
| --- | --- |
| MP4/MOV/WebM with codecs the player supports | Plays directly |
| MKV, TS, FLV, and similar, with H.264/HEVC/VP9/AV1 video and AAC/MP3/Opus/FLAC audio | **Remux** into a temporary MP4 (no re-encode, takes seconds) |
| Same as above, but with AC3/DTS/PCM/Vorbis audio | Remux the video, convert only the audio |
| Codecs the player can't decode (MPEG-4 Part 2/Xvid, MPEG-2, WMV, ProRes, HEVC without the extension…) | Low-res H.264 preview copy |

**Fast-seek preview.** OBS and phone recordings often have a keyframe only every few seconds. Every jump then has to decode from the previous keyframe, which can take up to a second. When the app sees that seeks on a file are slow, it builds a 720p preview copy in the background with a keyframe every 10 frames. You can keep working while it builds, and it swaps in when it's ready. In testing, this brought seeks on a 1080p60 file from 200–1,100 ms down to about 30–50 ms. You can turn this off in Settings.

Preview copies are deleted when you open another file or close the app. **Exports always use the original file.**

## Releases & auto-update

`.github/workflows/publish.yml` builds the app every time you **publish a GitHub Release**, and uploads the installers to that release:

| Platform | Files |
| --- | --- |
| Windows x64 | `.exe` (NSIS installer) and `.msi` |
| macOS Apple Silicon and Intel | `.dmg` and `.app.tar.gz` |
| Linux x64 | `.AppImage`, `.deb` and `.rpm` |

The workflow also uploads `latest.json` and signature files. The app's built-in updater reads `latest.json` from `https://github.com/alexanderszura/Media-Compressor/releases/latest/download/latest.json`.

### One-time setup

1. Run these on your computer:
   ```bash
   npm install
   npm run setup-updater
   ```
   This does three things:
   - Creates an update-signing key in `~/.tauri/media-compressor.key`, outside the repo.
   - Writes the matching public key into `src-tauri/tauri.conf.json`.
   - If the [GitHub CLI](https://cli.github.com) is installed and logged in, stores the private key as repository secrets. Otherwise it prints the two secrets to add under **Settings → Secrets and variables → Actions**:
     - `TAURI_SIGNING_PRIVATE_KEY`: the contents of the key file.
     - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: leave this empty.
2. Commit `src-tauri/tauri.conf.json` and push.
3. **Back up the key file.** Installed copies of the app only accept updates signed with this key. If you lose it, users would have to reinstall manually once.

### Making a release

On GitHub, go to **Releases → Draft a new release**. Create a tag like `v0.2.0`, write the release notes (the update dialog shows them), and click **Publish**. The workflow takes the version number from the tag, so you never need to edit version numbers in files. The builds take about 10–15 minutes. You can also re-run a build for an existing tag from **Actions → publish → Run workflow**.

### In the app

- **Startup check.** A few seconds after the app starts, it checks for a new version. If one exists, it shows **Update now / Later / Skip this version**.
- **Update now.** Downloads the update, verifies its signature against the key built into the app, installs it, and restarts. On Windows the installer runs in passive mode, showing a small progress window with no prompts.
- **Settings → Updates.** Turn the automatic check on or off, or check right now.
- **Dev mode.** `npm run tauri dev` never checks automatically.

### Things to know

- **The repository must be public.** The updater downloads release files without logging in.
- **Unsigned builds trigger warnings.** The builds are not code-signed with a paid certificate:
  - Windows SmartScreen will say "unrecognized app" on first install (click **More info → Run anyway**).
  - macOS will block the app until you right-click it and choose **Open**, or allow it in **System Settings → Privacy & Security**.
  - Updates themselves are still cryptographically verified.
- **Linux updates.** Auto-update only works for the AppImage. `.deb` and `.rpm` installs update through the package manager or by reinstalling.
- **Local builds.** `npm run tauri build` works without the signing key. Only CI builds produce update files.

## Notes

- **Preview audio.** Only the default audio track plays during preview. All tracks are included in the export as configured.
- **Accuracy.** Cuts are frame-accurate, because the video is always re-encoded.
- **Master mix volume.** Tracks are mixed with `amix … normalize=0`, so each track keeps its original volume. If the combined tracks are very loud, they can clip.
- **Output formats.** `.mp4` and `.mkv` are the safest. `.webm` is blocked because these encoders can't write it. With **Output format: Same as input**, an input like `.avi` or `.wmv` is saved as `.mp4`.

## Project layout

```
index.html            UI markup (editor, export settings, settings dialog)
src/main.ts           UI logic: playback, timeline, cut points, export screen
src/util.ts           Pure helpers: time formats, filename template, size math
src/types.ts          Types shared with the Rust commands
src/styles.css
src-tauri/src/lib.rs          Tauri commands: probe, export, previews, FFmpeg setup, settings
src-tauri/src/ffmpeg.rs       Builds FFmpeg arguments for exports and previews (unit tested)
src-tauri/src/media_server.rs Localhost HTTP server with byte-range support for the player
src-tauri/src/installer.rs    Downloads, verifies and extracts FFmpeg
src-tauri/tauri.release.conf.json  Extra config merged for CI release builds (updater artifacts)
scripts/setup-updater.mjs     One-time updater key setup
.github/workflows/publish.yml Release builds for Windows / macOS / Linux
```
