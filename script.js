/* ============================================================
   Video Speed Converter — application logic
   100% client-side. FFmpeg.wasm is lazy-loaded from a CDN the
   first time a conversion (or metadata probe) is needed.
   ============================================================ */

import { FFmpeg } from "https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { fetchFile, toBlobURL } from "https://unpkg.com/@ffmpeg/util@0.12.2/dist/esm/index.js";

const FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";

/* ---------------------------------------------------------------
   Constants
--------------------------------------------------------------- */

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 8];

const QUALITY_PRESETS = {
  original: { label: "Original", crf: 16, preset: "slow", audioBitrate: "320k", keepMeta: true,
    hint: "Near-lossless. Keeps source resolution, frame rate and metadata." },
  ultra:    { label: "Ultra",    crf: 16, preset: "slow",   audioBitrate: "256k", keepMeta: false,
    hint: "Visually lossless for almost all footage." },
  high:     { label: "High",     crf: 20, preset: "medium", audioBitrate: "192k", keepMeta: false,
    hint: "Great everyday quality with smaller files." },
  medium:   { label: "Medium",   crf: 24, preset: "medium", audioBitrate: "160k", keepMeta: false,
    hint: "Balanced size, noticeable but minor softness." },
  small:    { label: "Small",    crf: 30, preset: "fast",   audioBitrate: "128k", keepMeta: false,
    hint: "Smallest file, best for quick sharing." },
};

const SETTINGS_KEY = "vsc:settings";
const THEME_KEY = "vsc:theme";

/* ---------------------------------------------------------------
   DOM references
--------------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const dom = {
  themeToggle: $("themeToggle"),
  themeLabel: document.querySelector(".theme-toggle-label"),

  uploadSection: $("uploadSection"),
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  ffmpegLoadStatus: $("ffmpegLoadStatus"),
  ffmpegLoadText: $("ffmpegLoadText"),

  workspaceSection: $("workspaceSection"),
  sourceVideo: $("sourceVideo"),
  sourceMeta: $("sourceMeta"),
  speedControl: $("speedControl"),
  qualityControl: $("qualityControl"),
  qualityHint: $("qualityHint"),
  convertBtn: $("convertBtn"),
  resetBtn: $("resetBtn"),

  progressSection: $("progressSection"),
  progressBar: $("progressBar"),
  progressFill: $("progressFill"),
  progressPercent: $("progressPercent"),
  progressElapsed: $("progressElapsed"),
  progressRemaining: $("progressRemaining"),
  ffmpegLog: $("ffmpegLog"),
  cancelBtn: $("cancelBtn"),

  resultSection: $("resultSection"),
  resultVideo: $("resultVideo"),
  resultStats: $("resultStats"),
  downloadBtn: $("downloadBtn"),
  convertAnotherBtn: $("convertAnotherBtn"),

  errorBanner: $("errorBanner"),
  errorTitle: $("errorTitle"),
  errorMessage: $("errorMessage"),
  errorDismiss: $("errorDismiss"),
};

/* ---------------------------------------------------------------
   State
--------------------------------------------------------------- */

const state = {
  file: null,
  sourceURL: null,
  sourceMetadata: null,   // { width, height, fps, codec, duration, bitrate, hasAudio, size }
  speed: 1,
  quality: "original",
  ffmpeg: null,
  ffmpegLoaded: false,
  ffmpegLoadingPromise: null,
  converting: false,
  cancelled: false,
  resultURL: null,
  resultBlob: null,
  startTime: 0,
};

