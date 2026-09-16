// Main process only. Locked after restart consent, before any asynchronous preparation.
let locked = false
export const applicationInputAllowed = () => !locked
export const setApplicationInputLocked = (value: boolean) => { locked = value }
