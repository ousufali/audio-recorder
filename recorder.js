// Windows system audio (loopback) recorder using audify (WASAPI).
// Saves to system-audio.wav in the app folder (current working directory).

const path = require('path');
const wav = require('wav');
const audify = require('audify');


let rtLoopback = null;    // audify.RtAudio instance for loopback (default output device)
let rtMic = null;         // audify.RtAudio instance for microphone (default input device)
let wavWriter = null;     // wav.FileWriter
let started = false;
let qLoop = [];
let qMic = [];
let sampleRateInUse = 48000;
let channelsInUse = 2;

function getOutputPath() {
  // Requirement: save as system-audio.wav in the app folder.
  // We'll use the current working directory, which is where the app is started from in dev.
  // In production, this may be read-only (ASAR), but this matches the requirement.
  return path.resolve(process.cwd(), 'system-audio.wav');
}

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new Error('System audio recording is supported only on Windows');
  }
}

function mixInt16Stereo(bufA, bufB) {
  const len = Math.min(bufA.length, bufB.length);
  const out = Buffer.allocUnsafe(len);
  // 16-bit samples
  for (let i = 0; i < len; i += 2) {
    const a = bufA.readInt16LE(i);
    const b = bufB.readInt16LE(i);
    let s = (a + b) >> 1; // average to reduce clipping
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    out.writeInt16LE(s, i);
  }
  return out;
}

function pumpMix() {
  // Mix available buffers; if one side missing, pad with silence of the other's size
  while (qLoop.length || qMic.length) {
    let a = qLoop[0];
    let b = qMic[0];
    if (!a && !b) break;
    if (a && !b) {
      // pad mic with silence
      b = Buffer.allocUnsafe(a.length); b.fill(0);
      qLoop.shift();
      const mixed = mixInt16Stereo(a, b);
      try { wavWriter.write(mixed); } catch { }
    } else if (!a && b) {
      // pad loopback with silence
      a = Buffer.allocUnsafe(b.length); a.fill(0);
      qMic.shift();
      const mixed = mixInt16Stereo(a, b);
      try { wavWriter.write(mixed); } catch { }
    } else {
      // both available; if sizes differ, mix min and push remainder back to front
      if (a.length === b.length) {
        qLoop.shift(); qMic.shift();
        const mixed = mixInt16Stereo(a, b);
        try { wavWriter.write(mixed); } catch { }
      } else {
        const minLen = Math.min(a.length, b.length);
        const aPart = a.subarray(0, minLen);
        const bPart = b.subarray(0, minLen);
        const mixed = mixInt16Stereo(aPart, bPart);
        try { wavWriter.write(mixed); } catch { }
        if (a.length > minLen) qLoop[0] = a.subarray(minLen);
        else qLoop.shift();
        if (b.length > minLen) qMic[0] = b.subarray(minLen);
        else qMic.shift();
      }
    }
  }
}

