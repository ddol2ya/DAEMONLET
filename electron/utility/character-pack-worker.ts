import { parentPort, workerData } from "node:worker_threads"
import { extractCharacterPack } from "../main/CharacterPackArchive"
import { validatePackDirectory } from "../main/CharacterPackAssets"
import { packErrorCode, type PackProgress } from "../shared/character-pack-contract"

const task = workerData as { kind: "archive" | "directory"; path: string; transactionRoot?: string; rig?: boolean }
const progress = (value: PackProgress) => parentPort?.postMessage({ progress: value })
void (task.kind === "archive" ? extractCharacterPack(task.path, task.transactionRoot!, progress) : validatePackDirectory(task.path, { rig: task.rig, progress }))
  .then(value => parentPort?.postMessage({ ok: true, value }))
  .catch(error => parentPort?.postMessage({ ok: false, code: packErrorCode(error) }))
