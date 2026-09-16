/** Reviewed output/permission contract. Never inherit a parent's model or silently
 * switch an established conversation. Add candidates only with contract evidence. */
export const SIDE_CHAT_MODEL = { id: "gpt-5.6-luna", effort: "low" } as const
export const SIDE_CHAT_MODELS = [SIDE_CHAT_MODEL] as const
export function isSideChatModelAvailable(models: unknown): boolean {
  return Array.isArray(models) && models.some(model => model?.model === SIDE_CHAT_MODEL.id &&
    model.supportedReasoningEfforts?.some((level: any) => level.reasoningEffort === SIDE_CHAT_MODEL.effort))
}
