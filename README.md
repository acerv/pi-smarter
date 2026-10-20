# pi-smarter

A set of [Pi](https://pi.dev) harness customizations for my workflow.
It includes:

- Linux kernel development tools
- Workflow guidelines
- Token-saving mode
- Antigravity status footer
- Tokyo Night theme

## Install

```bash
pi install git:github.com/cervesato/pi-smarter
```

Or for local development and companion setup:

```bash
git clone https://github.com/cervesato/pi-smarter.git
cd pi-smarter
./setup.sh
```

To test an extension without installing:

```bash
pi -e ./extensions/syzkaller.ts
```

## Extensions

### Syzkaller (`/syz`, `/syzkaller`)

Triage syzbot bugs and local crash logs directly in Pi. Fetches reports, correlates stack traces with your local kernel checkout, and helps draft fixes.

```bash
/syz                 # List recent upstream bugs (last 48h)
/syz usb             # List recent bugs in a subsystem
/syz usb all         # List all open bugs in a subsystem
/syz <extid | url>   # Analyze bug, correlate local source, and generate fix
```

### Lore (`/lore`)

Browse and inspect patch series from [lore.kernel.org](https://lore.kernel.org).

```bash
/lore list netdev    # Browse recent submissions
/lore list bpf 20    # List latest 20 patches in bpf
/lore <url | msgid>  # Read patch or thread with review comments
```

### Patchwork (`/patchwork`)

Browse and review patches from Patchwork instances (e.g. `patchwork.kernel.org`, LTP).

```bash
/patchwork list ltp             # List recent LTP patches
/patchwork list netdev 30 tcp   # Search recent netdev patches
/patchwork read <id | url>      # Fetch full series, diffs, and comments
```

### Status Footer

Multi-line footer widget displaying:

- Active model and thinking mode
- Live token usage (in / out / cache)
- Context window utilization
- Antigravity quota and reset countdowns

```bash
/antigravity.footer toggle    # Enable or disable footer
/antigravity.footer refresh   # Manually refresh quota
```

### Workflow Guidelines

Automatically injects project workflow guidelines and conventions
(found in `rules/guidelines.md`) into every session's agent context.

### Save Tokens (`/save_tokens`)

Toggle terse output mode to optimize for fewer output tokens:

```bash
/save_tokens          # Toggle on/off
/save_tokens on       # Enable terse mode
/save_tokens off      # Disable terse mode
/save_tokens status   # Show current status
```

## Theme

Includes the Tokyo Night dark theme:

```bash
pi /theme tokyonight
```

## License

[MIT](LICENSE)
