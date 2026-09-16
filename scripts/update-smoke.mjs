// Standalone local-feed QA builder/server. No imports from this file enter main.ts.
import { build } from 'esbuild'
import { api, utils } from '@electron-forge/core'
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { serveUpdateFixtures } from './qa/update-feed.mjs'
import { sourceIdentity, readBuildSource, assertSameSource } from './release/validation.mjs'
import { APP_NAME, BUNDLE_ID } from '../electron/shared/app-identity.mjs'
import { join, resolve, basename } from 'node:path'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import base from '../forge.config.mjs'
import { signedForgeConfig } from './macos/policy.mjs'
const defaultDesktopSettings = () => ({ schemaVersion: 1, characterId: 'gpichan', alwaysOnTop: true, showOnAllWorkspaces: true, showOverFullScreen: false, clickThrough: true, speechBubblesEnabled: true, updateAutoCheck: false })
const run = promisify(execFile), root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({ options: { output: { type: 'string' }, 'signing-manifest': { type: 'string' }, serve: { type: 'boolean' }, pack: { type: 'string' }, 'unsigned-windows': { type: 'boolean' }, failures: { type: 'boolean' }, 'install-baseline': { type: 'boolean' } } })
if (!values.output) throw Error('Require --output <new isolated QA directory>')
const output = resolve(values.output), feed = join(output, 'feed'), port = 45943
if (values.serve) {
  serveUpdateFixtures(output, port)
} else if (values['install-baseline']) {
  if (process.platform !== 'win32') throw Error('Windows only')
  const plan = JSON.parse(await readFile(join(output, 'qa-build.json'), 'utf8'))
  if (!plan.unsignedWindowsOptIn || !plan.installationDirectory.startsWith(output + '\\')) throw Error('Explicit isolated unsigned QA plan required')
  await run(plan.installers[0], ['/S', '/D=' + plan.installationDirectory], { windowsVerbatimArguments: true, timeout: 180000 })
  console.log(JSON.stringify({ installedReviewOnly: true, executable: join(plan.installationDirectory, APP_NAME + '.exe') }))
} else {
  if (!['darwin', 'win32'].includes(process.platform)) throw Error('Mac arm64 or Windows x64 required')
  const mac = process.platform === 'darwin'
  if (mac && !values['signing-manifest'] || !mac && !values['unsigned-windows']) throw Error('Explicit signing manifest or unsigned Windows QA opt-in required')
  const source = await sourceIdentity(root)
  assertSameSource(source, await readBuildSource(root))
  await mkdir(output); await mkdir(feed)
  const signer = mac ? JSON.parse(await readFile(resolve(values['signing-manifest']), 'utf8')).signer : null
  const reviewId = 'io.github.ddol2ya.daemonlet.update-review.' + createHash('sha256').update(output).digest('hex').slice(0, 12)
  const installationDirectory = join(output, '설치 시험')
  const profile = join(output, 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'desktop-settings.json'), JSON.stringify({ ...defaultDesktopSettings(), allowUnsignedWindowsUpdates: !mac && values['unsigned-windows'] === true, visible: true, adapterAutoStart: false, sideChatEnabled: false, taskBubblesEnabled: false, language: 'en', scale: .8, bounds: { x: 200, y: 180, width: 368, height: 368, displayId: 1 }, bubblePlacement: { schemaVersion: 1, mode: 'relative', offsetX: 210, offsetY: -85, pivotX: 0, pivotY: .5 } }))
  await writeFile(join(profile, 'side-chat.json'), JSON.stringify({ version: 1, consentVersion: 1, executable: join(output, 'uninvoked-codex-selection'), offNoticeSeen: true }), { mode: 0o600 })
  const apps = [], installers = []
  for (const version of ['0.7.2', '0.7.3']) {
    const stage = join(output, 'stage-' + version)
    await mkdir(stage)
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); pkg.version = version
    await writeFile(join(stage, 'package.json'), JSON.stringify(pkg))
    for (const name of ['dist', 'dist-electron']) await cp(join(root, name), join(stage, name), { recursive: true })
    const result = await build({ absWorkingDir: root, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], minify: true, metafile: true, define: { __APP_QA__: 'true', __SETUP_SMOKE__: 'false' }, entryPoints: [join(root, 'electron/main/updates/UpdateSmokeEntry.ts')], outfile: join(stage, 'dist-electron/main.cjs') })
    await writeFile(join(stage, 'dist-electron/build-mode.json'), JSON.stringify({ schemaVersion: 1, production: false, setupSmoke: false, updateSmoke: true }))
    await writeFile(join(stage, 'dist-electron/bundle-inputs.json'), JSON.stringify({ production: false, inputs: Object.keys(result.metafile.inputs) }))
    const cacheName = 'daemonlet-updater-qa-' + basename(output).replace(/[^a-zA-Z0-9-]/g, '-')
    await writeFile(join(stage, 'dist-electron/app-update.yml'), JSON.stringify({ provider: 'generic', url: 'http://127.0.0.1:' + port, updaterCacheDirName: cacheName }))
    const smokeConfig = join(stage, 'update-smoke.json')
    await writeFile(smokeConfig, JSON.stringify({ feed: 'http://127.0.0.1:' + port, output, profile, cacheName, nextVersion: '0.7.3', failures: values.failures === true, unsignedWindows: values['unsigned-windows'] === true, ...(values.pack ? { pack: resolve(values.pack) } : {}), protocolPort: 45944, hookPort: 45945 }))
    const config = mac ? signedForgeConfig(base, signer) : { ...base, packagerConfig: { ...base.packagerConfig } }
    config.packagerConfig.appBundleId = reviewId
    config.packagerConfig.electronVersion = pkg.devDependencies.electron
    config.packagerConfig.extraResource = [join(stage, 'dist-electron/codex'), join(stage, 'dist-electron/native'), join(stage, 'dist-electron/app-update.yml'), join(root, 'dist-notices/licenses'), smokeConfig]
    utils.registerForgeConfigForDirectory(stage, config)
    try { const packaged = await api.package({ dir: stage, platform: process.platform, arch: mac ? 'arm64' : 'x64', outDir: join(output, 'apps-' + version), interactive: false }); apps.push(mac ? join(packaged[0].packagedPath, APP_NAME + '.app') : packaged[0].packagedPath) } finally { utils.unregisterForgeConfigForDirectory(stage) }
    if (mac) await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and certificate leaf = H"' + signer.fingerprint + '"', apps.at(-1)])
    if (!mac) {
      const projectDir = join(output, 'nsis-' + version)
      await mkdir(projectDir)
      await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'daemonlet-update-review', version, description: 'Isolated updater test', author: 'Daemonlet contributors', private: true }))
      const include = join(projectDir, 'review.nsh')
      const policy = await readFile(join(root, 'scripts/release/nsis-no-force-close.nsh'), 'utf8')
      const marker = JSON.stringify({ appId: BUNDLE_ID, kind: 'nsis', scope: 'currentUser' })
      await writeFile(include, policy + [
        '', '!macro customInstallMode', '  StrCpy $isForceCurrentInstall "1"', '!macroend',
        '!macro customInstall', '  FileOpen $0 "$INSTDIR\\daemonlet-install.json" w',
        "  FileWrite $0 '" + marker + "'", '  FileClose $0', '!macroend',
        '!macro customUnInstall', '  Delete "$INSTDIR\\daemonlet-install.json"', '!macroend', ''
      ].join('\n'))
      const { build: buildInstaller, Platform, Arch } = await import('electron-builder')
      const artifacts = await buildInstaller({ projectDir, prepackaged: apps.at(-1), targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never',
        config: { appId: reviewId, productName: 'Daemonlet update review', executableName: APP_NAME, electronVersion: pkg.devDependencies.electron, publish: null, npmRebuild: false,
          directories: { output: join(projectDir, 'artifacts') }, win: { signAndEditExecutable: false, target: [{ target: 'nsis', arch: ['x64'] }] },
          nsis: { artifactName: 'Daemonlet-for-Codex-' + version + '-windows-x64-Setup.exe', oneClick: false, perMachine: false, allowElevation: false,
            allowToChangeInstallationDirectory: true, include, createDesktopShortcut: false, createStartMenuShortcut: false, runAfterFinish: false,
            deleteAppDataOnUninstall: false, packElevateHelper: false, differentialPackage: false, uninstallDisplayName: 'Daemonlet update review ' + reviewId.split('.').at(-1) } } })
      const installer = artifacts.find(file => file.endsWith('-Setup.exe'))
      if (!installer) throw Error('QA installer missing')
      installers.push(installer)
    }

  }
  const file = 'Daemonlet-for-Codex-0.7.3-' + (mac ? 'macOS-arm64.zip' : 'windows-x64-Setup.exe'), archive = join(feed, file)
  if (mac) await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', apps[1], archive], { timeout: 180000 })
  else await cp(installers[1], archive)
  const hash = createHash('sha512'); for await (const part of createReadStream(archive)) hash.update(part)
  const sha512 = hash.digest('base64'), size = (await stat(archive)).size
  await writeFile(join(feed, mac ? 'latest-mac.yml' : 'latest.yml'), JSON.stringify({ version: '0.7.3', files: [{ url: file, sha512, size }], path: file, sha512, minimumSystemVersion: mac ? '22.0.0' : '10.0.19045', daemonlet: { appId: BUNDLE_ID, platform: process.platform, arch: mac ? 'arm64' : 'x64', installType: mac ? 'mac' : 'nsis', ...(mac ? {} : { publisherVerified: false }) } }))

  if (mac && values.failures) {
    const badApp = join(output, 'invalid-signature', APP_NAME + '.app')
    await cp(apps[1], badApp, { recursive: true, verbatimSymlinks: true })
    await run('/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Invalid signature QA fixture', join(badApp, 'Contents/Info.plist')])
    let rejected = false
    try { await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', badApp]) } catch { rejected = true }
    if (!rejected) throw Error('Invalid-signature fixture unexpectedly verified')
    const badArchive = join(output, 'bad-signature.zip')
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', badApp, badArchive], { timeout: 180000 })
    const badHash = createHash('sha512')
    for await (const part of createReadStream(badArchive)) badHash.update(part)
    await writeFile(join(output, 'bad-signature.json'), JSON.stringify({ sha512: badHash.digest('base64'), size: (await stat(badArchive)).size }))
  }

  await writeFile(join(output, 'qa-build.json'), JSON.stringify({ source, apps, installers, installationDirectory, unsignedWindowsOptIn: !mac && values['unsigned-windows'] === true, archive, sha512, size, signed: mac, isolatedNativeBundleId: true, notarized: false, productionCandidate: false, publicUpload: false }, null, 2))
  console.log(JSON.stringify({ apps, output, next: 'Start this script with --serve, launch apps[0], inspect download-only.json, then write the authorized target version to approve-install.' }, null, 2))
}
