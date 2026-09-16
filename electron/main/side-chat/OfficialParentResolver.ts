import { realpath } from "node:fs/promises"
import type { AppServerJsonlClient } from "../../../adapter/codex/app-server/AppServerJsonlClient"
import type { ChatParent } from "./SideChatBackend"

/** Official stored-history reads only. Never resume a parent to discover its boundary.
 * Another process can see an unfinished persisted turn as interrupted. Neither
 * interrupted nor failed turns are a successful completion boundary. */
export async function resolveOfficialParent(client: AppServerJsonlClient, parent: ChatParent) {
  const value: any = await client.request("thread/read", { threadId: parent.threadId, includeTurns: false })
  const thread = value?.thread
  if (thread?.id !== parent.threadId || thread.ephemeral !== false || typeof thread.cwd !== "string") throw Error("PARENT_UNSUPPORTED")
  if (await realpath(thread.cwd) !== await realpath(parent.cwd)) throw Error("PARENT_UNSUPPORTED")
  let cursor: string | undefined
  const seen = new Set<string>()
  for (let n = 0; n < 10; n++) {
    const page: any = await client.request("thread/turns/list", { threadId: parent.threadId, limit: 100, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(page?.data)) throw Error("PARENT_UNSUPPORTED")
    const last = page.data.find((t: any) => typeof t?.id === "string" && t.status === "completed")
    if (last) return { lastTurnId: last.id as string, contextAt: typeof last.completedAt === "number" ? last.completedAt * 1000 : thread.updatedAt * 1000 }
    if (!page.nextCursor) break
    if (typeof page.nextCursor !== "string" || seen.has(page.nextCursor)) throw Error("PARENT_UNSUPPORTED")
    seen.add(page.nextCursor); cursor = page.nextCursor
  }
  throw Error("NO_PARENT")
}
