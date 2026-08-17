# Changelog

## 0.1.0

- Adapted in part from the community package `dsh-voice-input` (source attribution in README and LICENSE).
- Add standard DSH bundle patch (`dsh.bundle.patch`) and plugin id `dsh-voice-local`.
- Replace ScriptProcessor with AudioWorklet capture.
- Add browser-side silence detection for sentence-level real-time transcription.
- Add serialized segment append with synchronous latest-draft read (race-safe).
- Add background model download with progress, mirror URL list, SHA256 verification, retry, and offline manual import support.
- Add loopback/trustedHosts protected routes under `/dsh-voice-local/v1`.
- Add unit, route integration, model manager tests, and real-model smoke lane.
- Add npm publish + GitHub Actions release pipeline.
