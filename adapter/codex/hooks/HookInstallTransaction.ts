import { constants } from "node:fs"
import { access, lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { hashText, legacyHookCommands } from "./HookLaunchSpec.ts"
import { MAX_HOOK_FILE_BYTES, isObject, parseHooksFile, parseUniqueJson } from "./HookJson.ts"
import { fingerprintHandler, handlerIdentity, parseLegacyCommand, planHookEdit, type EventSupport, type HandlerIdentity, type HookEditPlan, type HookPlanAction, type OwnedChange, type OwnershipContext } from "./HookInstallPlan.ts"

type Identity = { dev: number; ino: number; uid: number; mode: number }
export type TargetSnapshot = { root: string; rootIdentity: Identity | null; parentIdentity: Identity; before: string | null; hash: string; identity: (Identity & { size: number; mtimeMs: number }) | null }
export type InstallationBinding = { targetPath: string; hostFingerprint: string; configFingerprint: string; capabilityFingerprint: string; targetVersion: string | null; appVersion: string; busy: boolean; blockers: string[] }
export type HookPlanSummary = {
  planId: string
  action: HookPlanAction
  targetDisplayPath: string
  expiresAt: number
  changes: HookEditPlan["changes"]
  warnings: string[]
  conflicts: string[]
  foreignHandlersPreserved: number
  generatedCommand: string | null
  restoredCommands: string[]
  requiresHookReview: boolean
  canApply: boolean
  changed: boolean
}
export type HookApplySummary = {
  status: "applied" | "no-change" | "applied-with-receipt-warning" | "committed-conflict"
  changed: boolean
  requiresHookReview: boolean
  warning: string | null
}
export type HookReceipt = {
  version: 1
  id: string
  previousReceiptId: string | null
  target: string
  createdAt: number
  phase: "prepared" | "applied" | "aborted-before-commit"
  abortedAt?: number
  beforeHash: string
  afterHash: string
  binding: Omit<InstallationBinding, "busy" | "blockers">
  inverse: OwnedChange
}
type PrivatePlan = { summary: HookPlanSummary; owner: string; generation: number; snapshot: TargetSnapshot; binding: InstallationBinding; edit: HookEditPlan; previousReceiptId: string | null }
export type TransactionPhase = "before-backup" | "before-temporary-write" | "before-final-check" | "before-rename" | "after-commit" | "before-receipt" | "before-abort-receipt"
export type HookTransactionOptions = {
  codexHome: string
  storageRoot: string
  context: OwnershipContext
  support: EventSupport
  getBinding: () => Promise<InstallationBinding>
  now?: () => number
  planTtlMs?: number
  phase?: (phase: TransactionPhase) => Promise<void>
}

const activeTargets = new Set<string>()
const snapshotHash = (before: string | null) => hashText(before === null ? "missing\0" : `file\0${before}`)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const uid = () => process.getuid?.() ?? 0
const identityOf = (stat: { dev: number; ino: number; uid: number; mode: number }): Identity => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode })
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"
const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value)

export async function canonicalCodexHome(path: string): Promise<string> {
  const requested = resolve(path)
  if (/[\0\r\n]/.test(requested)) throw new Error("INVALID_CODEX_HOME")
  try {
    if ((await lstat(requested)).isSymbolicLink()) throw new Error("SYMLINK_CODEX_HOME")
    return await realpath(requested)
  } catch (error) {
    if (!isMissing(error)) throw error
    return join(await realpath(dirname(requested)), basename(requested))
  }
}

async function directoryIdentity(path: string, privateDirectory = false): Promise<Identity> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (privateDirectory && (stat.uid !== uid() || (stat.mode & 0o077) !== 0))) throw new Error("UNSAFE_DIRECTORY")
  if (await realpath(path) !== path) throw new Error("NON_CANONICAL_ROOT")
  return identityOf(stat)
}

