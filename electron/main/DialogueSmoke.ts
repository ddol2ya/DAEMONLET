import { BrowserWindow, screen } from "electron"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { DesktopCharacterId, DesktopSettingsPatch, DesktopSettingsV1 } from "../shared/desktop-settings"

type Options = {
  window: BrowserWindow
  speechWindow(): BrowserWindow | null
  evidenceDirectory: string
  dataDirectory: string
  hookEndpoint: string
  updateSettings(patch: DesktopSettingsPatch): void
  selectCharacter(id: DesktopCharacterId): Promise<void>
  setLayout(enabled: boolean): void
  getMousePassthrough(): boolean
  loadSettings(): Promise<DesktopSettingsV1>
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(`Dialogue smoke assertion failed: ${label}`) }

/** Opt-in packaged QA only. No test capability is exposed through preload or production UI. */
export async function runDialogueSmoke(options: Options) {
  const { window: win } = options
  const run = (code: string) => win.webContents.executeJavaScript(code)
  const waitFor = async (code: string, label: string, timeout = 6000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { const result = await run(code); if (result) return result; await wait(30) }
    throw new Error(`Dialogue smoke timed out: ${label}`)
  }
  const bubble = async () => {
    const speech = options.speechWindow()
    if (!speech?.isVisible()) return null
    const box = await speech.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('.speech-bubble'), r = node.getBoundingClientRect(), style = getComputedStyle(node);
      if (node.dataset.phase !== 'shown') return null;
      const range = document.createRange(); range.selectNodeContents(node.querySelector('span'));
      const lineWidths = Array.from(range.getClientRects(), r => r.width), contentWidth = r.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      const unusedContentWidth = contentWidth - Math.max(0, ...lineWidths);
      return { lineWidths, unusedContentWidth, text: node.textContent, x: r.x, y: r.y, width: r.width, height: r.height, pointerEvents: style.pointerEvents, appRegion: style.webkitAppRegion, fontSize: style.fontSize, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, scrollHeight: node.scrollHeight, windowHeight: innerHeight, maxWidth: style.maxWidth, lineHeight: style.lineHeight };
    })()`)
    if (!box) return null
    const bounds = speech.getBounds(), petBounds = win.getBounds(), area = screen.getDisplayMatching(petBounds).workArea
    const rect = { x: bounds.x + box.x - petBounds.x, y: bounds.y + box.y - petBounds.y, width: box.width, height: box.height }
    const pixels = await run(`(() => {
      const canvas = document.querySelector('canvas'), copy = document.createElement('canvas');
      copy.width = canvas.clientWidth; copy.height = canvas.clientHeight;
      const context = copy.getContext('2d'); context.drawImage(canvas, 0, 0, copy.width, copy.height);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data, rect = ${JSON.stringify(rect)};
      let artworkHash = 0;
      for (let i = 0; i < pixels.length; i += 521) artworkHash = (Math.imul(artworkHash, 31) + pixels[i]) | 0;
      let canvasOpaquePixels = 0, opaquePixelsUnderBubble = 0, nearestSquared = Infinity;
      for (let y = 0; y < copy.height; y++) for (let x = 0; x < copy.width; x++) {
        if (pixels[(y * copy.width + x) * 4 + 3] < 16) continue;
        canvasOpaquePixels++;
        const dx = Math.max(rect.x - x - 1, x - rect.x - rect.width, 0), dy = Math.max(rect.y - y - 1, y - rect.y - rect.height, 0);
        nearestSquared = Math.min(nearestSquared, dx * dx + dy * dy);
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) opaquePixelsUnderBubble++;
      }
      return { canvasOpaquePixels, opaquePixelsUnderBubble, artworkHash, artworkGap: Math.sqrt(nearestSquared), trigger: document.querySelector('.speech-bubble')?.dataset.trigger };
    })()`)
    return { ...box, ...pixels, clientX: rect.x, clientY: rect.y, x: bounds.x + box.x - area.x, y: bounds.y + box.y - area.y, viewportWidth: area.width, viewportHeight: area.height, petBounds, speechBounds: bounds }
  }
  const visible = async (trigger: string) => {
    await waitFor(`document.querySelector('.speech-bubble[data-trigger=${JSON.stringify(trigger)}][data-phase="shown"][data-granted="true"]')?.textContent`, trigger)
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) { const state = await bubble(); if (state?.trigger === trigger) return state.text; await wait(30) }
    throw new Error(`Dialogue smoke timed out: native ${trigger}`)
  }
  const capture = async (file: string) => {
    await wait(180)
    const image = await win.webContents.capturePage()
    await mkdir(join(options.evidenceDirectory, file.split("/")[0]), { recursive: true })
    await writeFile(join(options.evidenceDirectory, file), image.toPNG())
    const speech = options.speechWindow()
    if (speech?.isVisible()) await writeFile(join(options.evidenceDirectory, file.replace(/\.png$/, "-speech.png")), (await speech.webContents.capturePage()).toPNG())
  }
  const captureScene = async (file: string) => {
    const speech = options.speechWindow()!
    const petBounds = win.getBounds(), speechBounds = speech.getBounds()
    const x = Math.min(petBounds.x, speechBounds.x) - 16, y = Math.min(petBounds.y, speechBounds.y) - 16
    const width = Math.max(petBounds.x + petBounds.width, speechBounds.x + speechBounds.width) - x + 16
    const height = Math.max(petBounds.y + petBounds.height, speechBounds.y + speechBounds.height) - y + 16
    const images = [
      { bounds: petBounds, image: await win.webContents.capturePage() },
      { bounds: speechBounds, image: await speech.webContents.capturePage() },
    ]
    // Compose only the two captured app surfaces at their actual screen offsets.
    const preview = new BrowserWindow({ width, height, show: false, frame: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    try {
      const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><body style="margin:0;background:#fff">${images.map(({ bounds: b, image }) => `<img src="${image.toDataURL()}" style="position:absolute;left:${b.x - x}px;top:${b.y - y}px;width:${b.width}px;height:${b.height}px">`).join("")}</body>`
      await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      await writeFile(join(options.evidenceDirectory, file), (await preview.webContents.capturePage()).toPNG())
    } finally { preview.destroy() }
  }
  const token = (await readFile(join(options.dataDirectory, "adapter-token"), "utf8")).trim()
  let sequence = 0
  const nextRun = () => `dialogue-smoke-${++sequence}`
  const hook = async (turnId: string, hookEventName: string, fields: Record<string, unknown> = {}) => {
    const response = await fetch(options.hookEndpoint, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ payloadVersion: 1, sessionId: "dialogue-smoke", turnId, model: "smoke", permissionMode: "default", hookEventName, ...fields }),
    })
    assert(response.status === 202, "hook accepted")
  }
  const report: Record<string, unknown> = { speechBubblesEnabled: true, screenshots: [], scale: [] }
  const screenshots: string[] = []
  const shot = async (file: string) => { await capture(file); screenshots.push(file) }
  await mkdir(options.evidenceDirectory, { recursive: true })
  const beginObservation = async () => {
    await run(`(() => {
      window.__gpichanDialogueObserver?.disconnect();
      window.__gpichanDialogueHistory = [];
      let previous = '';
      const sample = () => {
        const node = document.querySelector('.speech-bubble[data-phase="shown"]');
        const signature = node ? node.dataset.trigger + ':' + node.textContent : '';
        if (signature && signature !== previous) window.__gpichanDialogueHistory.push({ trigger: node.dataset.trigger, text: node.textContent });
        previous = signature;
      };
      window.__gpichanDialogueObserver = new MutationObserver(sample);
      window.__gpichanDialogueObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      sample();
    })()`)
  }
  const count = (trigger: string) => run(`window.__gpichanDialogueHistory.filter(item => item.trigger === ${JSON.stringify(trigger)}).length`) as Promise<number>
  const fresh = async () => {
    options.updateSettings({ speechBubblesEnabled: true, visible: true, scale: 1 })
    await options.selectCharacter("gpichan")
    // Pin the first (longest) writing line for repeatable small-window layout QA.
    // Reload creates a new JS context, so save/restore within each fresh context.
    await run(`window.__gpichanSmokeRandom = Math.random; Math.random = () => 0; true`)
    await beginObservation()
  }
  const start = async () => {
    const turn = nextRun()
    await hook(turn, "UserPromptSubmit")
    await visible("run.started")
    return turn
  }
  const checkGeometry = async () => {
    const state = await bubble()
    assert(state && state.height + 12 <= state.windowHeight && state.scrollWidth <= state.clientWidth, "native text fits without clipping")
    assert(state.unusedContentWidth >= -1 && state.unusedContentWidth <= 2.5, "bubble fits the longest rendered line")
    assert(state && state.x >= 7.5 && state.y >= 7.5 && state.x + state.width <= state.viewportWidth - 7.5 && state.y + state.height + 6 <= state.viewportHeight - 7.5, "viewport clamp")
    if (!(state.canvasOpaquePixels > 100 && state.opaquePixelsUnderBubble === 0)) {
      await writeFile(join(options.evidenceDirectory, "geometry-failure.json"), JSON.stringify(state, null, 2) + "\n")
      await shot("gpichan/geometry-failure.png")
      assert(false, `bubble leaves the rendered character unobscured at ${state.viewportWidth} DIP (${state.opaquePixelsUnderBubble} pixels)`)
    }
    await writeFile(join(options.evidenceDirectory, "latest-geometry.json"), JSON.stringify(state, null, 2) + "\n")
    return state
  }
  const stability: unknown[] = []
  const checkStationarySpeech = async (label: string) => {
    const first = await checkGeometry(), samples: Array<{ x: number; y: number; artworkHash: number; overlap: number }> = []
    for (let i = 0; i < 10; i++) {
      await wait(55)
      const state = await checkGeometry()
      assert(state.text === first.text, "stability samples belong to one line")
      assert(JSON.stringify(state.petBounds) === JSON.stringify(first.petBounds), "Pet window stays put during animation test")
      assert(JSON.stringify(state.speechBounds) === JSON.stringify(first.speechBounds), "character animation cannot move the speech window")
      samples.push({ x: state.speechBounds.x, y: state.speechBounds.y, artworkHash: state.artworkHash, overlap: state.opaquePixelsUnderBubble })
    }
    assert(new Set(samples.map(s => s.artworkHash)).size > 1, "character actually animates while the bubble is stationary")
    stability.push({ label, bounds: first.speechBounds, samples })
  }
  try {
    await fresh()
    const turn = await start()
    report.started = await checkGeometry()
    await shot("gpichan/run-started.png")
    const scales: Array<{ scale: number; width: number }> = []
    for (const scale of [280 / 460, .65, .8, 1, 1.25, 1.5, 720 / 460]) {
      options.updateSettings({ scale })
      await wait(100)
      scales.push({ scale, ...(await checkGeometry()) })
      if (scale === .65 || scale === 1.5) await shot(`gpichan/scale-${Math.round(scale * 100)}.png`)
    }
    assert(scales.every(s => s.width === scales[0].width), "speech width stays constant across character scales")
    report.scale = scales
    options.updateSettings({ scale: 1 })
    await waitFor(`!document.querySelector('.speech-bubble')`, "initial bubble expiry")
    await hook(turn, "PreToolUse", { toolName: "Bash", toolUseId: "command-child" })
    await wait(400)
    assert((await bubble()) === null && await count("task.started.command") === 0, "ordinary tools do not retrigger the settled writing pose")
    report.commandHasNoExtraCue = true
    await hook(turn, "PreToolUse", { toolName: "request_user_input", toolUseId: "question" })
    await visible("state.waiting")
    report.waiting = await checkGeometry()
    await shot("gpichan/waiting.png")
    await hook(turn, "PostToolUse", { toolName: "request_user_input", toolUseId: "question" })
    await waitFor(`!document.querySelector('.speech-bubble[data-trigger="state.waiting"]')`, "resume clears waiting text")
    await hook(turn, "Stop", { stopHookActive: false })
    await visible("run.completed.observed")
    report.completed = await checkGeometry()
    await shot("gpichan/completed.png")
    const completions = await count("run.completed.observed")
    await hook(turn, "PostToolUse", { toolName: "Bash", toolUseId: "command-child" })
    await hook(turn, "Stop", { stopHookActive: false })
    await wait(400)
    assert(await count("run.completed.observed") === completions, "late events do not repeat the completion cue")
    report.lateEventsSilent = true

    await fresh()
    const interrupted = await start()
    await hook(interrupted, "Interrupt")
    await visible("run.cancelled.user")
    report.interrupted = await checkGeometry()
    await shot("gpichan/interrupted.png")
    await fresh()
    const internal = await start()
    await hook(internal, "SessionEnd", { reason: "other" })
    await visible("state.normal")
    await wait(1400)
    assert(await count("run.cancelled.user") === 0, "internal cleanup never shows user cancellation")
    report.internalCancelSuppressed = true

    await fresh()
    const disabled = await start()
    options.updateSettings({ speechBubblesEnabled: false })
    await waitFor(`!document.querySelector('.speech-bubble')`, "toggle hides dialogue")
    await hook(disabled, "SessionEnd", { reason: "other" })
    await wait(800)
    report.toggleFalsePersisted = !(await options.loadSettings()).speechBubblesEnabled
    options.updateSettings({ speechBubblesEnabled: true })
    await wait(450)
    report.toggleTruePersisted = (await options.loadSettings()).speechBubblesEnabled
    report.toggleHasNoReplay = (await bubble()) === null
    assert(report.toggleFalsePersisted && report.toggleTruePersisted && report.toggleHasNoReplay, "toggle persists and does not replay")

    await fresh()
    const hidden = await start()
    const startsBeforeHide = await count("run.started")
    options.updateSettings({ visible: false })
    await hook(hidden, "SessionEnd", { reason: "other" })
    await wait(800)
    options.updateSettings({ visible: true })
    await wait(500)
    assert(await count("run.started") === startsBeforeHide && await count("run.cancelled.user") === 0, "hidden work cues are not replayed")
    report.hiddenRunHasNoReplay = true

    // Wait beyond the real work-cue cooldown: a short click test would mask the regression.
    await fresh()
    const clicked = await start()
    await wait(12_100)
    const startsBeforeClicks = await count("run.started")
    const clicks: unknown[] = []
    for (const [interaction, modelX, modelY] of [["head-tap", 634, 210], ["torso-tap", 650, 660]] as const) {
      const point = await run(`(() => { const rect = document.querySelector('canvas').getBoundingClientRect(); return { x: Math.round(rect.x + rect.width * ${modelX / 1280}), y: Math.round(rect.y + rect.height * ${modelY / 1280}) }; })()`)
      win.webContents.sendInputEvent({ type: "mouseMove", ...point })
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
      await wait(60)
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
      await visible(`interaction.${interaction}`)
      clicks.push({ interaction, ...(await checkGeometry()) })
      await shot(`gpichan/${interaction}.png`)
      await waitFor(`!document.querySelector('.speech-bubble[data-trigger="interaction.${interaction}"]')`, `${interaction} return clears text`)
      await wait(400)
      assert(await count("run.started") === startsBeforeClicks && (await bubble()) === null, `${interaction} return does not announce new work`)
    }
    report.clickReturn = { input: "webContents.sendInputEvent", testedAfterWorkCooldownMs: 12_100, returnsSilent: true, clicks }
    await hook(clicked, "SessionEnd", { reason: "other" })

    await fresh()
    const scaled = await start()
    options.setLayout(true)
    await waitFor(`!document.querySelector('.speech-bubble')`, "layout hides dialogue")
    options.setLayout(false)
    await wait(100)
    report.layoutHasNoReplay = (await bubble()) === null
    assert(report.layoutHasNoReplay, "layout does not replay")
    await hook(scaled, "SessionEnd", { reason: "other" })

    await fresh()
    assert((await bubble()) === null, "character reload clears old voice")
    report.characterReloadClears = true
    const pointerTurn = await start()
    const pointerBubble = await checkGeometry()
    await run(`(async () => {
      const canvas = document.querySelector('canvas');
      const clientX = ${pointerBubble.clientX + pointerBubble.width - 12}, clientY = ${pointerBubble.clientY + 12};
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY }));
      await new Promise(resolve => setTimeout(resolve, 45));
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY }));
      await new Promise(resolve => setTimeout(resolve, 45));
    })()`)
    report.bubbleCanvasAlphaPassthrough = options.getMousePassthrough()
    report.pointerEventsNone = pointerBubble.pointerEvents === "none" && pointerBubble.appRegion === "no-drag"
    assert(report.bubbleCanvasAlphaPassthrough && report.pointerEventsNone, "bubble pointer policy")
    await hook(pointerTurn, "SessionEnd", { reason: "other" })
    if (process.env.ELECTRON_SMOKE_NATIVE_CLICK === "1") {
      // Human/native automation may need multiple app-selection round trips.
      const requestedNativeWait = Number(process.env.ELECTRON_SMOKE_NATIVE_WAIT_MS ?? 60000)
      const nativeWaitMs = Number.isFinite(requestedNativeWait) ? Math.max(60000, Math.min(300000, requestedNativeWait)) : 60000
      const receiver = new BrowserWindow({ ...screen.getDisplayMatching(win.getBounds()).workArea, frame: false, acceptFirstMouse: true, title: "Dialogue click-through check", show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
      let refresh: ReturnType<typeof setInterval> | null = null
      let diagnostics: ReturnType<typeof setInterval> | null = null
      let nativeStage = "bubble"
      let nativePassed = false
      let sampling = false
      const nativeTimeline: unknown[] = []
      let previousSample = ""
      const sampleNative = async () => {
        if (sampling) return
        sampling = true
        try {
          const sample = {
            stage: nativeStage,
            input: await run("window.__nativeInputProbe"),
            backgroundClicks: await receiver.webContents.executeJavaScript("Number(document.body.dataset.clicks)"),
            passthrough: options.getMousePassthrough(),
            focused: win.isFocused(),
          }
          const signature = JSON.stringify(sample)
          if (signature !== previousSample) {
            previousSample = signature
            if (nativeTimeline.length < 128) nativeTimeline.push(sample)
            process.stdout.write(`NATIVE_INPUT ${signature}\n`)
          }
        } finally { sampling = false }
      }
      try {
        await run(`window.__nativeInputProbe = { pointerMoves: 0, mouseMoves: 0, lastPosition: null };
          window.__nativePointerMove = event => { window.__nativeInputProbe.pointerMoves++; window.__nativeInputProbe.lastPosition = { x: event.clientX, y: event.clientY, buttons: event.buttons, trusted: event.isTrusted }; };
          window.__nativeMouseMove = event => { window.__nativeInputProbe.mouseMoves++; window.__nativeInputProbe.lastPosition = { x: event.clientX, y: event.clientY, buttons: event.buttons, trusted: event.isTrusted }; };
          document.addEventListener('pointermove', window.__nativePointerMove); document.addEventListener('mousemove', window.__nativeMouseMove); true`)
        await receiver.loadURL("data:text/html;charset=utf-8," + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Dialogue click-through check</title><body style="margin:0;background:#dcece5;font:16px sans-serif;color:#243c30"><p id="count" style="margin:16px">Background clicks: 0</p></body>'))
        await receiver.webContents.executeJavaScript(`document.body.dataset.clicks = '0'; document.addEventListener('click', () => { const n = Number(document.body.dataset.clicks) + 1; document.body.dataset.clicks = String(n); document.querySelector('#count').textContent = 'Background clicks: ' + n; }); true`)
        receiver.showInactive()
        win.showInactive()
        let refreshing = false
        const keepBubble = async () => {
          if (refreshing || await bubble()) return
          refreshing = true
          try {
            // Completion has a 3s cooldown; work-start has a 12s cooldown.
            // Each cycle visibly leaves HAPPY before returning to it.
            const turn = nextRun()
            await hook(turn, "UserPromptSubmit")
            await wait(700)
            await hook(turn, "Stop", { stopHookActive: false })
            await visible("run.completed.observed")
          } finally { refreshing = false }
        }
        await wait(1300)
        await keepBubble()
        refresh = setInterval(() => { void keepBubble().catch(() => {}) }, 4500)
        win.focus()
        await sampleNative()
        diagnostics = setInterval(() => { void sampleNative().catch(() => {}) }, 250)
        process.stdout.write("NATIVE_BUBBLE_READY: click the speech bubble over the green test window.\n")
        const deadline = Date.now() + nativeWaitMs
        let clicks = 0
        while (Date.now() < deadline && !clicks) {
          clicks = await receiver.webContents.executeJavaScript("Number(document.body.dataset.clicks)")
          await wait(100)
        }
        assert(clicks > 0, "native background click delivery")
        clearInterval(refresh); refresh = null
        while (refreshing) await wait(10)
        options.updateSettings({ speechBubblesEnabled: false }); await wait(100)
        options.updateSettings({ speechBubblesEnabled: true })
        win.focus()
        nativeStage = "face"
        await sampleNative()
        process.stdout.write("NATIVE_FACE_READY: click Gpichan's face.\n")
        await waitFor(`document.querySelector('.speech-bubble[data-trigger="interaction.head-tap"][data-phase="shown"]')?.textContent`, "native head interaction", nativeWaitMs)
        const afterFace = await receiver.webContents.executeJavaScript("Number(document.body.dataset.clicks)")
        report.nativeClickThrough = { backgroundReceivedClick: clicks > 0, faceStartedInteraction: true, faceDidNotClickBackground: afterFace === clicks }
        assert(afterFace === clicks, "native face input ownership")
        await shot("gpichan/native-head-tap.png")
        nativePassed = true
      } finally {
        if (diagnostics) clearInterval(diagnostics)
        while (sampling) await wait(10)
        await sampleNative()
        report.nativeInputEvents = await run(`(() => { const result = window.__nativeInputProbe; document.removeEventListener('pointermove', window.__nativePointerMove); document.removeEventListener('mousemove', window.__nativeMouseMove); delete window.__nativePointerMove; delete window.__nativeMouseMove; delete window.__nativeInputProbe; return result; })()`)
        if (refresh) clearInterval(refresh)
        receiver.destroy()
        await writeFile(join(options.evidenceDirectory, "native-input-attempt.json"), JSON.stringify({ passed: nativePassed, nativeWaitMs, timeline: nativeTimeline, input: report.nativeInputEvents }, null, 2) + "\n")
      }
    }
    // The user's small, bottom-right Toki layout, including its touch pose.
    const tokiResults: unknown[] = []
    for (const tokiCharacter of new Set(["asuma-toki-v2", process.env.ELECTRON_SMOKE_DIALOGUE_CHARACTER ?? "asuma-toki-v2"])) {
      await options.selectCharacter(tokiCharacter)
      await run(`window.__gpichanSmokeRandom = Math.random; Math.random = () => 0; true`)
      options.updateSettings({ speechBubblesEnabled: true, scale: 1 })
      const tokiTurn = await start(), tokiScale: unknown[] = []
      await checkStationarySpeech(`${tokiCharacter}-writing`)
      for (const scale of [280 / 460, .65, .8, 1, 1.25, 1.5, 720 / 460]) {
        options.updateSettings({ scale }); await wait(100)
        tokiScale.push({ scale, ...(await checkGeometry()) })
        if (scale === .65) await shot(`${tokiCharacter}/scale-65.png`)
      }
      report.tokiScale = tokiScale
      await hook(tokiTurn, "SessionEnd", { reason: "other" })
      await options.selectCharacter(tokiCharacter)
      options.updateSettings({ scale: .65 })
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      win.setBounds({ x: area.x + area.width - 299, y: area.y + area.height - 299, width: 299, height: 299 })
      await wait(400)
      win.webContents.sendInputEvent({ type: "mouseMove", x: 149, y: 61 })
      win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 149, y: 61 })
      await wait(60)
      win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 149, y: 61 })
      await visible("interaction.head-tap")
      report.tokiSmallTouch = await checkGeometry()
      await shot(`${tokiCharacter}/small-touch.png`)
      await captureScene(`${tokiCharacter}/small-touch-scene.png`)
      if (tokiCharacter === "asuma-toki-v3") {
        await options.selectCharacter(tokiCharacter)
        options.updateSettings({ scale: .65 })
        win.setBounds({ x: area.x + area.width - 299, y: area.y + area.height - 299, width: 299, height: 299 })
        // Pin the user's reported third torso-tap line without changing the pack.
        await run(`window.__gpichanSmokeRandom = Math.random; Math.random = () => .999; true`)
        await wait(400)
        // The shuffle bag visits all three torso poses before repeating one.
        for (let attempt = 0; attempt < 3; attempt++) {
          win.webContents.sendInputEvent({ type: "mouseMove", x: 149, y: 155 })
          win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: 149, y: 155 })
          await wait(60)
          win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: 149, y: 155 })
          await visible("interaction.torso-tap")
          const state = await checkGeometry()
          if (state.text === "주의를 끄는 데에는 성공하셨습니다.") {
            report.userReportedLine = state
            await shot("asuma-toki-v3/reported-line.png")
            await captureScene("asuma-toki-v3/reported-line-scene.png")
          }
          if (state.text === "저에게 맡기시겠습니까. 현명한 선택입니다.") {
            report.wrappedReportedLine = state
            assert(state.lineWidths.length === 2 && state.width < 200, "reported wrapped line keeps two compact lines")
            await shot("asuma-toki-v3/wrapped-line.png")
            await captureScene("asuma-toki-v3/wrapped-line-scene.png")
          }
          if (report.userReportedLine && report.wrappedReportedLine) break
          await waitFor(`!document.querySelector('.speech-bubble[data-trigger="interaction.torso-tap"]')`, "torso pose returns")
          await wait(400)
        }
        assert(report.userReportedLine, "user's exact reported line")
        assert(report.wrappedReportedLine, "user's wrapped line is reproduced")
      }
      assert((report.tokiSmallTouch as { artworkGap: number }).artworkGap <= 32, "touch bubble stays near visible artwork")
      assert(tokiScale.every(value => (value as { artworkGap: number }).artworkGap <= 32), "speech stays near artwork across scales")
      if (report.userReportedLine) assert((report.userReportedLine as { artworkGap: number }).artworkGap <= 32, "reported line stays close")
      tokiResults.push({ character: tokiCharacter, scales: tokiScale, smallTouch: report.tokiSmallTouch })
      report.tokiCharacter = tokiCharacter
    }
    report.tokiCharacters = tokiResults
    report.stationarySpeech = stability
    report.screenshots = screenshots
    report.warnings = []
    return report
  } catch (error) {
    await writeFile(join(options.evidenceDirectory, "failure.json"), JSON.stringify({ error: String(error), report, history: await run("window.__gpichanDialogueHistory"), native: await bubble() }, null, 2) + "\n")
    throw new Error(`Dialogue smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await run(`window.__gpichanDialogueObserver?.disconnect(); if (window.__gpichanSmokeRandom) Math.random = window.__gpichanSmokeRandom; delete window.__gpichanSmokeRandom; delete window.__gpichanDialogueObserver; delete window.__gpichanDialogueHistory`)
  }
}