async function start(opts = {}) {
  assertWindows();
  if (!audify) {
    throw new Error('audify module not found.');
  }
  if (started) {
    throw new Error('Recording already in progress');
  }

  // Configure audio format
  const channels = 2;
  const bitDepth = 16; // 16-bit PCM

  let api = audify.RtAudioApi && audify.RtAudioApi.WINDOWS_WASAPI;
  if (api === undefined) {
    throw new Error('audify RtAudioApi.WINDOWS_WASAPI not available');
  }

  // Initialize RtAudio with WASAPI (two instances)
  try {
    rtLoopback = new audify.RtAudio(api);
    rtMic = new audify.RtAudio(api);
  } catch (e) {
    throw new Error(`Failed to initialize RtAudio (WASAPI): ${e.message}`);
  }

  const devicesOut = rtLoopback.getDevices();
  const devicesIn = rtMic.getDevices();
  const defaultOutId = rtLoopback.getDefaultOutputDevice();
  const defaultInId = rtMic.getDefaultInputDevice();
  const outDev = devicesOut.find((d) => d.id === defaultOutId) || devicesOut.find((d) => d.isDefaultOutput) || devicesOut[0];
  const inDev = devicesIn.find((d) => d.id === defaultInId) || devicesIn.find((d) => d.isDefaultInput) || devicesIn[0];
  if (!outDev) throw new Error('No audio output device found for WASAPI loopback');
  if (!inDev) throw new Error('No microphone (input) device found');

  // Prefer the device preferred rate if available
  const sampleRate = outDev.preferredSampleRate || inDev.preferredSampleRate || 48000;
  sampleRateInUse = sampleRate;
  // Reasonable frame size (multiples of 480 for 48k): 1920 ~ 40ms
  const frameSize = 1920;

  // Prepare WAV writer
  const outPath = opts.outputPath || getOutputPath();
  channelsInUse = channels;
  wavWriter = new wav.FileWriter(outPath, { channels, sampleRate, bitDepth });

  // Open an INPUT-ONLY stream where input device is the DEFAULT OUTPUT DEVICE (WASAPI loopback)
  // RtAudio WASAPI loopback captures system playback from an output device when used as inputParameters
  const loopParams = {
    deviceId: outDev.id,
    nChannels: 2,
    firstChannel: 0,
  };

  const micParams = {
    deviceId: inDev.id,
    nChannels: Math.min(Math.max(inDev.inputChannels || 1, 1), 2),
    firstChannel: 0,
  };
  if (!micParams.nChannels || micParams.nChannels < 1) micParams.nChannels = 1;

  // Set input callback to write to WAV
  const onLoop = (pcm) => {
    qLoop.push(Buffer.from(pcm));
    pumpMix();
  };
  const onMic = (pcm) => {
    // If mic is mono, duplicate channels to stereo for mixing
    let buf = Buffer.from(pcm);
    if (micParams.nChannels === 1) {
      // duplicate mono to stereo
      const samples = buf.length / 2;
      const stereo = Buffer.allocUnsafe(samples * 4);
      for (let i = 0, o = 0; i < buf.length; i += 2, o += 4) {
        const v = buf.readInt16LE(i);
        stereo.writeInt16LE(v, o);
        stereo.writeInt16LE(v, o + 2);
      }
      buf = stereo;
    }
    qMic.push(buf);
    pumpMix();
  };

  try {
    rtLoopback.openStream(
      null,
      loopParams,
      bitDepth === 16 ? audify.RtAudioFormat.RTAUDIO_SINT16 : audify.RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      frameSize,
      'SystemLoopback',
      onLoop,
      null,
      0,
      (type, msg) => console.warn('[recorder] RtAudio warning/error:', type, msg)
    );
    rtMic.openStream(
      null,
      micParams,
      bitDepth === 16 ? audify.RtAudioFormat.RTAUDIO_SINT16 : audify.RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      frameSize,
      'MicCapture',
      onMic,
      null,
      0,
      (type, msg) => console.warn('[recorder] RtAudio mic warning/error:', type, msg)
    );
  } catch (e) {
    throw new Error(`Failed to open RtAudio WASAPI loopback stream: ${e.message}`);
  }

  try {
    rtLoopback.start();
    rtMic.start();
  } catch (e) {
    try { rtLoopback.closeStream(); } catch { }
    try { rtMic.closeStream(); } catch { }
    throw new Error(`Failed to start RtAudio stream: ${e.message}`);
  }

  started = true;
  console.log('[recorder] Started system audio recording (WASAPI loopback) ->', outPath);
  return { ok: true, outPath };
}

async function stop() {
  if (!started) return { ok: false };
  // Stop RtAudio stream
  try { rtLoopback?.stop(); } catch { }
  try { rtLoopback?.closeStream(); } catch { }
  try { rtMic?.stop(); } catch { }
  try { rtMic?.closeStream(); } catch { }

  // Finish WAV writer
  await new Promise((resolve) => {
    try {
      wavWriter.end(() => resolve());
    } catch {
      resolve();
    }
  });

  const outPath = getOutputPath();
  console.log('[recorder] Stopped recording. Saved ->', outPath);

  // Reset state
  rtLoopback = null;
  rtMic = null;
  wavWriter = null;
  started = false;
  qLoop = [];
  qMic = [];

  return { ok: true, outPath };
}