/* ---------------------------------------------------------------
   Utilities
--------------------------------------------------------------- */

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let val = bytes;
  let i = -1;
  do { val /= 1024; i++; } while (val >= 1024 && i < units.length - 1);
  return `${val.toFixed(val >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!isFinite(seconds) || seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatClock(ms) {
  return formatDuration(ms / 1000);
}

function speedLabel(speed) {
  return (Number.isInteger(speed) ? speed.toString() : speed.toString()) + "x";
}

function sanitizeBaseName(filename) {
  const base = filename.replace(/\.[^/.]+$/, "");
  return base.replace(/[\\/:*?"<>|]/g, "_").trim() || "video";
}

function showError(title, message) {
  dom.errorTitle.textContent = title;
  dom.errorMessage.textContent = message;
  dom.errorBanner.hidden = false;
}

function hideError() {
  dom.errorBanner.hidden = true;
}

function setSection(section, visible) {
  section.hidden = !visible;
}

/* ---------------------------------------------------------------
   Theme handling (auto / light / dark)
--------------------------------------------------------------- */

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  dom.themeToggle.setAttribute(
    "aria-label",
    `Change appearance, currently ${theme === "auto" ? "automatic" : theme}`
  );
  dom.themeLabel.textContent = theme[0].toUpperCase() + theme.slice(1);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "auto";
  applyTheme(saved);
  dom.themeToggle.addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    const current = document.documentElement.getAttribute("data-theme") || "auto";
    const next = order[(order.indexOf(current) + 1) % order.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

/* ---------------------------------------------------------------
   Settings persistence
--------------------------------------------------------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (SPEEDS.includes(parsed.speed)) state.speed = parsed.speed;
    if (QUALITY_PRESETS[parsed.quality]) state.quality = parsed.quality;
  } catch { /* ignore malformed storage */ }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ speed: state.speed, quality: state.quality }));
}

/* ---------------------------------------------------------------
   Segmented chip controls (accessible radiogroup pattern)
--------------------------------------------------------------- */

function buildChipGroup(container, items, selectedValue, onSelect) {
  container.innerHTML = "";
  const buttons = items.map(({ value, label }) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.role = "radio";
    btn.tabIndex = value === selectedValue ? 0 : -1;
    btn.setAttribute("aria-checked", String(value === selectedValue));
    btn.textContent = label;
    btn.dataset.value = value;
    btn.addEventListener("click", () => selectChip(value));
    container.appendChild(btn);
    return btn;
  });

  container.addEventListener("keydown", (e) => {
    const idx = buttons.findIndex((b) => b.tabIndex === 0);
    if (idx === -1) return;
    let nextIdx = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIdx = (idx + 1) % buttons.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIdx = (idx - 1 + buttons.length) % buttons.length;
    if (nextIdx !== null) {
      e.preventDefault();
      const val = buttons[nextIdx].dataset.value;
      selectChip(isNaN(Number(val)) ? val : Number(val));
      buttons[nextIdx].focus();
    }
  });

  function selectChip(value) {
    buttons.forEach((b) => {
      const active = String(b.dataset.value) === String(value) || Number(b.dataset.value) === value;
      b.setAttribute("aria-checked", String(active));
      b.tabIndex = active ? 0 : -1;
    });
    onSelect(value);
  }

  return { buttons, selectChip };
}

let speedChipApi, qualityChipApi;

function renderControls() {
  speedChipApi = buildChipGroup(
    dom.speedControl,
    SPEEDS.map((s) => ({ value: s, label: speedLabel(s) })),
    state.speed,
    (value) => {
      state.speed = value;
      saveSettings();
    }
  );

  qualityChipApi = buildChipGroup(
    dom.qualityControl,
    Object.entries(QUALITY_PRESETS).map(([value, cfg]) => ({ value, label: cfg.label })),
    state.quality,
    (value) => {
      state.quality = value;
      dom.qualityHint.textContent = QUALITY_PRESETS[value].hint;
      saveSettings();
    }
  );

  dom.qualityHint.textContent = QUALITY_PRESETS[state.quality].hint;
}

/* ---------------------------------------------------------------
   FFmpeg loading (lazy, cached after first load)
--------------------------------------------------------------- */

function newFFmpegInstance() {
  const ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    if (state.probeLogBuffer !== undefined) state.probeLogBuffer += message + "\n";
    if (state.converting) appendLog(message);
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (state.converting) updateProgress(Math.max(0, Math.min(1, progress || 0)));
  });
  return ffmpeg;
}

async function ensureFFmpegLoaded() {
  if (state.ffmpegLoaded && state.ffmpeg) return state.ffmpeg;
  if (state.ffmpegLoadingPromise) return state.ffmpegLoadingPromise;

  dom.ffmpegLoadStatus.hidden = false;
  dom.ffmpegLoadText.textContent = "Loading the conversion engine (first time only, ~30 MB)…";

  state.ffmpeg = newFFmpegInstance();

  state.ffmpegLoadingPromise = (async () => {
    try {
      const coreURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript");
      const wasmURL = await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm");
      await state.ffmpeg.load({ coreURL, wasmURL });
      state.ffmpegLoaded = true;
      dom.ffmpegLoadStatus.hidden = true;
      return state.ffmpeg;
    } catch (err) {
      state.ffmpegLoaded = false;
      state.ffmpeg = null;
      dom.ffmpegLoadStatus.hidden = true;
      throw err;
    } finally {
      state.ffmpegLoadingPromise = null;
    }
  })();

  return state.ffmpegLoadingPromise;
}

/* ---------------------------------------------------------------
   Metadata probing
   Runs `ffmpeg -i input` (no output) and parses the stderr log.
--------------------------------------------------------------- */

async function probeMetadata(ffmpeg, file) {
  const inputName = "probe_" + safeExt(file.name);
  await ffmpeg.writeFile(inputName, await fetchFile(file));

  state.probeLogBuffer = "";
  try {
    await ffmpeg.exec(["-i", inputName]);
  } catch {
    // ffmpeg exits non-zero when no output is given — expected, logs are what we want
  }
  const logText = state.probeLogBuffer;
  state.probeLogBuffer = undefined;

  try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }

  const durationMatch = logText.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
  const duration = durationMatch
    ? (+durationMatch[1]) * 3600 + (+durationMatch[2]) * 60 + parseFloat(durationMatch[3])
    : null;

  const bitrateMatch = logText.match(/bitrate:\s*(\d+)\s*kb\/s/);
  const bitrate = bitrateMatch ? parseInt(bitrateMatch[1], 10) : null;

  const videoMatch = logText.match(
    /Stream #\d+:\d+[^\n]*Video:\s*([\w.]+)[^\n]*?(\d{2,5})x(\d{2,5})[^\n,]*,[^\n]*?([\d.]+)\s*fps/
  );
  const codec = videoMatch ? videoMatch[1] : null;
  const width = videoMatch ? parseInt(videoMatch[2], 10) : null;
  const height = videoMatch ? parseInt(videoMatch[3], 10) : null;
  const fps = videoMatch ? parseFloat(videoMatch[4]) : null;

  const hasAudio = /Stream #\d+:\d+[^\n]*Audio:/.test(logText);

  return { duration, bitrate, codec, width, height, fps, hasAudio, size: file.size };
}

function safeExt(filename) {
  const m = filename.match(/\.([a-zA-Z0-9]+)$/);
  return "input." + (m ? m[1].toLowerCase() : "mov");
}

/* ---------------------------------------------------------------
   Audio atempo chain — atempo only accepts 0.5–2.0, so speeds
   outside that range are built by chaining multiple filters.
--------------------------------------------------------------- */

function buildAtempoChain(speed) {
  const stages = [];
  let remaining = speed;
  if (remaining > 2.0) {
    while (remaining > 2.0) {
      stages.push(2.0);
      remaining /= 2.0;
    }
    stages.push(remaining);
  } else if (remaining < 0.5) {
    while (remaining < 0.5) {
      stages.push(0.5);
      remaining /= 0.5;
    }
    stages.push(remaining);
  } else {
    stages.push(remaining);
  }
  return stages.map((f) => `atempo=${f.toFixed(6)}`).join(",");
}

/* ---------------------------------------------------------------
   File handling: drag & drop / picker
--------------------------------------------------------------- */

function wireUpload() {
  dom.dropzone.addEventListener("click", () => dom.fileInput.click());
  dom.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dom.fileInput.click();
    }
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dom.dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dom.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dom.dropzone.classList.remove("drag-over");
    })
  );
  dom.dropzone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  dom.fileInput.addEventListener("change", () => {
    const file = dom.fileInput.files && dom.fileInput.files[0];
    if (file) handleFile(file);
  });
}

async function handleFile(file) {
  hideError();

  if (!file.type.startsWith("video/") && !/\.(mov|mp4|m4v|avi|mkv|webm)$/i.test(file.name)) {
    showError("Unsupported file", "Please choose a video file (MOV, MP4, M4V, AVI, MKV, or WebM).");
    return;
  }
  const MAX_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB soft guard — wasm memory is limited
  if (file.size > MAX_SIZE) {
    showError(
      "File may be too large",
      "This file is very large for browser-based conversion and may run out of memory. Consider trimming it first."
    );
  }

  state.file = file;
  if (state.sourceURL) URL.revokeObjectURL(state.sourceURL);
  state.sourceURL = URL.createObjectURL(file);
  dom.sourceVideo.src = state.sourceURL;

  renderControls();
  setSection(dom.uploadSection, false);
  setSection(dom.workspaceSection, true);
  dom.sourceMeta.innerHTML = `<div class="meta-row"><dt>Loading details…</dt><dd></dd></div>`;

  try {
    const ffmpeg = await ensureFFmpegLoaded();
    const meta = await probeMetadata(ffmpeg, file);
    state.sourceMetadata = meta;
    renderMetadata(dom.sourceMeta, meta, file.name);
  } catch (err) {
    console.error(err);
    dom.sourceMeta.innerHTML = "";
    showError("Couldn't read video details", "The engine failed to load or inspect this file. You can still try converting it.");
  }
}

function renderMetadata(target, meta, filename) {
  const rows = [
    ["Resolution", meta.width && meta.height ? `${meta.width}×${meta.height}` : "—"],
    ["Frame rate", meta.fps ? `${meta.fps} fps` : "—"],
    ["Codec", meta.codec ? meta.codec.toUpperCase() : "—"],
    ["Duration", formatDuration(meta.duration)],
    ["Bitrate", meta.bitrate ? `${meta.bitrate} kb/s` : "—"],
    ["File size", formatBytes(meta.size)],
  ];
  target.innerHTML = rows
    .map(([k, v]) => `<div class="meta-row"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");
}

