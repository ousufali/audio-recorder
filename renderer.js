(() => {
  const $ = (sel) => document.querySelector(sel);

  const micSelect = $('#micSelect');
  const spkSelect = $('#spkSelect');
  const savePathInput = $('#savePath');
  const chooseFolderBtn = $('#chooseFolderBtn');
  const formatSelect = $('#formatSelect');
  const recordBtn = $('#recordBtn');
  const timerEl = $('#timer');
  const statusEl = $('#status');
  const afterSaveEl = $('#afterSave');
  const savedPathEl = $('#savedPath');
  const renameInput = $('#renameInput');
  const revealBtn = $('#revealBtn');

  let isRecording = false;
  let timerHandle = null;
  let startedAt = null;
  let lastSavedPath = null;

  function setStatus(msg, ok = true) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('hidden', !msg);
    statusEl.classList.toggle('bg-green-50', ok);
    statusEl.classList.toggle('text-green-800', ok);
    statusEl.classList.toggle('bg-red-50', !ok);
    statusEl.classList.toggle('text-red-800', !ok);
  }

  function updateTimer() {
    if (!startedAt) {
      timerEl.textContent = '00:00:00';
      return;
    }
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    timerEl.textContent = `${h}:${m}:${s}`;
  }

  async function loadPrefsAndDevices() {
    try {
      const prefs = await window.api.getPrefs();
      const devices = await window.api.listDevices();
      // Populate selects
      function fillSelect(select, items) {
        select.innerHTML = '';
        items.forEach((name) => {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          select.appendChild(opt);
        });
      }
      fillSelect(micSelect, devices.capture || ['default']);
      fillSelect(spkSelect, devices.render || ['default']);

      // Apply prefs
      micSelect.value = prefs.micDevice || 'default';
      spkSelect.value = prefs.speakerDevice || 'default';
      savePathInput.value = prefs.savePath || '';
      formatSelect.value = prefs.lastFormat || 'mp3';
    } catch (e) {
      setStatus('Failed to load devices or preferences', false);
    }
  }

  async function startRecording() {
    const payload = {
      micDevice: micSelect.value,
      speakerDevice: spkSelect.value,
      savePath: savePathInput.value,
      format: formatSelect.value,
    };
    await window.api.setPrefs({
      micDevice: payload.micDevice,
      speakerDevice: payload.speakerDevice,
      savePath: payload.savePath,
      lastFormat: payload.format,
    });
    setStatus('Starting…');
    const res = await window.api.startRecording(payload);
    if (res?.ok) {
      isRecording = true;
      startedAt = Date.now();
      timerHandle = setInterval(updateTimer, 500);
      updateTimer();
      recordBtn.textContent = 'Stop Recording';
      recordBtn.classList.remove('bg-indigo-600', 'hover:bg-indigo-700');
      recordBtn.classList.add('bg-red-600', 'hover:bg-red-700');
      afterSaveEl.classList.add('hidden');
      setStatus('Recording…');
    } else {
      setStatus('Failed to start recording', false);
    }
  }

  async function stopRecording() {
    setStatus('Stopping…');
    const res = await window.api.stopRecording();
    isRecording = false;
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
    startedAt = null;
    updateTimer();
    recordBtn.textContent = 'Start Recording';
    recordBtn.classList.add('bg-indigo-600', 'hover:bg-indigo-700');
    recordBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
    if (res?.ok && res?.outPath) {
      lastSavedPath = res.outPath;
      savedPathEl.textContent = res.outPath;
      savedPathEl.title = res.outPath;
      renameInput.value = res.outPath.split(/\\|\//).pop();
      afterSaveEl.classList.remove('hidden');
      setStatus('Saved successfully');
    } else {
      setStatus('Stopped (no file saved)', false);
    }
  }

  // Event wiring
  chooseFolderBtn.addEventListener('click', async () => {
    const folder = await window.api.chooseFolder(savePathInput.value);
    if (folder) {
      savePathInput.value = folder;
      await window.api.setPrefs({ savePath: folder });
    }
  });

  recordBtn.addEventListener('click', async () => {
    if (isRecording) await stopRecording();
    else await startRecording();
  });

  revealBtn.addEventListener('click', async () => {
    if (lastSavedPath) await window.api.revealFile(lastSavedPath);
  });

  renameInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && lastSavedPath) {
      const newName = renameInput.value.trim();
      if (!newName) return;
      const res = await window.api.renameFile(lastSavedPath, newName);
      if (res?.ok) {
        lastSavedPath = res.newPath;
        savedPathEl.textContent = res.newPath;
        savedPathEl.title = res.newPath;
        setStatus('Renamed');
      } else {
        setStatus('Rename failed: ' + (res?.error || 'Unknown error'), false);
      }
    }
  });

  // Init
  window.addEventListener('DOMContentLoaded', loadPrefsAndDevices);
})();
