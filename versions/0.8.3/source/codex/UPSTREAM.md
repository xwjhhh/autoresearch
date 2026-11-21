# Codex CLI / App Server source

This directory is an editable source snapshot of the upstream Codex CLI and App Server repository.

- Upstream: https://github.com/openai/codex
- Tag: `rust-v0.162.0-alpha.17.2`
- Commit: `740e5af33c71225640e0c1c1555c514c2c93ab74`
- License: Apache-2.0; keep `LICENSE` and `NOTICE` with redistributed source.

This is not the Codex desktop application's UI source. AutoResearch does not build or package this directory as part of its Windows installer. The snapshot is kept in the repository so it can be inspected and modified alongside the AutoResearch integration.

## Build and use

The upstream build guide is [`docs/install.md`](docs/install.md). It documents Windows 11 support through WSL2. A Linux executable built inside WSL2 cannot be launched directly by the native Windows AutoResearch app; the CLI executable must match the host platform.

AutoResearch checks `CODEX_CLI_PATH` before searching `PATH` and installed Codex locations. To test a compatible Windows build from a PowerShell session, set the variable before launching the development app:

```powershell
$env:CODEX_CLI_PATH = (Resolve-Path '.\codex\codex-rs\target\release\codex.exe').Path
npm start
```

For the installed app, set `CODEX_CLI_PATH` in the process environment before starting `AutoResearch.exe`. Restart AutoResearch after changing it. Verify the executable with `codex --version` before selecting it.