/* ---------------------------------------------------------------
   Conversion
--------------------------------------------------------------- */

function appendLog(message) {
  dom.ffmpegLog.textContent += message + "\n";
  dom.ffmpegLog.scrollTop = dom.ffmpegLog.scrollHeight;
}

function updateProgress(fraction) {
  const pct = Math.round(fraction * 100);
  dom.progressFill.style.width = pct + "%";
  dom.progressBar.setAttribute("aria-valuenow", String(pct));
  dom.progressPercent.textContent = pct + "%";

  const elapsedMs = performance.now() - state.startTime;
  dom.progressElapsed.textContent = "Elapsed " + formatClock(elapsedMs);

  if (fraction > 0.02) {
    const totalEstMs = elapsedMs / fraction;
    const remainingMs = Math.max(0, totalEstMs - elapsedMs);
    dom.progressRemaining.textContent = "About " + formatClock(remainingMs) + " remaining";
  } else {
    dom.progressRemaining.textContent = "Estimating remaining time…";
  }
}

async function startConversion() {
  if (!state.file || state.converting) return;
  hideError();

  state.converting = true;
  state.cancelled = false;
  state.startTime = performance.now();
  dom.ffmpegLog.textContent = "";
  updateProgress(0);
  dom.progressRemaining.textContent = "Estimating remaining time…";
  dom.progressElapsed.textContent = "Elapsed 0:00";

  setSection(dom.workspaceSection, false);
  setSection(dom.progressSection, true);
  setSection(dom.resultSection, false);

  try {
    const ffmpeg = await ensureFFmpegLoaded();
    const inputName = safeExt(state.file.name);
    const outputName = "output.mp4";

    await ffmpeg.writeFile(inputName, await fetchFile(state.file));

    const meta = state.sourceMetadata || {};
    const preset = QUALITY_PRESETS[state.quality];
    const speed = state.speed;
    const hasAudio = meta.hasAudio !== false;

    const videoFilter = `setpts=${(1 / speed).toFixed(6)}*PTS`;
    let filterComplex, maps;
    if (hasAudio) {
      const atempo = buildAtempoChain(speed);
      filterComplex = `[0:v]${videoFilter}[v];[0:a]${atempo}[a]`;
      maps = ["-map", "[v]", "-map", "[a]"];
    } else {
      filterComplex = `[0:v]${videoFilter}[v]`;
      maps = ["-map", "[v]"];
    }

    const args = ["-i", inputName, "-filter_complex", filterComplex, ...maps,
      "-c:v", "libx264", "-crf", String(preset.crf), "-preset", preset.preset,
      "-pix_fmt", "yuv420p"];

    if (hasAudio) {
      args.push("-c:a", "aac", "-b:a", preset.audioBitrate);
    }
    if (preset.keepMeta) {
      args.push("-map_metadata", "0");
    }
    args.push("-movflags", "+faststart", outputName);

    appendLog("$ ffmpeg " + args.join(" "));
    await ffmpeg.exec(args);

    if (state.cancelled) return;

    const data = await ffmpeg.readFile(outputName);
    const blob = new Blob([data.buffer], { type: "video/mp4" });

    try { await ffmpeg.deleteFile(inputName); } catch { /* ignore */ }
    try { await ffmpeg.deleteFile(outputName); } catch { /* ignore */ }

    state.resultBlob = blob;
    if (state.resultURL) URL.revokeObjectURL(state.resultURL);
    state.resultURL = URL.createObjectURL(blob);

    finishConversion(blob);
  } catch (err) {
    if (state.cancelled) {
      // user-initiated cancel — already handled in cancelConversion()
      return;
    }
    console.error(err);
    state.converting = false;
    setSection(dom.progressSection, false);
    setSection(dom.workspaceSection, true);

    const msg = String(err && err.message || err || "");
    if (/memory|out of bounds|allocation/i.test(msg)) {
      showError("Ran out of memory", "This video may be too large or too high-resolution for your browser to process. Try a shorter clip or a smaller quality preset.");
    } else if (/SharedArrayBuffer|cross-origin/i.test(msg)) {
      showError("Engine failed to load", "Your browser blocked a required feature. Try Chrome, Edge, or Firefox with default security settings.");
    } else {
      showError("Conversion failed", "The video may be corrupted or in an unsupported format. Try a different file.");
    }
  }
}

