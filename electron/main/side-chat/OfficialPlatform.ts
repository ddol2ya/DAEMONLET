import { win32 } from "node:path"

export function officialSystemConfigFiles(platform = process.platform, env = process.env) {
  if (platform !== "win32") return ["/etc/codex/config.toml", "/etc/codex/managed_config.toml", "/etc/codex/requirements.toml"]
  const data = env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData"
  if (!win32.isAbsolute(data) || /[\0\r\n]/.test(data)) throw Error("CHAT_EXECUTION_POLICY")
  const root = win32.join(data, "OpenAI", "Codex")
  return [win32.join(root, "config.toml"), win32.join(root, "requirements.toml")]
}

/** Keep native credentials and system policy at their existing locations; never inherit commands or provider variables. */
export function officialRuntimeEnvironment(osHome: string, codexHome: string, temp: string, platform = process.platform, env = process.env): NodeJS.ProcessEnv {
  const common = { HOME: osHome, USERPROFILE: osHome, CODEX_HOME: codexHome, TMPDIR: temp, TMP: temp, TEMP: temp }
  if (platform !== "win32") return { ...common, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows"
  if (!win32.isAbsolute(systemRoot) || /[\0\r\n]/.test(systemRoot)) throw Error("CHAT_EXECUTION_POLICY")
  const result: NodeJS.ProcessEnv = { ...common, SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32") }
  for (const name of ["ProgramData", "APPDATA", "LOCALAPPDATA"]) {
    const value = env[name] ?? env[name.toUpperCase()]
    if (value !== undefined) {
      if (!win32.isAbsolute(value) || /[\0\r\n]/.test(value)) throw Error("CHAT_EXECUTION_POLICY")
      result[name] = value
    }
  }
  return result
}
