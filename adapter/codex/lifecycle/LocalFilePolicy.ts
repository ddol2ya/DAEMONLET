// Windows access checks are performed by the OS ACL, not Node's synthetic Unix
// uid/mode fields. Callers must still check canonical ancestry, links and file
// identity; this predicate alone does not establish a safe path or a private ACL.
export const hasLocalFilePermissions = (info: { uid: number; mode: number }): boolean =>
  process.platform === "win32" || info.uid === process.getuid?.() && (info.mode & 0o022) === 0