function finishConversion(blob) {
  state.converting = false;
  setSection(dom.progressSection, false);
  setSection(dom.resultSection, true);

  dom.resultVideo.src = state.resultURL;

  const oldSize = state.file.size;
  const newSize = blob.size;
  const ratio = oldSize > 0 ? (newSize / oldSize) : 1;
  const elapsed = performance.now() - state.startTime;

  const rows = [
    ["Original size", formatBytes(oldSize)],
    ["New size", formatBytes(newSize)],
    ["Compression ratio", `${(ratio * 100).toFixed(0)}% of original`],
    ["Processing time", formatClock(elapsed)],
    ["Speed applied", speedLabel(state.speed)],
    ["Quality preset", QUALITY_PRESETS[state.quality].label],
  ];
  dom.resultStats.innerHTML = rows
    .map(([k, v]) => `<div class="meta-row"><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("");

  const base = sanitizeBaseName(state.file.name);
  const filename = `${base}_${speedLabel(state.speed)}.mp4`;
  dom.downloadBtn.href = state.resultURL;
  dom.downloadBtn.download = filename;
}

async function cancelConversion() {
  if (!state.converting) return;
  state.cancelled = true;
  state.converting = false;

  try {
    if (state.ffmpeg) state.ffmpeg.terminate();
  } catch { /* ignore */ }
  // terminate() kills the worker permanently — force a clean reload next time
  state.ffmpeg = null;
  state.ffmpegLoaded = false;

  setSection(dom.progressSection, false);
  setSection(dom.workspaceSection, true);
}

/* ---------------------------------------------------------------
   Reset
--------------------------------------------------------------- */

function resetAll() {
  state.file = null;
  state.sourceMetadata = null;
  if (state.sourceURL) URL.revokeObjectURL(state.sourceURL);
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.sourceURL = null;
  state.resultURL = null;
  state.resultBlob = null;

  dom.sourceVideo.removeAttribute("src");
  dom.resultVideo.removeAttribute("src");
  dom.fileInput.value = "";
  hideError();

  setSection(dom.resultSection, false);
  setSection(dom.progressSection, false);
  setSection(dom.workspaceSection, false);
  setSection(dom.uploadSection, true);
}

/* ---------------------------------------------------------------
   Keyboard shortcuts
--------------------------------------------------------------- */

function wireKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "button") {
      // still allow Escape/Enter to pass through globally for cancel/convert
      if (e.key !== "Escape" && e.key !== "Enter") return;
    }

    if (e.key === " " && !dom.workspaceSection.hidden) {
      e.preventDefault();
      if (dom.sourceVideo.paused) dom.sourceVideo.play();
      else dom.sourceVideo.pause();
    } else if (e.key === "Enter" && !dom.workspaceSection.hidden && !state.converting) {
      startConversion();
    } else if (e.key === "Escape" && state.converting) {
      cancelConversion();
    }
  });
}

/* ---------------------------------------------------------------
   Init
--------------------------------------------------------------- */

function init() {
  initTheme();
  loadSettings();
  wireUpload();
  wireKeyboardShortcuts();

  dom.convertBtn.addEventListener("click", startConversion);
  dom.resetBtn.addEventListener("click", resetAll);
  dom.cancelBtn.addEventListener("click", cancelConversion);
  dom.convertAnotherBtn.addEventListener("click", resetAll);
  dom.errorDismiss.addEventListener("click", hideError);
}

init();
