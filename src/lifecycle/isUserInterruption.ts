/** Internal cleanup and missing reasons must not be presented as a user stop. */
export function isUserInterruption(reason: string | null | undefined): boolean {
  return reason === "user-interrupted" || reason === "interrupted"
}
