import {createHash} from 'node:crypto'

// Only explicit smoke runs use a private pipe. Ordinary Desktop discovery keeps
// Codex's fixed endpoint; no test can accidentally send controls to that endpoint.
export function windowsDesktopPipe(home, environment = process.env) {
  return (typeof __APP_QA__ === 'undefined' || __APP_QA__) && environment.ELECTRON_SMOKE_TEST === '1'
    ? `\\\\.\\pipe\\daemonlet-smoke-${createHash('sha256').update(home).digest('hex').slice(0, 24)}`
    : '\\\\.\\pipe\\codex-ipc'
}
