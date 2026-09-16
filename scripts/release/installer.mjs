import { APP_NAME, BUNDLE_ID } from "../../electron/shared/app-identity.mjs"
// Prepare an isolated NSIS build project from an already verified Windows app.
// Only the staged application is passed to --prepackaged; this repository and
// the build project (including npm/build tools) are never installer payloads.
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { checkCandidate } from './check.mjs'
import {readAsarIdentity} from './artifact-source.mjs'
import { checkExternalNotices } from './check-notices.mjs'

const { values } = parseArgs({ options: { app: { type: 'string' }, output: { type: 'string' }, publisher: { type: 'string' }, 'certificate-sha1': { type: 'string' } } })
if (!values.app || !values.output) throw new Error('Usage: npm run release:installer -- --app <verified Windows app folder> --output <new build project>')
const root = resolve(import.meta.dirname, '../..'), app = resolve(values.app), output = resolve(values.output)
const checks = await checkCandidate(join(app, 'resources/app.asar'))
await checkExternalNotices(join(app, 'resources/licenses'))
await mkdir(output) // Existing build projects are never overwritten.
await cp(join(root, 'electron/assets/appIcon.ico'), join(output, 'appIcon.ico'))
if (Boolean(values.publisher) !== Boolean(values["certificate-sha1"]) || values["certificate-sha1"] && !/^[A-Fa-f0-9]{40}$/.test(values["certificate-sha1"])) throw Error("Both publisher and certificate SHA1 are required for a signed installer")
const staged = join(output, 'runtime')
await cp(app, staged, { recursive: true })
const updateConfig = { provider: "github", owner: "ddol2ya", repo: "DAEMONLET", private: false, updaterCacheDirName: "daemonlet-for-codex-updater", ...(values.publisher ? { publisherName: [values.publisher] } : {}) }
if (values.publisher) {
  if (process.platform !== "win32") throw Error("Verify signed installer input on Windows")
  const { verifySignature } = await import("electron-updater/out/windowsExecutableCodeSignatureVerifier.js")
  if (await verifySignature([values.publisher], join(staged, APP_NAME + ".exe"), console)) throw Error("Prepackaged application must already be signed by the configured publisher")
}
await writeFile(join(staged, "resources/app-update.yml"), JSON.stringify(updateConfig) + "\n")
// The packaged application must already use the test identity. Renaming only
// the EXE leaves userData and the single-instance lock shared with the regular app.
await stat(join(staged, `${APP_NAME}.exe`))
await mkdir(join(staged, 'licenses'), { recursive: true })
await cp(join(root, 'node_modules/electron-builder/LICENSE'), join(staged, 'licenses/electron-builder-LICENSE.txt'))
const files = []
async function walk(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name, source = join(directory, entry.name)
    if (entry.isDirectory()) await walk(source, path + '/')
    else if (entry.isFile()) {
      const hash = createHash('sha256'); let bytes = 0
      for await (const part of createReadStream(source)) { hash.update(part); bytes += part.length }
      files.push({ path, bytes, sha256: hash.digest('hex') })
    } else throw new Error('Installer payload must contain ordinary files')
  }
}
await walk(staged)
if (files.some(f => /(^|\/)(skills|scripts|node_modules|docs|outputs|workflows|__pycache__)(\/|$)|\.(py|pyc|map|petchar)$/.test(f.path))) throw new Error('Authoring or development content found in installer payload')
const appPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const identity = await readAsarIdentity(join(staged, 'resources/app.asar'))
await writeFile(join(output, 'payload.json'), JSON.stringify({ source: identity.source, appVersion: identity.appVersion, checks, files }, null, 2) + '\n')
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'daemonlet-test-installer-build', version: identity.appVersion, description: 'Daemonlet Windows test installer build tools', private: true, license: 'MIT', author: 'Daemonlet contributors', scripts: { build: 'node build.mjs' }, devDependencies: { 'electron-builder': appPackage.devDependencies['electron-builder'], 'electron-updater': appPackage.dependencies['electron-updater'] } }, null, 2) + '\n')
await writeFile(join(output, 'installer.nsh'), `!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
!macro customInstall
  FileOpen $0 "$INSTDIR\\daemonlet-install.json" w
  FileWrite $0 '{"appId":"${BUNDLE_ID}","kind":"nsis","scope":"currentUser"}'
  FileClose $0
!macroend
!macro customUnInstall
  Delete "$INSTDIR\\daemonlet-install.json"
!macroend
`)
await writeFile(join(output, 'electron-builder.json'), JSON.stringify({
  appId: BUNDLE_ID, productName: APP_NAME,
  executableName: APP_NAME, electronVersion: appPackage.devDependencies.electron,
  publish: null, forceCodeSigning: Boolean(values.publisher), npmRebuild: false, directories: { output: 'artifacts', buildResources: '.' },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: "appIcon.ico", signAndEditExecutable: false, ...(values.publisher ? { signtoolOptions: { publisherName: values.publisher, certificateSha1: values["certificate-sha1"], signingHashAlgorithms: ["sha256"] } } : {}) },
  nsis: { artifactName: `Daemonlet-for-Codex-${identity.appVersion}-windows-x64-Setup.exe`,
    installerIcon: "appIcon.ico", uninstallerIcon: "appIcon.ico",
    oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
    include: 'installer.nsh', createDesktopShortcut: false, createStartMenuShortcut: true,
    shortcutName: APP_NAME, uninstallDisplayName: APP_NAME,
    runAfterFinish: false, deleteAppDataOnUninstall: false, packElevateHelper: false,
    differentialPackage: false, installerLanguages: ['ko_KR', 'en_US'], language: '1042' },
}, null, 2) + '\n')
await cp(join(root, 'scripts/release/validation.mjs'), join(output, 'validation.mjs'))
await cp(join(root, 'scripts/release/installer-build.mjs'), join(output, 'build.mjs'))
console.log(JSON.stringify({ buildProject: output, runtimeFiles: files.length, next: 'On Windows: npm install --ignore-scripts; npm run build', includesCreatorTools: false }, null, 2))