async function safeReadFile(path: string, limit = MAX_HOOK_FILE_BYTES, privateFile = false, allowRootOwner = false): Promise<{ contents: string; identity: NonNullable<TargetSnapshot["identity"]> } | null> {
  let handle: FileHandle | undefined
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || ![uid(), ...(allowRootOwner ? [0] : [])].includes(before.uid) || (before.mode & 0o022) !== 0 || (privateFile && (before.mode & 0o077) !== 0)) throw new Error("UNSAFE_FILE")
    if (before.size > limit) throw new Error("FILE_TOO_LARGE")
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!same(identityOf(before), identityOf(stat))) throw new Error("TARGET_IDENTITY_CHANGED")
    const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > limit) throw new Error("FILE_TOO_LARGE")
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (!same(identityOf(stat), identityOf(pathAfter)) || stat.size !== bytesRead || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error("TARGET_CHANGED_DURING_READ")
    return { contents: buffer.subarray(0, bytesRead).toString("utf8"), identity: { ...identityOf(stat), size: stat.size, mtimeMs: stat.mtimeMs } }
  } catch (error) {
    if (isMissing(error) && !handle) return null
    throw error
  } finally { await handle?.close() }
}

export async function readHookTarget(codexHome: string): Promise<TargetSnapshot> {
  if (!isAbsolute(codexHome) || resolve(codexHome) !== codexHome || /[\0\r\n]/.test(codexHome)) throw new Error("INVALID_CODEX_HOME")
  // Only a single missing user-selected home directory can be created. Never
  // recursively invent or walk a new tree outside its checked parent.
  const parentIdentity = await directoryIdentity(dirname(codexHome))
  let rootIdentity: Identity | null = null
  try {
    rootIdentity = await directoryIdentity(codexHome)
    if (rootIdentity.uid !== uid() || (rootIdentity.mode & 0o022) !== 0) throw new Error("UNSAFE_CODEX_HOME")
  } catch (error) { if (!isMissing(error)) throw error }
  const file = rootIdentity ? await safeReadFile(join(codexHome, "hooks.json")) : null
  return { root: codexHome, rootIdentity, parentIdentity, before: file?.contents ?? null, hash: snapshotHash(file?.contents ?? null), identity: file?.identity ?? null }
}

// Read-only bounded inspection for config.toml. The caller decides how much
// structured information to expose; no raw bytes cross the Settings boundary.
export async function readSetupConfig(path: string, allowRootOwner = false): Promise<string | null> {
  return (await safeReadFile(path, MAX_HOOK_FILE_BYTES, false, allowRootOwner))?.contents ?? null
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(contents, "utf8"); await handle.sync() } finally { await handle.close() }
}

async function writeProtectedJson(path: string, value: unknown, beforeRename?: () => Promise<void>): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    await writeExclusive(temporary, `${JSON.stringify(value, null, 2)}\n`)
    await beforeRename?.()
    await rename(temporary, path)
  }
  finally { await unlink(temporary).catch(() => {}) }
}

type TargetLock = { assertOwned: () => Promise<void>; release: () => Promise<void> }
type AbortableReceipt = {
  receipt: HookReceipt
  contents: string
  storageIdentity: Identity
  latestBefore: Awaited<ReturnType<typeof safeReadFile>>
}

function bindingSignature(binding: InstallationBinding): string {
  return hashText(JSON.stringify([binding.targetPath, binding.hostFingerprint, binding.configFingerprint, binding.capabilityFingerprint, binding.targetVersion, binding.appVersion, binding.blockers]))
}

export class HookInstallTransaction {
  private readonly plans = new Map<string, PrivatePlan>()
  private readonly generations = new Map<string, number>()
  private readonly applies = new Map<string, { owner: string; promise: Promise<HookApplySummary> }>()
  private readonly inFlight = new Set<Promise<HookApplySummary>>()
  private closed = false
  private readonly now: () => number
  readonly target: string
  private readonly latestPath: string
  private readonly options: HookTransactionOptions

  constructor(options: HookTransactionOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.target = join(options.codexHome, "hooks.json")
    this.latestPath = join(options.storageRoot, `latest-${hashText(this.target)}.json`)
  }

