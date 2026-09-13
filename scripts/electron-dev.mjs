import electronPath from "electron"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const children = new Set()
const run = (command, args, env = process.env) => {
  const child = spawn(command, args, { cwd: root, env, stdio: "inherit", shell: false })
  children.add(child)
  child.once("exit", () => children.delete(child))
  return child
}
const stop = () => { for (const child of children) child.kill("SIGTERM") }
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

try {
  await fetch("http://127.0.0.1:4173/pet.html")
  throw new Error("Port 4173 is already serving another process")
} catch (error) {
  if (error instanceof Error && error.message === "Port 4173 is already serving another process") throw error
}

const vite = run(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "--port", "4173", "--strictPort", "--host", "127.0.0.1"])
let ready = false
for (let attempt = 0; attempt < 100; attempt++) {
  if (vite.exitCode !== null) throw new Error(`Vite exited before readiness (${vite.exitCode})`)
  try { if ((await fetch("http://127.0.0.1:4173/pet.html")).ok) { ready = true; break } } catch { /* wait for Vite */ }
  await new Promise((resolveWait) => setTimeout(resolveWait, 100))
}
if (!ready) { stop(); throw new Error("Vite did not become ready within 10 seconds") }
const electron = run(electronPath, [resolve(root, "dist-electron/main.cjs")], { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:4173" })
electron.once("exit", (code) => { stop(); process.exitCode = code ?? 1 })
vite.once("exit", (code) => { if (code !== 0 && electron.exitCode === null) electron.kill("SIGTERM") })
