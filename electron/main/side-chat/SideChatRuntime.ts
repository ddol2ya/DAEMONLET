/** Only an explicitly selected, byte-identical review runtime may read paginated
 * sources. No downloaded/bundled runtime and no automatic PATH replacement. */
export const PAGINATED_CHAT_RUNTIME = {
  version: "0.154.0+daemonlet-readonly-source-v1", platform: "darwin", arch: "arm64",
  upstreamCommit: "6b9826e3aa83b1a5947db50f4332cb9c65f1b340",
  executableSha256: "6f441d1d428c8b5c9a43e0cfd8794c03a11ae4a6e6a98f67e7c784362293ba22",
  executableBytes: 693849376, buildProfile: "dev-stripped-ad-hoc-review",
  model: "gpt-5.6-luna", parentContract: "read-only-source-v1", kind: "custom",
} as const
