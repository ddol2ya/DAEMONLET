const SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|bearer\s+[A-Za-z0-9._~-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi
const HOME_PATH = /\/(?:Users|home)\/[^/\s]+/g
const CONTROL = /[\u0000-\u001f\u007f]/g

export function redactDiagnosticText(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value
    .replace(SECRET, "[REDACTED]")
    .replace(HOME_PATH, "$HOME")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
  return clean ? clean.slice(0, maxLength) : undefined
}

export function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback
  const clean = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 80)
  return clean || fallback
}
