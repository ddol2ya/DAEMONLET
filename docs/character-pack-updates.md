# Character pack updates

DAEMONLET 0.7.2 supports optional updates for installed external packs from public, ungated Hugging Face Dataset repositories. Gpichan stays built in. Appearance names, pack release SemVer and app versions are independent. Each appearance needs a stable unique pack ID and its own feed; the app never matches names or substitutes another ID.

In Settings → Character & Display, each supported pack shows its exact repository and feed path. The first manual check confirms that source for a request. Automatic checks are separately opt-in, default off, delayed and spread across the day. Installation/selection alone makes no HF request. Download, cancel, validate and apply are separate user actions. Older packs need a one-time import of an update-enabled version of the same appearance.

## Data contract

`pack.json.update` is optional: `{schemaVersion:1, provider:"huggingface", repoType:"dataset", repoId:"owner/repository", manifestPath:"updates/appearance/stable.json"}`. Only packs with this descriptor carry `hf-pack-updates-v1`; both parser and exporter enforce the pairing. Pack format remains 1. Metadata changes require a higher pack `X.Y.Z` version.

A bounded 64 KiB feed contains only schemaVersion, packId, version, minAppVersion, runtime, artifact and plain-text notes (2,000 code points). The artifact contains its same-repository `.petchar` path, a full 40-character HF commit, compressed byte length and complete SHA-256. Runtime capabilities and source are rechecked against the archive validated by the existing Worker. A future runtime requires an app update; it is never installed as compatible.

Repository/path inputs are strict relative segments, rejecting encoded traversal, query/fragment, credentials, backslashes, URLs and unknown keys. Feed requests follow main; artifact requests pin the exact commit. The renderer receives narrow state/action DTOs and Main-generated candidate IDs, never download paths, arbitrary URLs or an import token for remote updates.

## Network and trust

Main uses `node:https` without Chromium cookies, Authorization or local HF credentials. HTTPS delivery hosts are an explicit list; every redirect and resolved IP is checked, private addresses are denied, and hops are bounded. The list follows [HF dataset download documentation](https://huggingface.co/docs/hub/datasets-downloading) and the legacy bridge described in [HF's Xet migration](https://huggingface.co/blog/migrating-the-hub-to-xet). Signed query strings are never stored in app preferences or included in application errors.

Metadata requests time out after 30 seconds; streams have a 30-second idle and 15-minute total limit. Manual checks have a 10-second minimum interval. ETag/304 caching is keyed to the entire confirmed source, with one unconditional retry for cacheless 304. 429 Retry-After/RateLimit and bounded backoff do not become an up-to-date status. Only one download/validation candidate exists at a time. Archives stream to a UUID app-owned transaction with enforced size, ZIP signature and SHA checks before prepareImport. Disk/payload limits and the existing 2 GiB/32 revision retention policy remain enforced.

Source consent, automatic-check choice, skipped version, last verified feed/ETag and check time live in a separate small atomic preferences file. Source changes need fresh confirmation. A hash establishes feed/file consistency, not a creator signature or account-compromise protection. No signing PKI or automatic source migration is claimed.

## Installation and concurrency

Download completion enters the existing `prepareImport` Worker, then compares ID, version, runtime and source. The candidate binds owner, source, original installed revision, feed commit/hash and the existing expiring import token. A removed, imported or restored revision invalidates it. Tokens start after download. Closing the owning settings document cancels unfinished work; shutdown prevents late work. Only service-owned UUID directories are recovered/cleaned at startup.

Apply enters `commitImport` and, for the active appearance, waits for the existing renderer-ready selection/recovery path. Registration alone is not displayed as visual success. Active responses or character transitions defer apply without stopping any parent/child task. Inactive pack updates preserve selection and conversation. Draft text is preserved by the existing persona transition policy. No LLM call is made by a pack update. App updater shutdown consults both registry and pack-update ownership, including downloads and validated candidates; busy work returns PACK_BUSY.

Restore previous version remains available and never triggers automatic reapplication. A skipped release suppresses its availability notice. Previously retained revisions are not silently garbage-collected. App feeds (`latest*.yml`) and HF character feeds (`stable.json`) stay separate.

## Production and publication

See the [update-source-only creator workflow](../skills/create-pet-character/references/updates.md) for executable repack, feed and exact-file publishing commands. Publish artifacts first, anonymously verify their pinned bytes, then publish feeds with the real artifact commit. Never overwrite a published `(packId, version)` path. Private plans, originals and review evidence stay outside Git/HF. Existing rights/provenance remain inside packs; app MIT licensing does not extend to original character artwork.

Validation distinguishes synthetic transport, actual HF readback, native QA builds, production candidate checks and unrun platforms. Private QA seeds may add a source to original versions solely in an isolated profile; those synthetic revisions must never be published.
