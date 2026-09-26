# App-server stream lifetime after RPC cancellation

PR #26's first usage implementation detached the JSONL client's `error` listeners
at logical close. A pending Writable callback could later deliver EPIPE without
any listener and terminate the owning process. A separate Node reproduction
confirmed this regression; it did not establish that a whole installed application
had crashed. The attached review's client blob matched the reviewed source
(`e092ff9767898fe3a9b438fe3e9f70ec3f926814`).

The common client now replaces its stateful error handlers with one passive guard
per stream at logical close. This guard holds no client/RPC state, remains through
pending IO errors and is removed when the stream emits physical `close`. A WeakSet
prevents duplicate guards for a shared duplex. Repeated logical close remains a
no-op. Data/end listeners, buffered data, pending RPC timers/maps, event listeners
and backpressure drain waits still retire immediately. Only safe numeric RPC error
codes are retained; upstream error message/data are not exposed.

Transport ownership stays unchanged:

- `AppServerProcess` owns its spawned Codex process and stops that handle. Its exit
  event can precede pipe closure, so the common guard protects late pipe errors.
- `ChatProcess`, used by usage and side chat, owns its child handle and waits for
  close. Its redundant per-pipe anonymous error handlers were removed: it now
  inherits exactly the same common policy as observer clients.
- `AppServerSocketClient` closes the RPC client before destroying its synthetic
  Readable/Writable and terminating its own websocket connection. Those stream
  errors are protected through physical close; the websocket retains its separate
  error/close handlers. No Codex process is terminated by this socket transport.

No global uncaught-error handler, relaxed assertion/timeout, skipped regression,
account policy or permission change is part of the fix.

Regression tests run delayed EPIPE, readable end/error followed by writable error,
and backpressure cancellation in independent Node children with strict unhandled
rejection handling. No global error-swallowing handler is installed in the test
child. They verify normal exit, zero pending RPC/drain/data listeners, and removal
of the passive guards at physical close. A shared-duplex case verifies deduplication.
A second independent fixture starts real synthetic child processes through both
`AppServerProcess` and `ChatProcess`, blocks stdin, cancels large pending writes,
repeats stop and verifies the child PIDs are gone. These fixtures perform no Codex
login, account lookup, model call or real task operation. Existing usage reader and
service tests cover cancellation, owned temporary-directory cleanup and generations.

The supplied reproduction fails before the fix and exits normally after the fix
on Node 22.23.0/macOS arm64. Local full regression after this change: 197 files,
2,003 tests passed and five existing skips; type checking, renderer build,
production Electron build and `release:verify` also passed. Final candidate and
Windows results must be identified separately from this source-level evidence.

0.8.1 is a candidate version. A version bump and source/ASAR validation do not mean
that a public release, Apple notarization, native installer upgrade or updater
publication has completed. Older 0.8.0 package evidence is not relabeled as 0.8.1.
