const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron/main');
const { promises: fsPromises, existsSync, mkdirSync } = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
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

// Helper to (re)register IPC handlers safely in dev
function registerIpc(channel, handler) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, handler);
}

/** @type {import('child_process').ChildProcess | null} */
let currentRecorder = null;
let currentOutputPath = null;

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

function buildFfmpegArgsStart({ micDevice, speakerDevice, outputPath, format = 'mp3' }) {
    // Mix mic + speaker (loopback) into one track using amix
    // WASAPI devices: use plain name; append :loopback for speaker
    const micInput = micDevice && micDevice !== 'default' ? micDevice : 'default';
    const spkInputBase = speakerDevice && speakerDevice !== 'default' ? speakerDevice : 'default';
    const spkInput = `${spkInputBase}:loopback`;

    /** @type {string[]} */
    const args = [
        '-hide_banner',
        '-y',
        // Mic input
        '-f', 'wasapi',
        '-i', micInput,
        // Speaker loopback input
        '-f', 'wasapi',
        '-i', spkInput,
        // Mix to 2 inputs
        '-filter_complex', 'amix=inputs=2:duration=longest:dropout_transition=3,aresample=async=1:first_pts=0',
    ];

    if (format === 'wav') {
        args.push('-c:a', 'pcm_s16le');
    } else {
        // default mp3
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
    const bin = ensureFfmpegAvailable();
    return new Promise((resolve) => {
        const proc = spawn(bin, ['-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy'], {
            windowsHide: true,
        });
        let stderr = '';
        proc.stderr.on('data', (d) => (stderr += d.toString()));
        proc.on('close', () => {
            try {
                const parsed = parseWasapiDevices(stderr);
                resolve(parsed);
            } catch (e) {
                resolve({ capture: ['default'], render: ['default'] });
            }
        });
    });
});

// IPC: Start recording
registerIpc('recording:start', async (_evt, payload) => {
    if (currentRecorder) {
        throw new Error('Recording already in progress');
    }
    const bin = ensureFfmpegAvailable();
    const s = await initStore();
    // Compute output path
    const saveDir = (payload && payload.savePath) || s.get('savePath');
        try {
            if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true });
        } catch {}
    const format = (payload && payload.format) || s.get('lastFormat') || 'mp3';
    const fileName = timestampFilename('Recording', format);
    const outPath = path.join(saveDir, fileName);
    currentOutputPath = outPath;

    const args = buildFfmpegArgsStart({
        micDevice: payload?.micDevice || s.get('micDevice'),
        speakerDevice: payload?.speakerDevice || s.get('speakerDevice'),
        outputPath: outPath,
        format,
    });

    return new Promise((resolve, reject) => {
        const proc = spawn(bin, args, { windowsHide: true });
        currentRecorder = proc;
        let started = false;
        let stderr = '';
        proc.stdout?.on('data', () => {});
        proc.stderr?.on('data', (chunk) => {
            const str = chunk.toString();
            stderr += str;
            // Consider the process started once both inputs are initialized
            if (!started && /Stream mapping|Press \[q\]/i.test(str)) {
                started = true;
                resolve({ ok: true, outPath });
            }
        });
        proc.on('error', (err) => {
            currentRecorder = null;
            reject(new Error(`FFmpeg error: ${err.message}`));
        });
        proc.on('close', (code) => {
            // If it closed quickly and never started, reject
            if (!started && code !== 0) {
                currentRecorder = null;
                const snippet = stderr.split(/\r?\n/).slice(-15).join('\n');
                reject(new Error(`Failed to start recording (code ${code}).\n${snippet}`));
            }
        });
    });
});

// IPC: Stop recording
registerIpc('recording:stop', async () => {
    if (!currentRecorder) return { ok: false };
    return new Promise((resolve) => {
        const proc = currentRecorder;
        const outPath = currentOutputPath;
        currentRecorder = null;
        currentOutputPath = null;
        // Politely ask FFmpeg to quit
        if (process.platform === 'win32') {
            // On Windows, send 'q' to stdin to gracefully stop
            try {
                proc.stdin.write('q');
            } catch {}
        } else {
            proc.kill('SIGINT');
        }
        proc.on('close', () => {
            resolve({ ok: true, outPath });
        });
        setTimeout(() => {
            // Fallback hard kill if stuck
            try { proc.kill('SIGKILL'); } catch {}
        }, 3000);
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