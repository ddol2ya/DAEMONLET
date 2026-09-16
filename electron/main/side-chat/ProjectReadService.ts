import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

export const PROJECT_READ_LIMITS = { fileBytes: 1024 * 1024, resultBytes: 32 * 1024, lines: 400, submissionBytes: 128 * 1024, files: 8 } as const
export type ProjectExcerpt = { path: string; startLine: number; endLine: number; readAt: number; text: string; truncated: boolean }
const denied = /^(?:auth(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.env(?:\..*)?|env(?:\..*)?)$/i
const textExtensions = new Set([".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".html", ".xml", ".yml", ".yaml", ".toml", ".rs", ".py", ".go", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".sh", ".sql", ".graphql", ".vue", ".svelte", ".rb", ".php"])
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino

/** User-selected excerpts only; there is no model-callable executor or shell.
 * Each read opens a fresh descriptor and validates identity before returning any
 * content. Root/ancestor replacements and linked/special files are rejected. */
export class ProjectReadService {
  private constructor(readonly root: string, private readonly rootIdentity: { dev: number; ino: number }) {}
  static async create(project: string, codexHome?: string): Promise<ProjectReadService> {
    const root = await realpath(project)
    const home = await realpath(homedir())
    const state = codexHome ? await realpath(codexHome) : join(home, ".codex")
    const stateRelative = relative(state, root).split(sep)
    const worktree = stateRelative[0] === "worktrees" && stateRelative.length >= 3
    if (root === dirname(root) || root === home || root === state || root.startsWith(state + sep) && !worktree || state.startsWith(root + sep) || root.split(sep).some(part => [".ssh", ".aws", ".gnupg"].includes(part))) throw Error("READ_ACCESS_DENIED")
    const info = await lstat(root)
    if (!info.isDirectory()) throw Error("READ_ACCESS_DENIED")
    return new ProjectReadService(root, info)
  }
  relativeSelection(path: string): string {
    const value = relative(this.root, path)
    if (!value || value.startsWith("..") || isAbsolute(value)) throw Error("READ_ACCESS_DENIED")
    return value.split(sep).join("/")
  }
  async assertCurrentRoot() {
    const current = await lstat(this.root)
    if (!current.isDirectory() || current.isSymbolicLink() || !same(current, this.rootIdentity) || await realpath(this.root) !== this.root) throw Error("READ_ACCESS_DENIED")
  }
  async readProjectText(path: string, startLine = 1, endLine = 400): Promise<ProjectExcerpt> {
    try { return await this.readChecked(path, startLine, endLine) }
    catch (error) { throw error instanceof Error && /^READ_/.test(error.message) ? error : Error("READ_ACCESS_DENIED") }
  }
  private async readChecked(path: string, startLine: number, endLine: number): Promise<ProjectExcerpt> {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine + 1 > PROJECT_READ_LIMITS.lines) throw Error("READ_LIMIT")
    if (typeof path !== "string" || path.length > 1024 || isAbsolute(path) || /[\\\u0000-\u001f\u007f:]/.test(path)) throw Error("READ_ACCESS_DENIED")
    const parts = path.split("/")
    if (parts.some(part => !part || part === ".." || part.startsWith(".") || denied.test(part))) throw Error("READ_ACCESS_DENIED")
    if (!textExtensions.has(extname(path).toLowerCase()) && !/^(?:README|LICENSE|NOTICE|Makefile|Dockerfile)$/i.test(basename(path))) throw Error("READ_ACCESS_DENIED")
    const file = resolve(this.root, ...parts)
    if (!file.startsWith(this.root + sep)) throw Error("READ_ACCESS_DENIED")
    const ancestors: Array<{ path: string; dev: number; ino: number }> = []
    let current = this.root
    for (const part of ["", ...parts.slice(0, -1)]) {
      current = part ? join(current, part) : current
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink() || (current === this.root && !same(info, this.rootIdentity))) throw Error("READ_ACCESS_DENIED")
      ancestors.push({ path: current, dev: info.dev, ino: info.ino })
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw Error("READ_ACCESS_DENIED") })
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1) throw Error("READ_ACCESS_DENIED")
      if (before.size > PROJECT_READ_LIMITS.fileBytes) throw Error("READ_LIMIT")
      const buffer = Buffer.alloc(before.size + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat(), entry = await lstat(file)
      if (!same(before, after) || !same(before, entry) || !entry.isFile() || entry.nlink !== 1 || after.nlink !== 1 || before.size !== after.size || bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(file) !== file) throw Error("READ_ACCESS_DENIED")
      for (const ancestor of ancestors) { const info = await lstat(ancestor.path); if (!same(info, ancestor) || !info.isDirectory() || info.isSymbolicLink()) throw Error("READ_ACCESS_DENIED") }
      let content: string
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)) } catch { throw Error("READ_ACCESS_DENIED") }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) throw Error("READ_ACCESS_DENIED")
      const lines = content.split(/\r?\n/)
      if (startLine > lines.length) throw Error("READ_LIMIT")
      const result: string[] = []
      let bytes = 0, last = startLine - 1
      for (let n = startLine; n <= Math.min(endLine, lines.length); n++) {
        const line = `${n}: ${lines[n - 1]}\n`, size = Buffer.byteLength(line)
        if (bytes + size > PROJECT_READ_LIMITS.resultBytes) break
        result.push(line); bytes += size; last = n
      }
      if (!result.length) throw Error("READ_LIMIT")
      return { path: parts.join("/"), startLine, endLine: last, readAt: Date.now(), text: result.join(""), truncated: last < lines.length }
    } finally { await handle.close() }
  }
}
