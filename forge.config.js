const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    // Ensure native .node binaries are placed outside of the ASAR
    // so Electron can load them at runtime (e.g., audify bindings)
    // Also unpack dependent DLLs that native modules may dynamically load
    asarUnpack: [
      "**/*.node",
      "**/*.dll",
      // ffmpeg-static provides a platform binary (ffmpeg.exe on Windows), ensure it's executable outside ASAR
      "node_modules/ffmpeg-static/**"
    ],
    icon: 'assets/icon',
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        authors: 'audio_recorder',
        description: 'An audio recording application',
        exe: 'audio-recorder.exe',
        icon: 'assets/icon.ico',
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      // Native modules (like audify) are unpacked outside of the ASAR.
      // Restricting loads to ASAR-only can prevent those from loading.
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    }),
  ],
};
