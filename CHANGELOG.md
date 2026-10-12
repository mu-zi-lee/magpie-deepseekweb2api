# Changelog

## 0.1.1

- Make separate userToken and optional Cookie prompts the default sign-in flow.
- Validate and save credentials automatically without requiring hand-written JSON.
- Retain multi-account JSON import as a separate sign-in option.
- Test both sign-in flows through unit tests, the release archive, and the real Magpie Bun host.

## 0.1.0

- Initial DeepSeek Web Magpie provider.
- Internal multi-key pool with sticky sessions, cooldowns, and concurrency limits.
- DeepSeekHashV1 proof-of-work, SSE patch streaming, continuation, and JSON responses.
- Cookie import with DeepSeek-domain filtering.
- Request cancellation, session serialization, bounded session state, and integration tests.
- Protocol-error detection for empty/malformed streams and continuation response merging.
- Detect truncated streams, support CRLF event framing, bound frame size, and cancel abandoned upstream readers.
- Preserve key health and stop retries when a client cancels with a custom reason.
- Import credentials through Magpie's paste callback and keep pool configuration out of SDK authorization headers.
- Reuse account pools across loader calls, hash cache identifiers, and release unused pools through weak references.
- Route Reasoner fragments and compressed deltas by type, handle batch patches, and deduplicate both continuation channels.
- Add a real Bun-host smoke test for sign-in, model discovery, failover, streaming and reload behavior.
- Apply byte-based output backpressure, close completion iterators on cancellation, and interrupt stalled SSE reads.
- Solve PoW cooperatively with a deadline so RPC and cancellation stay responsive.
- Bound cumulative answer and reasoning output, including continuations, and fail syntax checks immediately.
- Reuse matching conversation history through fixed-size digests, send new turns only, and rebuild full context on account changes.
- Require complete history for delta-only clients that switch accounts instead of silently dropping context.
- Preserve tool-only history and text parts, validate message shapes, and allow disabled expired keys during import.
- Reject duplicate credentials, test release archives after extraction, and cover supported Node runtimes in CI.
