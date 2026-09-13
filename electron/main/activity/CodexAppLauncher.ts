import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { isAbsolute, join, win32 } from "node:path"
import { realpath, stat } from "node:fs/promises"

const execute = promisify(execFile)
// Fixed host-owned queries. No Protocol/renderer string becomes a URL or command.
const REGISTERED_CODEX = 'ObjC.import("AppKit"); var u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("com.openai.codex"); u.isNil() ? "" : ObjC.unwrap(u.path);'
const REGISTERED_WINDOWS_CODEX = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security')
$p = Get-AppxPackage -Name OpenAI.Codex | Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' } | Select-Object -First 1
if ($null -eq $p) { return }
$m = Get-AppxPackageManifest -Package $p.PackageFullName
$a = $m.Package.Applications.Application | Where-Object { $_.Id -eq 'App' } | Select-Object -First 1
if ($null -eq $a -or [string]::IsNullOrWhiteSpace($a.Executable)) { return }
$root = [IO.Path]::GetFullPath($p.InstallLocation).TrimEnd([char]92)
$path = [IO.Path]::GetFullPath((Join-Path $root $a.Executable))
if (!$path.StartsWith($root + [char]92, [StringComparison]::OrdinalIgnoreCase)) { return }
$s = Get-AuthenticodeSignature -LiteralPath $path
[ordered]@{
  family = $p.PackageFamilyName; publisher = $p.Publisher; status = [string]$p.Status
  development = [bool]$p.IsDevelopmentMode; signatureKind = [string]$p.SignatureKind
  root = $root; path = $path; signatureStatus = [string]$s.Status; signer = $s.SignerCertificate.Subject
  supportsThreads = [bool](@($a.Extensions.Extension | Where-Object { $_.Category -eq 'windows.protocol' -and $_.Protocol.Name -eq 'codex' }).Count)
} | ConvertTo-Json -Compress
`

type Runner = (file: string, args: string[]) => Promise<string>
type Launch = (file: string, args: string[]) => Promise<void>
type AppTarget = { platform: "darwin" | "win32"; path: string; supportsThreads?: boolean }
const run: Runner = async (file, args) => (await execute(file, args, { timeout: 10000, windowsHide: true, maxBuffer: 16 * 1024, encoding: "utf8", shell: false })).stdout.trim()
const launch: Launch = (file, args) => new Promise((resolve, reject) => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // The GUI outlives this request; execFile would wait for the app to close.
  const child = spawn(file, args, { detached: true, stdio: "ignore", shell: false, env })
  child.once("error", reject)
  child.once("spawn", () => { child.unref(); resolve() })
})

export class CodexAppLauncher {
  private opening = false
  constructor(private readonly options: { platform?: NodeJS.Platform; run?: Runner; realpath?: typeof realpath; stat?: typeof stat; launch?: Launch } = {}) {}

  private async target(): Promise<AppTarget | null> {
    const platform = this.options.platform ?? process.platform
    if (platform === "win32") return this.windowsTarget()
    if (platform !== "darwin") return null
    const execute = this.options.run ?? run
    try {
      const registered = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", REGISTERED_CODEX])
      if (!isAbsolute(registered) || !registered.endsWith(".app") || registered.length > 4096 || /[\0\r\n]/.test(registered)) return null
      const path = await (this.options.realpath ?? realpath)(registered)
      if (!path.endsWith(".app") || !(await (this.options.stat ?? stat)(path)).isDirectory()) return null
      if (await execute("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents/Info.plist")]) !== "com.openai.codex") return null
      await execute("/usr/bin/codesign", ["--verify", "--strict", "-R", '=identifier "com.openai.codex" and anchor apple generic', path])
      return { platform: "darwin", path }
    } catch { return null }
  }

  private async windowsTarget(): Promise<AppTarget | null> {
    try {
      const powershell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
      const value = JSON.parse(await (this.options.run ?? run)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", REGISTERED_WINDOWS_CODEX]))
      if (!value || value.family !== "OpenAI.Codex_2p2nqsd0c76g0" || value.publisher !== "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B" ||
          value.status !== "Ok" || value.development !== false || value.signatureKind !== "Store" || value.signatureStatus !== "Valid" ||
          typeof value.signer !== "string" || !/(?:^|,\s*)O="?OpenAI OpCo, LLC"?(?:,|$)/.test(value.signer)) return null
      for (const path of [value.root, value.path]) {
        if (typeof path !== "string" || !/^[a-z]:[\\/]/i.test(path) || path.length > 4096 || /[\0\r\n]/.test(path)) return null
      }
      const canonical = this.options.realpath ?? realpath
      const [root, path] = await Promise.all([canonical(value.root), canonical(value.path)])
      const relative = win32.relative(root, path)
      if (!relative || win32.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || win32.extname(path).toLowerCase() !== ".exe" ||
          !(await (this.options.stat ?? stat)(path)).isFile()) return null
      return { platform: "win32", path, supportsThreads: value.supportsThreads === true }
    } catch { return null }
  }

  async available(): Promise<boolean> { return (await this.target()) !== null }
  async bundledExecutable(): Promise<string | null> {
    const target = await this.target()
    return target?.platform === "darwin" ? join(target.path, "Contents/Resources/codex") : null
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
      const target = await this.target()
      if (!target) return "unavailable"
      const { path } = target
      if (target.platform === "win32") {
        if (threadId && !target.supportsThreads) return "unavailable"
        await (this.options.launch ?? launch)(path, threadId ? [`codex://threads/${threadId}`] : [])
        return "opened"
      }
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
