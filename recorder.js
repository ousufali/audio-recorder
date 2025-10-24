// Windows system audio (loopback) recorder using audify (WASAPI).
// Saves to system-audio.wav in the app folder (current working directory).

const os = require('os');
const path = require('path');
const wav = require('wav');

let audify = null;
try {
  audify = require('audify');
} catch (e) {
  audify = null;
}

let rtAudio = null;       // audify.RtAudio instance
let wavWriter = null;     // wav.FileWriter
let started = false;

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

async function start() {
  assertWindows();
  if (!audify) {
    throw new Error('audify module not found. Please run: npm install audify');
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

  // Initialize RtAudio with WASAPI
  try {
    rtAudio = new audify.RtAudio(api);
  } catch (e) {
    throw new Error(`Failed to initialize RtAudio (WASAPI): ${e.message}`);
  }

  const devices = rtAudio.getDevices();
  const defaultOutId = rtAudio.getDefaultOutputDevice();
  const outDev = devices.find((d) => d.id === defaultOutId) || devices.find((d) => d.isDefaultOutput) || devices[0];
  if (!outDev) throw new Error('No audio output device found for WASAPI loopback');

  // Prefer the device preferred rate if available
  const sampleRate = outDev.preferredSampleRate || 48000;
  // Reasonable frame size (multiples of 480 for 48k): 1920 ~ 40ms
  const frameSize = 1920;

  // Prepare WAV writer
  const outPath = getOutputPath();
  wavWriter = new wav.FileWriter(outPath, { channels, sampleRate, bitDepth });

  // Open an INPUT-ONLY stream where input device is the DEFAULT OUTPUT DEVICE (WASAPI loopback)
  // RtAudio WASAPI loopback captures system playback from an output device when used as inputParameters
  const inputParams = {
    deviceId: outDev.id,
    nChannels: Math.min(Math.max(outDev.inputChannels || channels, 1), 2), // for loopback, 2 is typical
    firstChannel: 0,
  };

  // Some WASAPI loopback devices may report 0 inputChannels; still attempt with 2 channels
  if (!inputParams.nChannels || inputParams.nChannels < 1) inputParams.nChannels = 2;

  // Set input callback to write to WAV
  const onInput = (pcm) => {
    try { wavWriter.write(pcm); } catch (e) { /* ignore backpressure */ }
  };

  try {
    rtAudio.openStream(
      null, // outputParameters: output-only not needed
      inputParams,
      bitDepth === 16 ? audify.RtAudioFormat.RTAUDIO_SINT16 : audify.RtAudioFormat.RTAUDIO_FLOAT32,
      sampleRate,
      frameSize,
      'SystemLoopback',
      onInput,
      null,
      0,
      (type, msg) => console.warn('[recorder] RtAudio warning/error:', type, msg)
    );
  } catch (e) {
    throw new Error(`Failed to open RtAudio WASAPI loopback stream: ${e.message}`);
  }

  try {
    rtAudio.start();
  } catch (e) {
    try { rtAudio.closeStream(); } catch {}
    throw new Error(`Failed to start RtAudio stream: ${e.message}`);
  }

  started = true;
  console.log('[recorder] Started system audio recording (WASAPI loopback) ->', outPath);
  return { ok: true, outPath };
}

async function stop() {
  if (!started) return { ok: false };
  // Stop RtAudio stream
  try { rtAudio?.stop(); } catch {}
  try { rtAudio?.closeStream(); } catch {}

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
  rtAudio = null;
  wavWriter = null;
  started = false;

  return { ok: true, outPath };
}

module.exports = { start, stop, getOutputPath };
