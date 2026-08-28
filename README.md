# dsh-sandbox-permissions-not-strictly-wider-justification-empty-fix

English | [中文](README.zh.md)

A DSH plugin that fixes two related bugs in the `sandbox_permissions` and `justification` fields across four tools: `pwsh`, `bash`, `fs` (write/edit), and `dsh-sandbox`.

## The Bug

When a session is already at `danger-full-access` mode, two errors can occur:

1. **Empty justification**: The model sends `justification: ""` (empty string), which triggers `validateEscalationArgs` to throw `invalid justification: expected a non-empty sentence`.
2. **No-op escalation**: The model sends `sandbox_permissions: "danger-full-access"` (same as current mode), which triggers `approveEscalation` to throw `sandbox escalation to "X" is not strictly wider`.

This is the 4th independent report ([GitHub #3519](https://github.com/deepseek-ai/deepseek-harness/discussions/3519) → [#4359](https://github.com/deepseek-ai/deepseek-harness/discussions/4359) → [#4383](https://github.com/deepseek-ai/deepseek-harness/discussions/4383) → [#4412](https://github.com/deepseek-ai/deepseek-harness/discussions/4412)) and affects all sessions using non-default models.

## The Fix

Two-layer defense:

1. **Schema descriptions**: Updated to clearly explain that same-mode retries are accepted as no-ops, reducing the model's tendency to send empty fields.
2. **Runtime normalization**: Added normalization logic at each tool's execute/resolvePolicy entry point to clear escalation parameters when the requested mode is not strictly wider than the effective mode.

## How It Works

- **Install** (`dsh plugin add`): The plugin is installed and Cordis injects the dynamic plugin line.
- **First load**: The `apply()` function in `index.js` runs `patch.js apply`, which backs up original files and applies all modifications. This happens automatically on first plugin load.
- **Auto-repair**: On every client start/restart, the plugin checks if patches are still valid. If patches are lost (e.g., after a desktop client update), it automatically re-applies them.
- **Multi-target**: The plugin detects both DSH_HOME and desktop installation directories. If the hard link is broken (e.g., after a desktop update), it modifies both locations.
- **Uninstall** (`dsh plugin remove`): The `preuninstall` script runs `patch.js restore`, which restores all original files from backups.

## Installation

```sh
dsh plugin --profile <your-profile> add github:yajiangandchenchen/dsh-sandbox-permissions-not-strictly-wider-justification-empty-fix
```

## Uninstallation

```sh
dsh plugin --profile <your-profile> remove dsh-sandbox-permissions-not-strictly-wider-justification-empty-fix
```

## What Gets Modified

| File | Change |
|------|--------|
| `dsh-sandbox/lib/index.js` | `approveEscalation`: throw → return effectiveMode |
| `dsh-tool-pwsh/lib/index.js` | import +WIDER_MODES, execute normalization, schema descriptions |
| `dsh-tool-bash/lib/index.js` | import +WIDER_MODES, execute normalization, schema descriptions |
| `dsh-tool-fs/lib/index.js` | import +WIDER_MODES, resolvePolicy normalization, schema descriptions |

## Compatibility

- Compatible with the latest `dsh-std` plugin meta protocol
- Does not conflict with other plugins (modifies only tool implementation files)
- Works with both desktop and web installations (modifies DSH_HOME, which is hard-linked to the desktop app)

## License

MIT
