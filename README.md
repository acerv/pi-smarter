# pi-smarter

A curated suite of extensions, Linux kernel development tools, and themes for the [Pi](https://pi.dev) coding agent.

`pi-smarter` turns Pi into a kernel triage and development environment with native tools for **Syzbot/Syzkaller bug triage and patch generation**, **lore.kernel.org mailing list tracking**, **Patchwork series analysis**, an **informative status footer**, and the **Tokyo Night** theme.

---

## What's Included

### 1. 🐞 Syzkaller / Syzbot (`extensions/syzkaller.ts`)
Triage and fix Linux kernel crashes from [syzbot](https://syzkaller.appspot.com) or local fuzzing runs.
- **Recent Bugs by Default**: Lists bugs active **today & yesterday** (< 48 hours) to focus on fresh regressions and currently reproducing issues.
- **On-Demand Scope**: Easily request all open bugs (`all`) or specify a count (`30`, `50`).
- **Subsystem & Repro Filtering**: Filter by subsystem (e.g. `fs`, `net`, `usb`, `bpf`, `kernel`, `mm`) or require C / syz reproducers.
- **Local Source Correlation**: Automatically finds faulting files in your working Linux repository, extracts code surrounding the crash line, highlights it with `-->`, and checks recent git commits.
- **Overview + Patch**: Performs in-depth root-cause analysis and generates production-ready `git diff` patches with `Fixes:`, `Reported-by:`, and `Signed-off-by:`.
- **Slash Commands**:
  ```bash
  /syzkaller              # List today & yesterday's bugs across upstream
  /syzkaller usb          # List today & yesterday's USB bugs
  /syzkaller usb all      # List all 170+ open USB bugs
  /syzkaller <extid|url>  # Deep dive: Overview + Patch for a specific bug
  /syz                    # Convenient short alias for /syzkaller
  ```

---

### 2. 📬 Lore Mailing List (`extensions/lore.ts`)
Interact with Linux kernel mailing lists on [lore.kernel.org](https://lore.kernel.org).
- **Read Patches & Threads (`lore_read_patch`)**: Fetches full patch submissions, cover letters, diffs, and reviewer feedback by lore URL or Message-ID.
- **List Submissions (`lore_list_patches`)**: Browse recent patch submissions by subsystem list (e.g., `netdev`, `bpf`, `linux-fsdevel`, `linux-mm`, `lkml`).
- **Slash Commands**:
  ```bash
  /lore https://lore.kernel.org/netdev/20261016.../
  /lore list netdev
  /lore list bpf 30
  ```

---

### 3. 🧩 Patchwork (`extensions/patchwork.ts`)
Seamless integration with Patchwork instances (e.g. `patchwork.kernel.org`, LTP Patchwork).
- **Series Resolution (`patchwork_fetch_series`)**: Resolves any standalone patch URL or cover letter into the complete series.
- **Full Review Context**: Fetches all patches, commit messages, diffs, and discussion comments.
- **Slash Command**:
  ```bash
  /patchwork https://patchwork.kernel.org/project/ltp/patch/as9x2R-9IQb7vjn7@toolbx/
  /patchwork https://patchwork.kernel.org/series/1185538/
  ```

---

### 4. 📊 Antigravity Status Footer (`extensions/antigravity-footer.ts`)
Multi-line terminal footer widget showing live session metrics:
- **Active Model**: Displays the currently active model and thinking mode.
- **Token Telemetry**: Live counter of input (↑), output (↓), and cache-read (R) tokens.
- **Context Window Usage**: Real-time context consumption percentage (e.g., `14.2%/1.0M`).
- **Quota & Reset Timer**: Displays remaining 5-hour and weekly usage quotas with reset countdowns.

---

### 5. 🌃 Tokyo Night Theme (`themes/tokyo-night.json`)
A dark theme for Pi inspired by Tokyo Night.
- Optimized for code syntax highlighting, diffs, tool execution panels, and terminal markdown rendering.

---

## Installation

### From GitHub

Install directly using Pi's package manager:

```bash
pi install git:github.com/cervesato/pi-smarter
```

### Local Development / Checkout

Clone and install locally:

```bash
git clone https://github.com/cervesato/pi-smarter.git ~/Projects/pi-smarter
cd ~/Projects/pi-smarter
pi install .
```

To test an individual extension without installing:

```bash
pi -e ./extensions/syzkaller.ts
```

---

## Quick Start

1. **Activate the theme** (if not already set):
   ```bash
   pi /theme tokyo-night
   ```

2. **Triage recent kernel bugs**:
   ```bash
   /syz usb
   ```
   *Displays bugs active in the last 48 hours.*

3. **Inspect a bug and get a fix**:
   ```bash
   /syz 8420e667af06b1709c00
   ```
   *Produces a root-cause overview and Linux kernel patch.*

4. **Follow mailing list discussions**:
   ```bash
   /lore list fsdevel
   ```

---

## Development

Run typecheck:

```bash
npm run typecheck
```

---

## License

[MIT](LICENSE) © 2026 Andrea Cervesato
