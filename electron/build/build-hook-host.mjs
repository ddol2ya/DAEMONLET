import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
if (process.platform === 'win32') {
  const root = resolve(import.meta.dirname, '../..')
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  const installation = execFileSync(vswhere, ['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'], { encoding: 'utf8', windowsHide: true }).trim()
  if (!installation) throw new Error('Windows Hook host requires the Visual Studio C++ build tools.')
  const work = join(tmpdir(), `daemonlet-hook-build-${randomUUID()}`)
  await mkdir(work)
  try {
    // The compiler's own environment script is fixed by vswhere; no download.
    const script = join(work, 'compile.cmd')
    await writeFile(script, `@echo off\r\ncall "${join(installation,'VC/Auxiliary/Build/vcvars64.bat')}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /O1 /GS- /Zl /TC "${join(root,'electron/native/windows/hook-host.c')}" /Fo"${join(work,'hook-host.obj')}" /link /NODEFAULTLIB /ENTRY:entry /SUBSYSTEM:CONSOLE /DYNAMICBASE /NXCOMPAT /OUT:"${join(root,'dist-electron/codex/hook-host.exe')}" kernel32.lib shell32.lib\r\n`, 'utf8')
    execFileSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d','/s','/c', `"${script}"`], { cwd: work, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
