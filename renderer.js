(() => {
  const $ = (sel) => document.querySelector(sel);

  // Storage controls
  const savePathInput = $('#savePath');
  const chooseFolderBtn = $('#chooseFolderBtn');

  // Loopback controls
  const lbStartBtn = $('#lbStartBtn');
  const lbStopBtn = $('#lbStopBtn');
  const lbStatus = $('#lbStatus');

  // Mic controls
  const micStartBtn = $('#micStartBtn');
  const micStopBtn = $('#micStopBtn');
  const micStatus = $('#micStatus');

  let lbActive = false;
  let micActive = false;

  const setNote = (el, msg) => { if (el) el.textContent = msg; };

  async function loadPrefs() {
    try {
      const prefs = await window.api.getPrefs();
      savePathInput.value = prefs.savePath || '';
    } catch (e) {
      setNote(lbStatus, 'Failed to load preferences');
    }
  }

  // Storage events
  chooseFolderBtn.addEventListener('click', async () => {
    const folder = await window.api.chooseFolder(savePathInput.value);
    if (folder) {
      savePathInput.value = folder;
      await window.api.setPrefs({ savePath: folder });
    }
  });

  // Loopback events
  lbStartBtn.addEventListener('click', async () => {
    if (lbActive) return;
    setNote(lbStatus, 'Starting…');
    try {
      const res = await window.recorderAPI.loopback.start();
      if (res?.ok) { lbActive = true; setNote(lbStatus, 'Recording → ' + res.outPath); }
      else setNote(lbStatus, 'Failed to start');
    } catch (e) { setNote(lbStatus, 'Error: ' + (e?.message || e)); }
  });
  lbStopBtn.addEventListener('click', async () => {
    if (!lbActive) return;
    setNote(lbStatus, 'Stopping…');
    try {
      const res = await window.recorderAPI.loopback.stop();
      lbActive = false;
      if (res?.ok) setNote(lbStatus, 'Saved: ' + res.outPath);
      else setNote(lbStatus, 'Stopped');
    } catch (e) { setNote(lbStatus, 'Error: ' + (e?.message || e)); }
  });

  // Mic events
  micStartBtn.addEventListener('click', async () => {
    if (micActive) return;
    setNote(micStatus, 'Starting…');
    try {
      const res = await window.recorderAPI.mic.start();
      if (res?.ok) { micActive = true; setNote(micStatus, 'Recording → ' + res.outPath); }
      else setNote(micStatus, 'Failed to start');
    } catch (e) { setNote(micStatus, 'Error: ' + (e?.message || e)); }
  });
  micStopBtn.addEventListener('click', async () => {
    if (!micActive) return;
    setNote(micStatus, 'Stopping…');
    try {
      const res = await window.recorderAPI.mic.stop();
      micActive = false;
      if (res?.ok) setNote(micStatus, 'Saved: ' + res.outPath);
      else setNote(micStatus, 'Stopped');
    } catch (e) { setNote(micStatus, 'Error: ' + (e?.message || e)); }
  });

  window.addEventListener('DOMContentLoaded', loadPrefs);
})();
