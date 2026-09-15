import { homedir } from "node:os"
import { join } from "node:path"
import { connectVerifiedSideChat } from "../../electron/main/side-chat/SideChatPolicy"
let connection
try { connection = await connectVerifiedSideChat({ codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex") }); console.log(JSON.stringify({ status: "OFFICIAL_AUTH_STATE_LOADED_NOT_MODEL_TESTED", modelCalls: 0 })) }
catch (error) { console.log(JSON.stringify({ status: error instanceof Error ? error.message : "FAILED", stage: (error as any)?.stage, mismatches: (error as any)?.mismatches, modelCalls: 0 })); process.exitCode = 1 }
finally { await connection?.stop() }
