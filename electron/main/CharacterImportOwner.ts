import { randomUUID } from "node:crypto"

/** A document may request cancellation; only this Main-created operation owns
 * the registry transaction. A retired local picker never owns a remote update. */
export function characterImportOwner(document: string, kind: "local-import" | "remote-update") {
  return JSON.stringify([document, kind, randomUUID()])
}
