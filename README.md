# Video Speed Converter

Change the playback speed of a video and export it to MP4 — entirely inside your browser. Nothing is uploaded to a server; there is no backend at all.

Built for the common case of iPhone `.MOV` files that need to be sped up or slowed down and turned into a normal `.mp4`.

## Files

```
index.html   — page structure and markup
style.css    — Apple-inspired glass UI, light/dark/auto theming
script.js    — all app logic + FFmpeg.wasm integration
README.md    — this file
```

There is no build step, no `package.json`, and no Node.js dependency. `script.js` is a native ES module that imports FFmpeg.wasm directly from a CDN (unpkg) at runtime, in the user's browser.

## Hosting on GitHub Pages

1. Create a new GitHub repository (or use an existing one).
2. Add these four files to the repository root (or to a `/docs` folder if you prefer).
3. Commit and push.
4. In the repo, go to **Settings → Pages**.
5. Under **Build and deployment**, set **Source** to "Deploy from a branch", pick your branch (e.g. `main`) and the folder (`/` or `/docs`).
6. Save. GitHub will publish the site at `https://<your-username>.github.io/<repo-name>/`.
7. Open that URL — the first time you convert a video, the browser will download the FFmpeg core (~30 MB) from the CDN; after that it's cached for repeat visits.

No server configuration, environment variables, or secrets are required. Because the project uses the **single-threaded** FFmpeg.wasm core, it does not need the special `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` headers that the multi-threaded core requires — which is important because GitHub Pages does not let you set custom response headers.

## How it works

- **FFmpeg.wasm** compiles the real FFmpeg C codebase to WebAssembly and runs it inside a Web Worker in your browser. This app lazy-loads it only when you actually add a video, so the initial page load stays instant.
- **Speed change**: video frames are re-timed with FFmpeg's `setpts` filter; audio is re-timed with `atempo`, which corrects pitch/duration together so audio doesn't drift out of sync. `atempo` only accepts factors between 0.5x and 2x per instance, so speeds outside that range (e.g. 4x or 0.25x) are built by chaining multiple `atempo` filters together (e.g. 4x = `atempo=2.0,atempo=2.0`).
- **Metadata probing**: before you touch any settings, the app runs FFmpeg once with no output file just to read its console log, which is where resolution, frame rate, codec, duration, and bitrate are parsed from.
- **Encoding**: output is always H.264 video in an MP4 container with AAC audio, `+faststart` enabled for instant web playback, and the CRF for the chosen quality preset. "Original" additionally preserves source metadata and uses a lower CRF (16) with the `slow` preset for a near-lossless result.
- **Progress**: FFmpeg reports encoding progress internally; the app converts that into a percentage, elapsed time, and an estimated time remaining, and mirrors FFmpeg's own console log in a collapsible panel.
- Your file is written into the WebAssembly module's virtual, in-memory filesystem — it is never sent anywhere over the network.

## Quality presets

| Preset   | CRF | Preset speed | Notes                                              |
|----------|-----|--------------|-----------------------------------------------------|
| Original | 16  | slow         | Keeps source resolution/frame rate, copies metadata, 320 kb/s audio |
| Ultra    | 16  | slow         | Visually lossless, no metadata copy                 |
| High     | 20  | medium       | Strong everyday quality                             |
| Medium   | 24  | medium       | Balanced size/quality                               |
| Small    | 30  | fast         | Smallest files, fastest encode                      |

Lower CRF = higher quality and larger files. "slow"/"medium"/"fast" trade encoding time for compression efficiency — slower presets take longer to encode but compress more efficiently at the same CRF.

## Browser compatibility

Requires a modern browser with WebAssembly and ES module support:

- ✅ Chrome / Edge (recommended — fastest WASM performance)
- ✅ Firefox
- ✅ Safari 16.4+ (desktop and iOS/iPadOS)
- ⚠️ Older or highly locked-down browsers may block the WebAssembly module or the CDN import; try an updated browser if the engine fails to load.

Mobile Safari and Chrome on Android work, but WebAssembly memory limits on phones are tighter than on desktop — very large or very high-resolution files are more likely to run out of memory on a phone.

## Known limitations

- **Single-threaded encoding.** Because the app avoids the cross-origin isolation headers GitHub Pages can't provide, it uses the single-core FFmpeg build. Encoding is correspondingly slower than a native desktop encoder, especially with the `slow` preset on long or high-resolution videos.
- **Browser memory ceiling.** WebAssembly (32-bit) has a hard memory ceiling of roughly 2–4 GB depending on the browser. Very large source files (very long recordings, or 4K/8K footage) can exhaust available memory and fail. If that happens, try trimming the clip first or choosing a smaller quality preset.
- **No hardware-accelerated encoding.** All encoding is done in software (libx264) inside WebAssembly, so it will be slower than your phone's or computer's native hardware encoder.
- **Extreme speeds and audio.** At very extreme speed factors (e.g. 8x), chained `atempo` stages keep pitch correct, but very short audio segments can occasionally sound slightly choppy — this is a property of extreme time-stretching, not a bug in the tool.
- **First load requires internet access** to fetch the ~30 MB FFmpeg core from the CDN. After that first successful load, most browsers cache it for subsequent visits, but a hard cache clear will require re-downloading it.
- **No timeline trimming or cropping.** This tool only changes speed and re-encodes to MP4; it doesn't currently support cutting sections out of a video.

## Privacy

Your video file is read directly from disk into browser memory and processed by WebAssembly running locally. At no point is the file, or any part of it, transmitted to any server — the only network requests this app makes are to fetch the FFmpeg engine itself from the CDN the first time it's needed.
