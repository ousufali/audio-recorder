# Audio Recorder (Electron)

This app records system loopback and microphone audio on Windows. It uses a native module (`audify`) for WASAPI capture.

## Dev run

```powershell
npm install
npm start
```

## Package (no installer)

```powershell
# Rebuild native modules (postinstall runs automatically)
npm install
# Create unpacked app under ./out
npm run package
```

## Notes on native module (audify)

- `audify` is a native Node addon. It must be rebuilt against your Electron version before packaging. This repo now:
  - runs `electron-rebuild -f -w audify` on postinstall
  - forces Electron Forge to rebuild `audify` during `package/make`
  - unpacks native bindings so Electron can load the `.node` file at runtime
- If you see "The specified module could not be found" when starting the packaged app:
  - Ensure you installed dependencies and the rebuild step completed without errors
  - Try deleting `node_modules` and running `npm ci` (or `npm i`) again
  - On some machines you may need the Microsoft Visual C++ Redistributable (x64)

## Output files

- Loopback-only and mic-only recordings are saved as WAV into your configured save folder (Preferences > Save Path).
- Mixed recordings (loopback + mic) are saved as WAV as well.

## Troubleshooting

- To reset preferences, delete the `prefs.json` file created by electron-store (in your user-data folder) and restart the app.
- If packaging issues persist, check that `out/audio-recorder-win32-x64/resources/app.asar.unpacked/node_modules/audify/build/Release/audify.node` exists.
