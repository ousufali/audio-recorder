const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron/main');
const { promises: fsPromises, existsSync, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const recorder = require('./recorder');
// electron-store is ESM; load via dynamic import when needed
let store = null;
async function initStore() {
    if (!store) {
        const mod = await import('electron-store');
        const ElectronStore = mod.default || mod;
        store = new ElectronStore({
            name: 'prefs',
            defaults: {
                savePath: path.join(os.homedir(), 'Music', 'Recordings'),
                micDevice: 'default',
                speakerDevice: 'default',
                lastFormat: 'mp3',
            },
        });
    }
    return store;
}

// Use the statically bundled ffmpeg binary
let ffmpegPath;
try {
    ffmpegPath = require('ffmpeg-static');
} catch (e) {
    ffmpegPath = null;
}
// Allow override via environment variable
if (process.env.FFMPEG_BIN || process.env.FFMPEG_PATH) {
    ffmpegPath = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH;
}

// Helper to (re)register IPC handlers safely in dev
function registerIpc(channel, handler) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
}

/** @type {import('child_process').ChildProcess | null} */
let currentRecorder = null;
let currentOutputPath = null;
let isUnifiedRecording = false;

const createWindow = () => {
    const win = new BrowserWindow({
        width: 900,
        height: 640,
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    win.once('ready-to-show', () => win.show());
    win.loadFile('index.html');
};

function ensureFfmpegAvailable() {
    if (!ffmpegPath) {
        throw new Error('FFmpeg binary not found. Please install ffmpeg-static dependency.');
    }
    return ffmpegPath;
}

function timestampFilename(prefix = 'Recording', ext = 'mp3') {
    const now = new Date();
    const ts = now
        .toISOString()
        .replace(/[:]/g, '-')
        .replace(/\..+/, '');
    return `${prefix} ${ts}.${ext}`;
}

function parseWasapiDevices(stderrStr) {
    // Parse FFmpeg -f wasapi -list_devices true output
    // We’ll collect two buckets: capture (mics) and render (speakers)
    const lines = stderrStr.split(/\r?\n/);
    /** @type {string[]} */
    const capture = [];
    /** @type {string[]} */
    const render = [];
    let mode = null; // 'capture' | 'render'
    for (const line of lines) {
        if (line.match(/Capture devices/i)) mode = 'capture';
        else if (line.match(/Render devices/i)) mode = 'render';
        const m = line.match(/"([^"]+)"/);
        if (m && mode) {
            const name = m[1];
            if (mode === 'capture') capture.push(name);
            if (mode === 'render') render.push(name);
        }
    }
    // Fallback defaults
    if (!capture.includes('default')) capture.unshift('default');
    if (!render.includes('default')) render.unshift('default');
    return { capture, render };
}

// Detect available input engines and build args accordingly
/** @type {('wasapi'|'dshow'|null)} */
let cachedEngine = null;

async function detectInputEngine() {
    if (cachedEngine) return cachedEngine;
    const bin = ensureFfmpegAvailable();
    // Try listing devices for WASAPI first; if unknown input format, fall back to dshow
    const tryEngine = (engine) => new Promise((resolve) => {
        const proc = spawn(bin, ['-hide_banner', '-f', engine, '-list_devices', 'true', '-i', 'dummy'], { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('close', () => {
            if (/Unknown input format/i.test(stderr) || /not found/i.test(stderr)) resolve(null);
            else resolve(engine);
        });
    });
    let engine = await tryEngine('wasapi');
    if (!engine) engine = await tryEngine('dshow');
    cachedEngine = engine || null;
    return cachedEngine;
}

function parseDshowDevices(stderrStr) {
    // Parse FFmpeg -f dshow -list_devices true output
    const lines = stderrStr.split(/\r?\n/);
    /** @type {string[]} */
    const capture = [];
    /** @type {string[]} */
    const render = [];
    // Common loopback/system playback device name patterns across vendors/locales
    const loopbackPatterns = [
        /virtual-audio-capturer/i,
        /stereo\s*mix/i,
        /what\s*u\s*hear/i,
        /wave\s*out\s*mix/i,
        /mixagem\s*est[eé]reo/i,
        /rec\.?\s*playback/i,
        /loopback/i,
        /voicemeeter\s*input/i,
        /cable\s*output/i,
        /speakers.*\(loopback\)/i,
    ];

    for (const line of lines) {
        // Example:  "Microphone (Realtek(R) Audio)"
        const m = line.match(/"([^\"]+)"/);
        if (m) {
            const name = m[1];
            // Heuristics: collect all audio devices as capture candidates
            capture.push(name);
            // Render heuristics: common system-loopback devices
            if (loopbackPatterns.some((rx) => rx.test(name))) {
                render.push(name);
            }
        }
    }
    if (!capture.length) capture.push('default');
    if (!render.length) render.push('default');
    return { capture, render };
}

async function listDevicesByEngine(engine) {
    const bin = ensureFfmpegAvailable();
    return new Promise((resolve) => {
        const proc = spawn(bin, ['-hide_banner', '-f', engine, '-list_devices', 'true', '-i', 'dummy'], { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('close', () => {
            try {
                if (engine === 'wasapi') return resolve(parseWasapiDevices(stderr));
                return resolve(parseDshowDevices(stderr));
            } catch {
                resolve({ capture: ['default'], render: ['default'] });
            }
        });
    });
}

function buildFfmpegArgsStart({ engine, micDevice, speakerDevice, outputPath, format = 'mp3', availableDevices }) {
    // Build args based on engine and devices
    /** @type {string[]} */
    const args = ['-hide_banner', '-y'];

    let inputs = 0;
    if (engine === 'wasapi') {
        const micInput = micDevice && micDevice !== 'default' ? micDevice : 'default';
        const spkInputBase = speakerDevice && speakerDevice !== 'default' ? speakerDevice : 'default';
        const spkInput = `${spkInputBase}:loopback`;
        // Mic
        args.push('-f', 'wasapi', '-i', micInput);
        inputs += 1;
        // Speaker
        if (speakerDevice !== null) {
            args.push('-f', 'wasapi', '-i', spkInput);
            inputs += 1;
        }
    } else if (engine === 'dshow') {
        // Map 'default' to first discovered
        const firstMic = availableDevices?.capture?.[0] || 'default';
        const loopbackRx = /virtual-audio-capturer|stereo\s*mix|what\s*u\s*hear|wave\s*out\s*mix|mixagem\s*est[eé]reo|rec\.?\s*playback|loopback|voicemeeter\s*input|cable\s*output|speakers.*\(loopback\)/i;
        const firstSpk = availableDevices?.render?.find((n) => loopbackRx.test(n))
            || availableDevices?.capture?.find((n) => /stereo\s*mix|what\s*u\s*hear/i.test(n))
            || null;
        const micName = micDevice && micDevice !== 'default' ? micDevice : firstMic;
        const spkName = speakerDevice && speakerDevice !== 'default' ? speakerDevice : firstSpk;
        // Mic
        if (micName) {
            args.push('-f', 'dshow', '-i', `audio=${micName}`);
            inputs += 1;
        }
        // Speaker (only if present)
        if (spkName) {
            args.push('-f', 'dshow', '-i', `audio=${spkName}`);
            inputs += 1;
        }
    } else {
        throw new Error('No supported FFmpeg audio input engine found (need WASAPI or DirectShow).');
    }

    // Filters and codecs
    if (inputs >= 2) {
        args.push('-filter_complex', 'amix=inputs=2:duration=longest:dropout_transition=3,aresample=async=1:first_pts=0');
    } else {
        // Single input: keep as-is, but ensure stable timestamps
        args.push('-af', 'aresample=async=1:first_pts=0');
    }

    if (format === 'wav') {
        args.push('-c:a', 'pcm_s16le');
    } else {
        args.push('-c:a', 'libmp3lame', '-b:a', '192k');
    }

    args.push(outputPath);
    return args;
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC: Preferences
registerIpc('prefs:get', async () => {
    const s = await initStore();
    return {
        savePath: s.get('savePath'),
        micDevice: s.get('micDevice'),
        speakerDevice: s.get('speakerDevice'),
        lastFormat: s.get('lastFormat'),
    };
});

registerIpc('prefs:set', async (_evt, updates) => {
    const s = await initStore();
    Object.entries(updates || {}).forEach(([k, v]) => s.set(k, v));
    return true;
});

// IPC: Choose folder
registerIpc('dialog:choose-folder', async (event, initialPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
        title: 'Choose save folder',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: initialPath || (await initStore()).get('savePath'),
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
});

// IPC: List devices via FFmpeg WASAPI
registerIpc('devices:list', async () => {
    const engine = await detectInputEngine();
    if (!engine) return { engine: null, capture: ['default'], render: ['default'] };
    const devices = await listDevicesByEngine(engine);
    return { engine, ...devices };
});

// IPC: Start recording
registerIpc('recording:start', async (_evt, payload) => {
    if (currentRecorder) {
        throw new Error('Recording already in progress');
    }
    const s = await initStore();
    // Compute output path
    const saveDir = (payload && payload.savePath) || s.get('savePath');
        try {
            if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true });
        } catch {}
    const format = 'wav'; // unified recorder outputs WAV for lossless mix
    const fileName = timestampFilename('Recording', format);
    const outPath = path.join(saveDir, fileName);
    currentOutputPath = outPath;
    // On Windows, use unified audify-based recorder (loopback + mic)
    if (process.platform === 'win32') {
        try {
            const res = await recorder.start({ outputPath: outPath });
            isUnifiedRecording = true;
            return { ok: true, outPath: res.outPath || outPath };
        } catch (e) {
            isUnifiedRecording = false;
            throw e;
        }
    }
    // Non-Windows fallback (kept for completeness): use previous FFmpeg path
    const bin = ensureFfmpegAvailable();
    const engine = await detectInputEngine();
    const devices = engine ? await listDevicesByEngine(engine) : { capture: ['default'], render: ['default'] };
    if (!engine) {
        throw new Error('Your FFmpeg binary does not support WASAPI or DirectShow inputs.');
    }
    const args = buildFfmpegArgsStart({ engine, micDevice: s.get('micDevice'), speakerDevice: s.get('speakerDevice'), outputPath: outPath, format, availableDevices: devices });
    return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { windowsHide: true });
        currentRecorder = proc;
        let started = false;
        let stderr = '';
        proc.stderr?.on('data', (chunk) => {
            const str = chunk.toString();
            stderr += str;
            if (!started && /Stream mapping|Press \[q\]/i.test(str)) {
                started = true;
                resolve({ ok: true, outPath });
            }
        });
        proc.on('error', (err) => { currentRecorder = null; reject(new Error(`FFmpeg error: ${err.message}`)); });
        proc.on('close', (code) => {
            if (!started && code !== 0) {
                currentRecorder = null;
                const snippet = stderr.split(/\r?\n/).slice(-20).join('\n');
                reject(new Error(`Failed to start recording (code ${code}).\n${snippet}`));
            }
        });
    });
});

// IPC: Stop recording
registerIpc('recording:stop', async () => {
    // If unified audify recorder is running
    if (process.platform === 'win32' && isUnifiedRecording) {
        const outPath = currentOutputPath;
        isUnifiedRecording = false;
        currentOutputPath = null;
        const res = await recorder.stop();
        return { ok: true, outPath: res?.outPath || outPath };
    }
    if (!currentRecorder) return { ok: false };
    return new Promise((resolve) => {
        const proc = currentRecorder;
        const outPath = currentOutputPath;
        currentRecorder = null;
        currentOutputPath = null;
        if (process.platform === 'win32') {
            try { proc.stdin.write('q'); } catch {}
        } else {
            proc.kill('SIGINT');
        }
        proc.on('close', () => resolve({ ok: true, outPath }));
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
    });
});

// IPC: Rename saved file
registerIpc('file:rename', async (_evt, { oldPath, newName }) => {
    const dir = path.dirname(oldPath);
    const target = path.join(dir, newName);
    try {
        await fsPromises.rename(oldPath, target);
        return { ok: true, newPath: target };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
});

// IPC: Reveal in folder
registerIpc('file:reveal', async (_evt, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
});

// --- IPC: System audio (WASAPI loopback via audify) ---
registerIpc('recorder:start', async () => {
    if (process.platform !== 'win32') {
        throw new Error('System audio recording is supported only on Windows');
    }
    const res = await recorder.start();
    return res;
});

registerIpc('recorder:stop', async () => {
    if (process.platform !== 'win32') {
        return { ok: false };
    }
    const res = await recorder.stop();
    return res;
});

// Dedicated loopback-only controls
registerIpc('loopback:start', async () => {
    if (process.platform !== 'win32') throw new Error('Loopback is supported only on Windows');
    const s = await initStore();
    const saveDir = s.get('savePath');
    try { if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true }); } catch {}
    const fileName = timestampFilename('Loopback', 'wav');
    const outPath = path.join(saveDir, fileName);
    const res = await recorder.startLoopback({ outputPath: outPath });
    return { ok: true, outPath: res?.outPath || outPath };
});
registerIpc('loopback:stop', async () => {
    if (process.platform !== 'win32') return { ok: false };
    const res = await recorder.stopLoopback();
    return res;
});

// Dedicated mic-only controls
registerIpc('mic:start', async () => {
    if (process.platform !== 'win32') throw new Error('Mic capture via audify is supported only on Windows');
    const s = await initStore();
    const saveDir = s.get('savePath');
    try { if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true }); } catch {}
    const fileName = timestampFilename('Mic', 'wav');
    const outPath = path.join(saveDir, fileName);
    const res = await recorder.startMic({ outputPath: outPath });
    return { ok: true, outPath: res?.outPath || outPath };
});
registerIpc('mic:stop', async () => {
    if (process.platform !== 'win32') return { ok: false };
    const res = await recorder.stopMic();
    return res;
});