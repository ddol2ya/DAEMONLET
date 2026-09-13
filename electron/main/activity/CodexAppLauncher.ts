import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isAbsolute, join } from "node:path"
import { realpath, stat } from "node:fs/promises"

const execute = promisify(execFile)
// Fixed host-owned query. No Protocol/renderer string becomes a URL or command.
const REGISTERED_CODEX = 'ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("com.openai.codex"); u.isNil() ? "" : ObjC.unwrap(u.path);'
type Runner = (file: string, args: string[]) => Promise<string>
const run: Runner = async (file, args) => (await execute(file, args, { timeout: 5000, maxBuffer: 16 * 1024, encoding: "utf8", shell: false })).stdout.trim()

export class CodexAppLauncher {
  private opening = false
  constructor(private readonly options: { platform?: NodeJS.Platform; run?: Runner; realpath?: typeof realpath; stat?: typeof stat } = {}) {}

  private async target(): Promise<string | null> {
    if ((this.options.platform ?? process.platform) !== "darwin") return null
    const execute = this.options.run ?? run
    try {
      const registered = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", REGISTERED_CODEX])
      if (!isAbsolute(registered) || !registered.endsWith(".app") || registered.length > 4096 || /[\0\r\n]/.test(registered)) return null
      const path = await (this.options.realpath ?? realpath)(registered)
      if (!path.endsWith(".app") || !(await (this.options.stat ?? stat)(path)).isDirectory()) return null
      if (await execute("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents/Info.plist")]) !== "com.openai.codex") return null
      await execute("/usr/bin/codesign", ["--verify", "--strict", "-R", '=identifier "com.openai.codex" and anchor apple generic', path])
      return path
    } catch { return null }
  }

  async available(): Promise<boolean> { return (await this.target()) !== null }
  async bundledExecutable(): Promise<string | null> {
    const target = await this.target()
    return target ? join(target, "Contents/Resources/codex") : null
  }
  async open(): Promise<"opened" | "unavailable" | "failed"> { return this.openTarget() }
  async openThread(threadId: string): Promise<"opened" | "unavailable" | "failed"> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) return "unavailable"
    return this.openTarget(threadId)
  }
  private async openTarget(threadId?: string): Promise<"opened" | "unavailable" | "failed"> {
    if (this.opening) return "failed"
    this.opening = true
    try {
      const path = await this.target()
      if (!path) return "unavailable"
      const execute = this.options.run ?? run
      if (threadId) {
        const schemes = JSON.parse(await execute("/usr/bin/plutil", ["-extract", "CFBundleURLTypes", "json", "-o", "-", join(path, "Contents/Info.plist")]))
        if (!Array.isArray(schemes) || !schemes.some(value => Array.isArray(value?.CFBundleURLSchemes) && value.CFBundleURLSchemes.includes("codex"))) return "unavailable"
      }
      // ChatGPT 26.903.61454's Copy Deeplink/URL handler validates this exact UUID route.
      await execute("/usr/bin/open", ["-a", path, ...(threadId ? [`codex://threads/${threadId}`] : [])])
      return "opened"
    } catch { return "failed" } finally { this.opening = false }
  }
}