  invalidateOwner(owner: string): void {
    if (!this.generations.has(owner)) return
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1)
    for (const [id, plan] of this.plans) if (plan.owner === owner) this.plans.delete(id)
  }

  private receiptPath(id: string): string {
    if (!validId(id)) throw new Error("INVALID_RECEIPT")
    return join(this.options.storageRoot, `${id}.receipt.json`)
  }

  async receipts(): Promise<{ identities: HandlerIdentity[]; last: HookReceipt | null; recovery: "none" | "committed" | "not-committed" | "diverged" | "unavailable" }> {
    const identities: HandlerIdentity[] = []
    let last: HookReceipt | null = null
    let recovery: "none" | "committed" | "not-committed" | "diverged" | "unavailable" = "none"
    try {
      try { await directoryIdentity(this.options.storageRoot, true) } catch (error) {
        if (isMissing(error)) return { identities, last, recovery }
        throw error
      }
      const latest = await safeReadFile(this.latestPath, 4096, true)
      if (!latest) return { identities, last, recovery }
      const pointer = parseUniqueJson(latest.contents)
      if (!isObject(pointer) || !validId(pointer.id)) throw new Error("INVALID_RECEIPT")
      let id: string | null = pointer.id
      const seen = new Set<string>()
      // previousReceiptId is written only from receipts().last, a confirmed
      // successful change. That link also preserves a prior prepared receipt
      // whose commit was verified but whose final receipt write had failed.
      let referencedAsPreviousSuccess = false
      for (let count = 0; id && count < 32; count++) {
        if (seen.has(id)) throw new Error("INVALID_RECEIPT")
        seen.add(id)
        const contents = await safeReadFile(this.receiptPath(id), MAX_HOOK_FILE_BYTES, true)
        const receipt = contents ? parseUniqueJson(contents.contents) as HookReceipt : null
        if (!receipt || receipt.version !== 1 || receipt.id !== id || receipt.target !== this.target
          || !["prepared", "applied", "aborted-before-commit"].includes(receipt.phase)
          || (receipt.previousReceiptId !== null && !validId(receipt.previousReceiptId))
          || (receipt.phase === "aborted-before-commit" && !Number.isSafeInteger(receipt.abortedAt)) || !isObject(receipt.inverse)
          || !Array.isArray(receipt.inverse.beforeOwned) || !Array.isArray(receipt.inverse.afterOwned)) throw new Error("INVALID_RECEIPT")
        if (receipt.phase === "aborted-before-commit") {
          // This process durably recorded that target rename never started.
          // Later user edits cannot turn it back into an uncertain crash. None
          // of this attempt's proposed handlers establishes ownership.
          if (!last) recovery = "not-committed"
          referencedAsPreviousSuccess = true
          id = receipt.previousReceiptId
          continue
        }
        let successful = receipt.phase === "applied" || referencedAsPreviousSuccess
        if (!last && !successful) {
          const current = await readHookTarget(this.options.codexHome)
          if (current.hash === receipt.afterHash) { recovery = "committed"; successful = true }
          else if (current.hash === receipt.beforeHash) recovery = "not-committed"
          else { recovery = "diverged"; break }
        }
        if (!last && successful) last = receipt
        for (const placement of [...receipt.inverse.beforeOwned, ...(successful ? receipt.inverse.afterOwned : [])]) {
          if (!isObject(placement.handler) || typeof placement.handler.command !== "string") throw new Error("INVALID_RECEIPT")
          identities.push(handlerIdentity(placement.handler))
        }
        referencedAsPreviousSuccess = true
        id = receipt.previousReceiptId
      }
      return { identities, last, recovery }
    } catch { return { identities: [], last: null, recovery: "unavailable" } }
  }

  async prepare(action: HookPlanAction, owner: string): Promise<HookPlanSummary> {
    if (this.closed) throw new Error("INSTALLER_CLOSED")
    this.invalidateOwner(owner)
    if (!this.generations.has(owner)) this.generations.set(owner, 1)
    const generation = this.generations.get(owner) ?? 0
    const snapshot = await readHookTarget(this.options.codexHome)
    const binding = await this.options.getBinding()
    if (binding.targetPath !== this.target) throw new Error("PLAN_STALE")
    const receipts = await this.receipts()
    const context = { ...this.options.context, receipts: [...(this.options.context.receipts ?? []), ...receipts.identities] }
    const blockers = [...binding.blockers, ...(binding.busy ? ["ACTIVE_RUN"] : [])]
    if (receipts.recovery === "diverged" || receipts.recovery === "unavailable") blockers.push("RECEIPT_RECOVERY_REQUIRED")
    const edit = planHookEdit({ action, before: snapshot.before, context, support: this.options.support, revert: receipts.last?.inverse, blockers })
    if (Buffer.byteLength(JSON.stringify({ inverse: edit.inverse }, null, 2)) > MAX_HOOK_FILE_BYTES - 16384) {
      edit.conflicts.push("PLAN_TOO_COMPLEX")
      edit.changed = false
      edit.after = snapshot.before
    }
    if (this.closed || this.generations.get(owner) !== generation) throw new Error("PLAN_SUPERSEDED")
    const summary: HookPlanSummary = {
      planId: randomUUID(), action, targetDisplayPath: this.target, expiresAt: this.now() + (this.options.planTtlMs ?? 5 * 60_000),
      changes: edit.changes.slice(0, 256), warnings: edit.warnings, conflicts: edit.conflicts.slice(0, 64),
      foreignHandlersPreserved: edit.foreignHandlerCount,
      generatedCommand: action === "install" || action === "repair" ? String(context.desiredHandler.command) : null,
      restoredCommands: action === "revert-owned-change" && edit.changed ? [...new Set(edit.inverse.afterOwned.map((item) => String(item.handler.command)))] : [],
      requiresHookReview: edit.changed, canApply: edit.conflicts.length === 0, changed: edit.changed,
    }
    // Keep a bounded number of Main-only snapshots even if a renderer floods
    // preview requests. Each window's prior plan is already invalidated above.
    if (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(summary.planId, { summary, owner, generation, snapshot, binding, edit, previousReceiptId: receipts.last?.id ?? null })
    return structuredClone(summary)
  }

  apply(planId: string, owner: string): Promise<HookApplySummary> {
    const existing = this.applies.get(planId)
    if (existing) return existing.owner === owner ? existing.promise : Promise.reject(new Error("PLAN_OWNER_MISMATCH"))
    const plan = this.plans.get(planId)
    if (!plan || this.closed) return Promise.reject(new Error("PLAN_UNKNOWN"))
    if (plan.owner !== owner) return Promise.reject(new Error("PLAN_OWNER_MISMATCH"))
    this.plans.delete(planId)
    const promise = this.commit(plan)
    this.inFlight.add(promise)
    void promise.then(() => this.inFlight.delete(promise), () => this.inFlight.delete(promise))
    this.applies.set(planId, { owner, promise })
    // Result promises are reused for double clicks; retain only a bounded cache.
    if (this.applies.size > 32) this.applies.delete(this.applies.keys().next().value!)
    return promise
  }

  private async ensureStorage(): Promise<Identity> {
    if (!isAbsolute(this.options.storageRoot) || resolve(this.options.storageRoot) !== this.options.storageRoot || /\.app(?:\/|$)/.test(this.options.storageRoot)) throw new Error("UNSAFE_STORAGE")
    await directoryIdentity(dirname(this.options.storageRoot))
    try { await mkdir(this.options.storageRoot, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
    return directoryIdentity(this.options.storageRoot, true)
  }

  private async assertStorage(expected: Identity): Promise<void> {
    if (!same(await directoryIdentity(this.options.storageRoot, true), expected)) throw new Error("UNSAFE_STORAGE")
  }

  private assertApproval(plan: PrivatePlan): void {
    if (plan.summary.expiresAt <= this.now()) throw new Error("PLAN_EXPIRED")
    if (this.closed || this.generations.get(plan.owner) !== plan.generation) throw new Error("PLAN_SUPERSEDED")
  }

  private async acquireLock(): Promise<TargetLock> {
    const path = join(this.options.codexHome, ".daemonlet-hooks.lock")
    const rootIdentity = await directoryIdentity(this.options.codexHome)
    const create = () => open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let handle: FileHandle
    try { handle = await create() } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // A dead cooperating installer may leave a lock. Only recover a checked,
      // app-formatted lock whose process is proven absent. PID reuse stays busy.
      const lock = await safeReadFile(path, 4096, true)
      let stale = false
      try {
        const parsed = lock ? parseUniqueJson(lock.contents) : null
        if (isObject(parsed) && parsed.owner === "daemonlet-hook-installer" && Number.isSafeInteger(parsed.pid) && Number(parsed.pid) > 0) {
          try { process.kill(Number(parsed.pid), 0) } catch (probe) { stale = (probe as NodeJS.ErrnoException).code === "ESRCH" }
        }
      } catch { /* unknown lock is never removed */ }
      if (!stale || !lock || !same(identityOf(await lstat(path)), identityOf(lock.identity))) throw new Error("TARGET_BUSY")
      await unlink(path)
      try { handle = await create() } catch { throw new Error("TARGET_BUSY") }
    }
    const identity = identityOf(await handle.stat())
    const contents = JSON.stringify({ owner: "daemonlet-hook-installer", pid: process.pid, id: randomUUID() })
    try { await handle.writeFile(contents); await handle.sync() }
    catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error }
    const assertOwned = async () => {
      if (!same(await directoryIdentity(this.options.codexHome), rootIdentity)) throw new Error("TARGET_BUSY")
      const current = await safeReadFile(path, 4096, true)
      if (!current || !same(identityOf(current.identity), identity) || current.contents !== contents) throw new Error("TARGET_BUSY")
    }
    return { assertOwned, release: async () => {
      await handle.close()
      try { await assertOwned(); await unlink(path) } catch { /* never remove another owner's replacement */ }
    } }
  }

  private async retireAbortedReceipt(attempt: AbortableReceipt, lock: TargetLock): Promise<void> {
    const { receipt, contents, storageIdentity, latestBefore } = attempt
    const ownPointer = `${JSON.stringify({ id: receipt.id }, null, 2)}\n`
    const assertContext = async () => {
      await lock.assertOwned()
      await this.assertStorage(storageIdentity)
      const latest = await safeReadFile(this.latestPath, 4096, true)
      // Publication may itself have failed before latest changed. In either
      // case only our exact attempt is retired; latest is never rolled back.
      if (latest?.contents !== ownPointer && !same(latest, latestBefore)) throw new Error("PLAN_STALE")
      const current = await safeReadFile(this.receiptPath(receipt.id), MAX_HOOK_FILE_BYTES, true)
      if (current?.contents !== contents) throw new Error("PLAN_STALE")
    }
    await this.options.phase?.("before-abort-receipt")
    await assertContext()
    const aborted: HookReceipt = { ...receipt, phase: "aborted-before-commit", abortedAt: this.now() }
    await writeProtectedJson(this.receiptPath(receipt.id), aborted, assertContext)
    await lock.assertOwned()
    await this.assertStorage(storageIdentity)
    const directory = await open(this.options.storageRoot, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!same(identityOf(await directory.stat()), storageIdentity)) throw new Error("UNSAFE_STORAGE")
      await directory.sync()
    } finally { await directory.close() }
    const verified = await safeReadFile(this.receiptPath(receipt.id), MAX_HOOK_FILE_BYTES, true)
    if (verified?.contents !== `${JSON.stringify(aborted, null, 2)}\n`) throw new Error("INVALID_RECEIPT")
  }

  private async assertTarget(plan: PrivatePlan, createdRoot: Identity | null): Promise<void> {
    const current = await readHookTarget(this.options.codexHome)
    const expectedRoot = plan.snapshot.rootIdentity ?? createdRoot
    if (current.hash !== plan.snapshot.hash || !same(current.identity, plan.snapshot.identity)
      || !same(current.rootIdentity, expectedRoot) || !same(current.parentIdentity, plan.snapshot.parentIdentity)) throw new Error("PLAN_STALE")
  }

  private async assertUnchanged(plan: PrivatePlan, createdRoot: Identity | null): Promise<void> {
    await this.assertTarget(plan, createdRoot)
    const binding = await this.options.getBinding()
    if (binding.busy) throw new Error("ACTIVE_RUN")
    if (binding.targetPath !== this.target) throw new Error("PLAN_STALE")
    if (bindingSignature(binding) !== bindingSignature(plan.binding)) throw new Error("PLAN_STALE")
  }

  private async commit(plan: PrivatePlan): Promise<HookApplySummary> {
    this.assertApproval(plan)
    if (!plan.summary.canApply) throw new Error("PLAN_BLOCKED")
    if (activeTargets.has(this.target)) throw new Error("TARGET_BUSY")
    activeTargets.add(this.target)
    let lock: TargetLock | null = null
    let temporary: string | null = null
    let targetCommit: "not-started" | "started" | "renamed" | "verified" = "not-started"
    let abortable: AbortableReceipt | null = null
    try {
      await this.assertUnchanged(plan, null)
      this.assertApproval(plan)
      if (!plan.edit.changed) return { status: "no-change", changed: false, requiresHookReview: false, warning: null }
      if (plan.snapshot.identity && (plan.snapshot.identity.mode & 0o200) === 0) throw new Error("TARGET_NOT_WRITABLE")
      let createdRoot: Identity | null = null
      if (!plan.snapshot.rootIdentity) {
        try { await mkdir(this.options.codexHome, { mode: 0o700 }) } catch { throw new Error("PLAN_STALE") }
        createdRoot = await directoryIdentity(this.options.codexHome, true)
      }
      lock = await this.acquireLock()
      const ownedLock = lock
      await this.assertUnchanged(plan, createdRoot)
      const storageIdentity = await this.ensureStorage()
      const latestBefore = await safeReadFile(this.latestPath, 4096, true)
      const receipt: HookReceipt = {
        version: 1, id: plan.summary.planId, previousReceiptId: plan.previousReceiptId, target: this.target, createdAt: this.now(), phase: "prepared",
        beforeHash: plan.snapshot.hash, afterHash: snapshotHash(plan.edit.after),
        binding: { targetPath: this.target, hostFingerprint: plan.binding.hostFingerprint, configFingerprint: plan.binding.configFingerprint, capabilityFingerprint: plan.binding.capabilityFingerprint, targetVersion: plan.binding.targetVersion, appVersion: plan.binding.appVersion },
        inverse: plan.edit.inverse,
      }
      const receiptContents = `${JSON.stringify(receipt, null, 2)}\n`
      if (Buffer.byteLength(receiptContents) > MAX_HOOK_FILE_BYTES) throw new Error("PLAN_BLOCKED")
      await this.options.phase?.("before-backup")
      this.assertApproval(plan)
      await this.assertStorage(storageIdentity)
      await this.assertTarget(plan, createdRoot)
      if (plan.snapshot.before !== null) await writeExclusive(join(this.options.storageRoot, `${receipt.id}.backup`), plan.snapshot.before)
      await this.assertStorage(storageIdentity)
      await writeExclusive(this.receiptPath(receipt.id), receiptContents)
      abortable = { receipt, contents: receiptContents, storageIdentity, latestBefore }
      await this.assertStorage(storageIdentity)
      await writeProtectedJson(this.latestPath, { id: receipt.id }, async () => {
        await ownedLock.assertOwned()
        await this.assertStorage(storageIdentity)
        if (!same(await safeReadFile(this.latestPath, 4096, true), latestBefore)) throw new Error("PLAN_STALE")
      })
      temporary = join(this.options.codexHome, `.hooks-${randomUUID()}.tmp`)
      await this.options.phase?.("before-temporary-write")
      await this.assertTarget(plan, createdRoot)
      await writeExclusive(temporary, plan.edit.after!)
      await this.options.phase?.("before-final-check")
      await this.assertUnchanged(plan, createdRoot)
      await this.options.phase?.("before-rename")
      await ownedLock.assertOwned()
      const temporaryCheck = await safeReadFile(temporary, MAX_HOOK_FILE_BYTES, true)
      if (!temporaryCheck || snapshotHash(temporaryCheck.contents) !== receipt.afterHash) throw new Error("PLAN_STALE")
      // One final target comparison after every awaited hook/config check. This
      // is not filesystem CAS against editors that ignore the cooperating lock.
      const final = await readHookTarget(this.options.codexHome)
      if (final.hash !== plan.snapshot.hash || !same(final.identity, plan.snapshot.identity) || !same(final.rootIdentity, plan.snapshot.rootIdentity ?? createdRoot)) throw new Error("PLAN_STALE")
      this.assertApproval(plan)
      targetCommit = "started"
      await rename(temporary, this.target)
      targetCommit = "renamed"
      temporary = null
      await this.options.phase?.("after-commit")
      const verified = await readHookTarget(this.options.codexHome)
      if (verified.hash !== receipt.afterHash) return { status: "committed-conflict", changed: true, requiresHookReview: true, warning: "POST_COMMIT_CONFLICT" }
      targetCommit = "verified"
      // Commit is durable before publishing a successful receipt. A failed
      // receipt update never triggers a destructive whole-file rollback.
      const directory = await open(this.options.codexHome, constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
      try {
        await this.options.phase?.("before-receipt")
        await this.assertStorage(storageIdentity)
        await writeProtectedJson(this.receiptPath(receipt.id), { ...receipt, phase: "applied" })
      } catch { return { status: "applied-with-receipt-warning", changed: true, requiresHookReview: true, warning: "RECEIPT_WRITE_FAILED" } }
      return { status: "applied", changed: true, requiresHookReview: true, warning: null }
    } catch (error) {
      if (targetCommit === "renamed" || targetCommit === "verified") return { status: "committed-conflict", changed: true, requiresHookReview: true, warning: "POST_COMMIT_VERIFICATION_FAILED" }
      // A rejected rename is not evidence that it did not happen. Leave its
      // prepared record for verified recovery, never mark this outcome aborted.
      if (targetCommit === "started") throw new Error("COMMIT_OUTCOME_UNKNOWN")
      if (abortable && lock) {
        try { await this.retireAbortedReceipt(abortable, lock) }
        catch { throw new Error("ABORT_RECEIPT_WRITE_FAILED") }
      }
      const message = error instanceof Error ? error.message : "FILESYSTEM_ERROR"
      if (/^[A-Z_]+$/.test(message)) throw error
      throw new Error("FILESYSTEM_ERROR")
    } finally {
      if (temporary) await unlink(temporary).catch(() => {})
      await lock?.release().catch(() => { /* A stale lock must not relabel a verified file commit as unapplied. The next plan safely reports TARGET_BUSY. */ })
      activeTargets.delete(this.target)
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.plans.clear()
    await Promise.allSettled([...this.inFlight])
    this.applies.clear()
    this.generations.clear()
  }
}

// This digest identifies the exact legacy forwarder shipped at the Phase 12A
// baseline. Paths alone never establish receipt-less migration ownership.
export const LEGACY_FORWARDER_HASHES: ReadonlySet<string> = new Set(["80f8abcacf6624af6ef4dd8e1ecc9fb1cb372c970d31cf93fbde1673997c33b1"])

export async function discoverLegacyHandlers(before: string | null, currentForwarderHash?: string | null): Promise<OwnershipContext["legacyHandlers"]> {
  const result: NonNullable<OwnershipContext["legacyHandlers"]> = []
  const checked = new Set<string>()
  for (const groups of Object.values(parseHooksFile(before).hooks ?? {})) for (const group of groups) for (const handler of group.hooks) {
    if (typeof handler.command !== "string") continue
    const paths = parseLegacyCommand(handler.command)
    if (!paths || checked.has(handler.command) || checked.size >= 64) continue
    checked.add(handler.command)
    const expected = { type: "command", ...legacyHookCommands(paths.executablePath, paths.forwarderPath), timeout: 1 }
    if (fingerprintHandler(handler) !== fingerprintHandler(expected) || basename(paths.executablePath) !== "node") continue
    try {
      const source = await safeReadFile(paths.forwarderPath, 128 * 1024)
      const executable = await lstat(paths.executablePath)
      if (!source || !(LEGACY_FORWARDER_HASHES.has(hashText(source.contents)) || hashText(source.contents) === currentForwarderHash) || await realpath(paths.forwarderPath) !== paths.forwarderPath
        || !executable.isFile() || ![0, uid()].includes(executable.uid) || (executable.mode & 0o022) !== 0) continue
      await access(paths.executablePath, constants.X_OK)
      result.push(expected)
    } catch { /* ambiguous until the exact legacy resource can be verified */ }
  }
  return result
}
