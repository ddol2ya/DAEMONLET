# A2 / M2 rabbit icons

The user selected the A2 app icon and M2 menu-bar icon from the September 13, 2026
ImageGen exploration. The two PNG source files are preserved unchanged.

Run `node scripts/build-app-icons.mjs` on macOS to export the ICNS container and
18px / 36px PNG menu-bar representations. The generated `TrayIconData.ts` embeds
the same template images in the main-process bundle. macOS applies the template
color for the current menu-bar appearance.

`manifest.json` records the selected source and generated asset hashes. The
application icon is bound through the macOS Forge `icon` option.

Windows uses `appIcon.ico`, exported from the same A2 original with
`node scripts/build-windows-icon.mjs` on macOS. It contains 16–256px PNG images
and is used for the packaged EXE and the installer/uninstaller.
