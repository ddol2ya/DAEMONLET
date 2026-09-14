// Uses real renderer/preload bundles with fixture IPC only. No live Codex, microphone or user profile.
import { app, BrowserWindow, ipcMain, protocol, net } from 'electron'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { setAppLanguage, bindWindowLanguage, languageArguments } from '../../electron/main/AppLanguage'
import { defaultDesktopSettings, validateDesktopSettingsPatch } from '../../electron/shared/desktop-settings'
import { WindowBoundsStore } from '../../electron/main/WindowBoundsStore'
import { SETUP_IPC } from '../../electron/shared/codex-integration-contract'
import { TASK_CONTROL_IPC } from '../../electron/shared/task-control-contract'
import { ACTIVITY_IPC } from '../../electron/shared/activity-contract'
import { CHARACTER_IPC } from '../../electron/shared/character-pack-contract'

async function run() {
const root = process.cwd(), output = resolve(root, process.env.DAEMONLET_LANGUAGE_SMOKE_OUTPUT ?? 'outputs/evidence/app-language')
const temporary = await mkdtemp(join(tmpdir(), 'daemonlet-language-ui-'))
app.setPath('userData', temporary)
app.commandLine.appendSwitch('disable-background-timer-throttling')
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
const pause = () => new Promise(done => setTimeout(done, 100))
const windows: BrowserWindow[] = [], errors: string[] = []
const store = new WindowBoundsStore(temporary)
let settings = defaultDesktopSettings()
const status = { app: { version: 'test', platform: process.platform, packaged: false }, onboarding: 'shown', discovery: null, configurationStatus: 'not-installed', configurationWarnings: [], host: { available: true, executableDisplayPath: 'fixture-app', resourceDisplayPath: 'fixture-resource', dataDisplayPath: 'fixture-data', endpoint: 'fixture-endpoint', runAsNode: false }, hostSelfTest: { status: 'not-tested' }, adapter: { state: 'READY', ownership: 'OWNED_UTILITY', activeRunCount: 0, activeTaskCount: 0 }, desktop: { connected: true }, hookReviewStatus: 'unknown', reception: { status: 'waiting', lastReceivedAt: null, events: [] }, live: { active: false, status: 'not-tested' }, storage: { userDataDisplayPath: 'fixture-user-data', receiptDirectoryDisplayPath: 'fixture-receipts' }, hasRevert: false, checkedAt: 1, issue: null }
const activity = { revision: 1, connection: 'READY', counts: { running: 1, waiting: 0, failed: 0, completed: 0, attention: 0 }, entries: [{ activityId: 'activity-1', name: '사용자 대화 {1}', state: 'running', category: 'command', freshness: 'observed', unread: false, revision: 1, firstObservedAt: 1, lastObservedAt: 1, endedAt: null, acknowledgedAt: null }], storage: 'saved', navigation: 'none', droppedUnread: 0, lastPrunedAt: null }
const control = { revision: 1, connection: 'ready', source: 'desktop', autoConnect: true, socketPath: '', threads: [{ key: '11111111-1111-4111-8111-111111111111', title: '사용자 대화 {1}', project: 'fixture', revision: 1, state: 'idle', canSend: true, canStop: false, canOpenConversation: false }], selectedKey: '11111111-1111-4111-8111-111111111111', pending: false, issue: null, needsClient: false }
let voiceId = '', starts = 0, stops = 0
let selectDone: (() => void) | undefined
const bind = (channel: string, handler: (...args: any[]) => any) => ipcMain.handle(channel, async (_e, ...args) => ({ ok: true, value: await handler(...args) }))
const emit = (channel: string, value: unknown) => windows.forEach(w => !w.isDestroyed() && w.webContents.send(channel, value))
bind(SETUP_IPC.status, () => status)
bind(SETUP_IPC.settingsGet, () => settings)
bind(SETUP_IPC.settingsPatch, async patch => {
 assert.ok(validateDesktopSettingsPatch(patch)); settings = { ...settings, ...patch }; setAppLanguage(settings.language); emit(SETUP_IPC.settingsChanged, settings); await store.save(settings); return settings
})
bind(CHARACTER_IPC.list, () => ({ generation: 1, entries: [{ id: 'gpichan', name: '지피쨩', source: 'builtin', status: 'ready', revision: 'a'.repeat(64) }], storageBytes: 0, storageLimitBytes: 1024 ** 3 }))
bind(CHARACTER_IPC.cancel, () => null)
bind(CHARACTER_IPC.select, () => new Promise<void>(done => { selectDone = done }))
bind(SETUP_IPC.exportDiagnostics, () => ({ saved: true }))
bind(ACTIVITY_IPC.get, () => activity)
bind(TASK_CONTROL_IPC.get, () => control)
bind(TASK_CONTROL_IPC.getView, () => ({ view: 'control', collapsed: false }))
bind(TASK_CONTROL_IPC.dictationStart, id => { voiceId = id; starts++; setTimeout(() => emit(TASK_CONTROL_IPC.dictation, { sessionId: id, state: 'listening', text: 'Keep this sentence.', error: null }), 60); return null })
bind(TASK_CONTROL_IPC.dictationStop, id => { assert.equal(id, voiceId); stops++; setTimeout(() => emit(TASK_CONTROL_IPC.dictation, { sessionId: id, state: 'idle', text: 'Keep this sentence.', error: null }), 60); return null })
const wait = async (w: BrowserWindow, expression: string) => { for (let i = 0; i < 100; i++) { if (await w.webContents.executeJavaScript(expression)) return; await pause() } throw Error('Timed out: '+expression) }
const evaluate = (w: BrowserWindow, source: string) => w.webContents.executeJavaScript(source)
const changeLanguage = async (w: BrowserWindow, language: string) => {
 await evaluate(w, `document.querySelector('#app-language').value=${JSON.stringify(language)};document.querySelector('#app-language').dispatchEvent(new Event('change',{bubbles:true}))`)
 await wait(w, `document.documentElement.lang===${JSON.stringify(language)} && !document.querySelector('#app-language').disabled`)
}
const capture = async (w: BrowserWindow, name: string) => { await pause(); await writeFile(join(output, name+'.png'), (await w.webContents.capturePage()).toPNG()) }
const open = async (page: string, preload: string, width: number, height: number) => {
 const win = new BrowserWindow({ width, height, show: false, webPreferences: { preload: join(root, 'dist-electron/'+preload+'-preload.cjs'), additionalArguments: languageArguments(), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
 windows.push(win); bindWindowLanguage(win, page==='settings'?'Daemonlet 설정':page==='activity'?'Daemonlet 작업 목록':'Daemonlet 작업 말풍선')
 win.webContents.on('console-message', details => { if(details.level === 'error') errors.push(details.message) })
 await win.loadURL('pet://app/'+page+'.html'); return win
}
try {
 await app.whenReady(); await mkdir(output, { recursive: true })
 protocol.handle('pet', req => { const path = resolve(root, 'dist', decodeURIComponent(new URL(req.url).pathname).slice(1)); assert.ok(path.startsWith(resolve(root, 'dist')+sep)); return net.fetch(pathToFileURL(path).href) })
 const settingsWindow = await open('settings','settings',800,750)
 const controlWindow = await open('activity-bubble','activity',276,370)
 const listWindow = await open('activity','activity',700,650)
 await wait(settingsWindow, `!!document.querySelector('#app-language') && !document.querySelector('#app-language').disabled`)
 await wait(controlWindow, `!!document.querySelector('textarea') && document.querySelector('textarea').placeholder.includes('후속')`)
 await capture(settingsWindow, 'settings-ko')
 // Seed an actual controlled React input, then change language through the real settings control.
 await evaluate(controlWindow, `(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Original draft.');input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
 await changeLanguage(settingsWindow,'en')
 await wait(controlWindow, `document.querySelector('textarea').placeholder.startsWith('Type a follow-up')`)
 assert.equal(await evaluate(controlWindow, `document.querySelector('textarea').value`),'Original draft.')
 assert.equal(await evaluate(controlWindow, `document.querySelector('select').selectedOptions[0].textContent`),'사용자 대화 {1} · fixture')
 assert.equal(settingsWindow.getTitle(),'Daemonlet settings')
 assert.equal((await store.load()).value.language,'en')
 await capture(settingsWindow, 'settings-en')
 await capture(controlWindow, 'control-en')
 await wait(listWindow, `document.querySelector('h1').textContent==='Task list'`)
 await capture(listWindow, 'activity-en')
 // Dictation events are simulated; this verifies renderer draft retention, not microphone accuracy.
 await evaluate(controlWindow, `document.querySelector('.voice-button').click()`)
 await wait(controlWindow, `document.querySelector('textarea').value==='Original draft. Keep this sentence.'`)
 await changeLanguage(settingsWindow,'ko')
 assert.equal(starts,1);assert.equal(stops,0)
 assert.equal(await evaluate(controlWindow, `document.querySelector('textarea').value`),'Original draft. Keep this sentence.')
 await evaluate(controlWindow, `document.querySelector('.voice-button').click()`)
 await wait(controlWindow, `!document.querySelector('textarea').disabled`)
 assert.equal(stops,1)
 await changeLanguage(settingsWindow,'en')
 assert.equal(await evaluate(controlWindow, `document.querySelector('textarea').value`),'Original draft. Keep this sentence.')
 // Check loaded settings pages, import progress in English, and narrow-window overflow.
 await evaluate(settingsWindow, `document.querySelector('#tab-appearance').click()`)
 await wait(settingsWindow, `!!document.querySelector('.pack-card') && !document.querySelector('#app-language').disabled`)
 await capture(settingsWindow, 'appearance-en')
 await evaluate(settingsWindow, `document.querySelector('.pack-choice input').checked=false;document.querySelector('.pack-choice input').click()`)
 await wait(settingsWindow, `!!document.querySelector('.loading-dialog[open]')`)
 assert.ok((await evaluate(settingsWindow, `document.querySelector('.loading-dialog').textContent`)).includes('Preparing character'))
 await capture(settingsWindow, 'loading-en');selectDone?.()
 await wait(settingsWindow, `!document.querySelector('.loading-dialog[open]')`)
 await evaluate(settingsWindow, `document.querySelector('#tab-diagnostics').click()`)
 await wait(settingsWindow, `document.querySelector('h1').textContent==='Diagnostics'`)
 await capture(settingsWindow, 'diagnostics-en')
 for (const w of [settingsWindow, controlWindow]) assert.equal(await evaluate(w, `document.documentElement.scrollWidth > innerWidth`),false)
 settingsWindow.webContents.reload()
 await wait(settingsWindow, `document.querySelector('#app-language')?.value==='en'`)
 assert.equal(await evaluate(settingsWindow, `document.documentElement.lang`),'en')
 assert.deepEqual(errors,[])
 await writeFile(join(output,'result.json'),JSON.stringify({ passed: true, platform: process.platform, languages:['ko','en'], savedAndReloaded:true, draftPreserved:true, recordingContinuedDuringSwitch:true, noHorizontalOverflow:true, englishCharacterProgress:true, realMicrophoneTest:false, errors },null,2))
 console.log('Language UI smoke passed')
} catch(error) { console.error(error);process.exitCode=1 }
finally { for (const win of windows) if(!win.isDestroyed())win.destroy(); await rm(temporary,{recursive:true,force:true});app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0) }

}
void run().catch(error=>{console.error(error);app.exit(1)})
