// Rules contain categories only. Findings never contain matched source text.
const rules = [
  ['home-path', /(?:[A-Z]:[\\/]+Users[\\/]+|(?<![\w/])\/(?:Users|home)\/)([\w.-]+)/gi],
  ['private-host', /\b(?:[\w-]+\.)+[\w-]+\.ts\.net\b|\b[\w-]+\.local\b/gi],
  ['private-ip', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g],
  ['private-workspace', /\b[A-Z]:[\\/]+(?:ComfyUI[^\s'"`;,)]*|Projects[\\/]+[^\s'"`;,)]*)/gi],
  ['credential', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{50,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bAKIA[A-Z0-9]{16}\b/g],
]

export function sourcePathFindings(path) {
  return /(^|\/)(outputs|node_modules|\.codex|\.agents|__pycache__)(\/|$)|(^|\/)\.env|\.(p12|p8|pem|safetensors|ckpt|pt|pth|onnx|gguf|pyc)$/i.test(path)
    ? [{path, line: 1, type: 'private-or-generated-file'}] : []
}

/** @param {string} text @param {string} path @param {{privateMarkers?: string[], allowExamples?: boolean}} [options] */
export function scanSourceText(text, path, {privateMarkers = [], allowExamples = true} = {}) {
  const findings = []
  for (const [index, raw] of text.split('\n').entries()) {
    // Fold adjacent quoted fragments without evaluating code or changing line numbers.
    const line = raw.replace(/(['"])\s*\+\s*\1/g, '').replaceAll('\\\\', '\\')
    for (const [type, pattern] of rules) {
      pattern.lastIndex = 0
      for (const match of line.matchAll(pattern)) {
        // Reserved, explicit example identities only; no directory-wide exemptions.
        if (allowExamples && type === 'home-path' && /^(example-user|user|test|runner|Public|Default)$/i.test(match[1])) continue
        findings.push({path, line: index + 1, type}); break
      }
    }
    if (privateMarkers.some(value => raw.includes(value) || line.includes(value))) findings.push({path, line: index + 1, type: 'private-marker'})
  }
  return findings
}
