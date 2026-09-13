import { closeSync, lstatSync, openSync, readSync } from "node:fs"

export function isMachOMagic(bytes) {
  return ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(bytes.toString("hex"))
}

export function isSigningTarget(path) {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return false
  if (info.isDirectory()) return /\.(app|framework)$/.test(path)
  if (!info.isFile()) return false
  const handle = openSync(path, "r")
  const magic = Buffer.alloc(4)
  try { readSync(handle, magic, 0, 4, 0) }
  finally { closeSync(handle) }
  return isMachOMagic(magic)
}
