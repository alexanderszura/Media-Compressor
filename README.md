# Media Compressor

A small Tauri v2 desktop app (TypeScript + Rust) for trimming a video and compressing it with FFmpeg. The trim screen is modeled on LosslessCut.

## Requirements

- **Node.js** 18 or newer
- **Rust** (stable), installed with [rustup](https://rustup.rs). On Windows you also need the MSVC build tools, which come with "Desktop development with C++" in the Visual Studio Build Tools installer. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- **FFmpeg** (`ffmpeg` and `ffprobe`). Version 5.1 or newer is recommended.
  - Windows: `winget install Gyan.FFmpeg`, then restart your terminal. Or unzip a build and set its `bin` folder in **Settings → FFmpeg folder**.
  - The app looks for FFmpeg in three places, in this order: the folder set in Settings, the folder next to the app's `.exe`, then `PATH`.

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
cd src-tauri && cargo test     # FFmpeg arg builder, plus a real end-to-end encode if ffmpeg is on PATH
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
5. Click **Export**. The file is written to the **same folder as the input**, using the new name. If the file already exists, you have to click Export a second time to overwrite it. The app never overwrites the original file.

### Keyboard

| Key | Action |
| --- | --- |
| `I` / `O` | Set cut start / cut end |
| `Space` | Play / pause |
| `←` / `→` | Seek 1 s (`Shift` = 10 s) |
| `,` / `.` or `Ctrl+←/→` | Previous / next frame |
| `Home` / `End` | Jump to start / end |
| `M` | Mute |
| `Enter` | Next (go to export settings) |
| `Esc` | Back / close dialog |
| `Ctrl` + mouse wheel on timeline | Zoom |

### Filename format variables

| Variable | Example |
| --- | --- |
| `${FILENAME}` | `Game Clip` (no extension) |
| `${EXT}` | `.mp4` (includes the dot) |
| `${CUT_FROM}` | `00.01.05.250` |
| `${CUT_TO}` | `00.02.10.000` |

The default format is `${FILENAME}-CUT${EXT}`. Characters that Windows doesn't allow in file names are replaced with `_`.

Settings are saved to `%APPDATA%\com.aszura.mediacompressor\settings.json`.

## Notes

- **Preview.** The video plays in the system webview (WebView2 on Windows). WebView2 can't decode some files, for example HEVC without the HEVC extension, or some MKV and AVI files. For those, the app automatically uses FFmpeg to make a temporary low-res H.264 preview copy. Cut times still apply to the original file.
- **Preview audio.** Only the default audio track plays during preview. All tracks are included in the export as configured.
- **Accuracy.** Cuts are frame-accurate, because the video is always re-encoded.
- **Master mix volume.** Tracks are mixed with `amix … normalize=0`, so each track keeps its original volume. If the combined tracks are very loud, they can clip.
- **Output formats.** `.mp4` and `.mkv` are the safest. `.webm` is blocked because these encoders can't write it.

## Project layout

```
index.html            UI markup (editor, export settings, settings dialog)
src/main.ts           UI logic: playback, timeline, cut points, export screen
src/util.ts           Pure helpers: time formats, filename template, size math
src/types.ts          Types shared with the Rust commands
src/styles.css
src-tauri/src/lib.rs     Tauri commands: probe, export, preview proxy, settings, cancel
src-tauri/src/ffmpeg.rs  Builds FFmpeg arguments (unit tested)
```
