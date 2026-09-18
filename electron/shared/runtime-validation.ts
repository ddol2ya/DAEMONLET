import { MAX_PROTOCOL_MESSAGE_BYTES, PROTOCOL_VERSION, type ProtocolClientCommand } from "../../src/protocol/types"
import type { PetReadyInfo } from "./ipc-contract"
import { isRevision } from "./character-pack-contract"
import { parseCharacterLoadTicket } from "./character-load"

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const canonicalId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value)
const only = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).every((key) => fields.includes(key))

export function validateProtocolClientCommand(value: unknown): ProtocolClientCommand | null {
  if (!record(value) || value.protocolVersion !== PROTOCOL_VERSION || !canonicalId(value.requestId) || typeof value.commandType !== "string") return null
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_PROTOCOL_MESSAGE_BYTES) return null
  if (value.commandType === "client.hello") {
    if (!only(value, ["protocolVersion", "commandType", "requestId", "clientId", "supportedProtocolVersions"]) || !canonicalId(value.clientId) || !Array.isArray(value.supportedProtocolVersions) || value.supportedProtocolVersions.length !== 1 || value.supportedProtocolVersions[0] !== PROTOCOL_VERSION) return null
    return value as ProtocolClientCommand
  }
  if (value.commandType === "snapshot.request") {
    if (!only(value, ["protocolVersion", "commandType", "requestId", "reason"]) || !["initial", "reconnect", "sequence-gap", "manual"].includes(String(value.reason))) return null
    return value as ProtocolClientCommand
  }
  if (value.commandType === "client.ping") {
    if (!only(value, ["protocolVersion", "commandType", "requestId", "sentAt"]) || typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt) || value.sentAt < 0) return null
    return value as ProtocolClientCommand
  }
  return null
}

export function validatePetReadyInfo(value: unknown): PetReadyInfo | null {
  if (!record(value) || !only(value, ["webgl", "characterId", "revision", "firstFrameAt", "ticket"]) || value.webgl !== true || !canonicalId(value.characterId) || value.revision !== "builtin" && !isRevision(value.revision) || typeof value.firstFrameAt !== "number" || !Number.isFinite(value.firstFrameAt) || !parseCharacterLoadTicket(value.ticket)) return null
  const ticket = parseCharacterLoadTicket(value.ticket)!
  if (ticket.id !== value.characterId || ticket.revision !== value.revision) return null
  return value as PetReadyInfo
}

export function validateShortMessage(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 1_000 && !value.includes("\0") ? value : null
}