// --- Separate simple recorders ---
let lbWriter = null, lbStarted = false, lbOutPath = null, lbRt = null;
async function startLoopback(opts = {}) {
  assertWindows();
  if (!audify) {
    throw new Error('audify module not found.');
  }
  if (lbStarted) throw new Error('Loopback recording already in progress');
  const api = audify.RtAudioApi && audify.RtAudioApi.WINDOWS_WASAPI;
  if (api === undefined) throw new Error('audify RtAudioApi.WINDOWS_WASAPI not available');
  lbRt = new audify.RtAudio(api);
  const devices = lbRt.getDevices();
  const outDev = devices.find((d) => d.id === lbRt.getDefaultOutputDevice()) || devices.find((d) => d.isDefaultOutput) || devices[0];
  if (!outDev) throw new Error('No output device for loopback');
  const sampleRate = outDev.preferredSampleRate || 48000;
  const frameSize = 1920;
  const channels = 2, bitDepth = 16;
  lbOutPath = opts.outputPath || path.resolve(process.cwd(), `Loopback ${new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '')}.wav`);
  lbWriter = new wav.FileWriter(lbOutPath, { channels, sampleRate, bitDepth });
  const loopParams = { deviceId: outDev.id, nChannels: 2, firstChannel: 0 };
  const onLoop = (pcm) => { try { lbWriter.write(pcm); } catch { } };
  lbRt.openStream(null, loopParams, audify.RtAudioFormat.RTAUDIO_SINT16, sampleRate, frameSize, 'LoopbackOnly', onLoop, null, 0, (t, m) => console.warn('[loopback] warn:', t, m));
  lbRt.start();
  lbStarted = true;
  console.log('[recorder] Loopback started ->', lbOutPath);
  return { ok: true, outPath: lbOutPath };
}
async function stopLoopback() {
  if (!lbStarted) return { ok: false };
  try { lbRt?.stop(); } catch { }
  try { lbRt?.closeStream(); } catch { }
  await new Promise((r) => { try { lbWriter.end(() => r()); } catch { r(); } });
  console.log('[recorder] Loopback saved ->', lbOutPath);
  const p = lbOutPath;
  lbRt = null; lbWriter = null; lbStarted = false; lbOutPath = null;
  return { ok: true, outPath: p };
}

let micWriter = null, micStarted = false, micOutPath = null, micRt = null;
async function startMic(opts = {}) {
  assertWindows();
  if (!audify) {
    throw new Error('audify module not found.');
  }
  if (micStarted) throw new Error('Mic recording already in progress');
  const api = audify.RtAudioApi && audify.RtAudioApi.WINDOWS_WASAPI;
  if (api === undefined) throw new Error('audify RtAudioApi.WINDOWS_WASAPI not available');
  micRt = new audify.RtAudio(api);
  const devices = micRt.getDevices();
  const inDev = devices.find((d) => d.id === micRt.getDefaultInputDevice()) || devices.find((d) => d.isDefaultInput) || devices[0];
  if (!inDev) throw new Error('No microphone input device found');
  const sampleRate = inDev.preferredSampleRate || 48000;
  const frameSize = 1920;
  // If device is mono, we’ll still write stereo WAV duplicating channels
  const bitDepth = 16; let channels = inDev.inputChannels >= 2 ? 2 : 2;
  micOutPath = opts.outputPath || path.resolve(process.cwd(), `Mic ${new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '')}.wav`);
  micWriter = new wav.FileWriter(micOutPath, { channels, sampleRate, bitDepth });
  const micParams = { deviceId: inDev.id, nChannels: Math.max(inDev.inputChannels || 1, 1), firstChannel: 0 };
  const onMic = (pcm) => {
    let buf = Buffer.from(pcm);
    if (micParams.nChannels === 1) {
      const samples = buf.length / 2; const stereo = Buffer.allocUnsafe(samples * 4);
      for (let i = 0, o = 0; i < buf.length; i += 2, o += 4) { const v = buf.readInt16LE(i); stereo.writeInt16LE(v, o); stereo.writeInt16LE(v, o + 2); }
      buf = stereo;
    }
    try { micWriter.write(buf); } catch { }
  };
  micRt.openStream(null, micParams, audify.RtAudioFormat.RTAUDIO_SINT16, sampleRate, frameSize, 'MicOnly', onMic, null, 0, (t, m) => console.warn('[mic] warn:', t, m));
  micRt.start();
  micStarted = true;
  console.log('[recorder] Mic started ->', micOutPath);
  return { ok: true, outPath: micOutPath };
}
async function stopMic() {
  if (!micStarted) return { ok: false };
  try { micRt?.stop(); } catch { }
  try { micRt?.closeStream(); } catch { }
  await new Promise((r) => { try { micWriter.end(() => r()); } catch { r(); } });
  console.log('[recorder] Mic saved ->', micOutPath);
  const p = micOutPath;
  micRt = null; micWriter = null; micStarted = false; micOutPath = null;
  return { ok: true, outPath: p };
}

module.exports = { start, stop, getOutputPath, startLoopback, stopLoopback, startMic, stopMic };
