import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const HOME = os.homedir();

const SECRET_DIRS = [
	path.join(HOME, ".ssh"),
	path.join(HOME, ".gnupg"),
	path.join(HOME, ".aws"),
	path.join(HOME, ".config", "gcloud"),
	path.join(HOME, ".kube"),
];

const SECRET_FILES = new Set([
	path.join(HOME, ".pi", "agent", "auth.json"),
	path.join(HOME, ".netrc"),
	path.join(HOME, ".npmrc"),
	path.join(HOME, ".pypirc"),
]);

interface BashRule {
	label: string;
	pattern: RegExp;
	hardBlock?: boolean;
}

const BASH_RULES: BashRule[] = [
	{
		label: "sudo execution",
		pattern: /(?:^|[;&|()\s])sudo\b/,
		hardBlock: true,
	},
	{
		label: "recursive or force deletion (rm -rf / find -delete)",
		pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--(?:recursive|force)\s+){1,}|\bfind\b.*\s-delete\b/,
	},
	{
		label: "destructive git working-tree reset/clean",
		pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--|restore\s+(?!--staged\b))/,
	},
	{
		label: "git history or remote mutation (commit/push/rebase/branch -D)",
		pattern: /\bgit\s+(?:commit|push|rebase|merge|cherry-pick|am|branch\s+-D|tag\s+-d)\b/,
	},
	{
		label: "low-level disk / permission mutation",
		pattern: /(?:^|[;&|()\s])(?:mkfs(?:\.\w+)?|dd\s+if=|chmod\s+-R|chown\s+-R)\b/,
	},
	{
		label: "piping remote script to shell",
		pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:ba)?sh\b/,
	},
];

function expandPath(rawPath: string, cwd: string): string {
	const trimmed = rawPath.trim().replace(/^@/, "");
	if (trimmed === "~") return HOME;
	if (trimmed.startsWith("~/")) return path.resolve(HOME, trimmed.slice(2));
	return path.resolve(cwd, trimmed);
}

function isWithin(target: string, parentDir: string): boolean {
	const rel = path.relative(parentDir, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isSecretPath(resolvedPath: string): string | null {
	if (SECRET_FILES.has(resolvedPath)) {
		return `Protected credential file: ${resolvedPath}`;
	}

	for (const dir of SECRET_DIRS) {
		if (isWithin(resolvedPath, dir)) {
			return `Protected credential directory: ${dir}`;
		}
	}

	const base = path.basename(resolvedPath);
	if (
		(base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) ||
		base.endsWith(".pem") ||
		base.endsWith(".key")
	) {
		return `Protected secret file pattern: ${base}`;
	}

	return null;
}

function isProtectedWritePath(resolvedPath: string): string | null {
	const secretReason = isSecretPath(resolvedPath);
	if (secretReason) return secretReason;

	const segments = resolvedPath.split(path.sep);
	if (segments.includes(".git")) {
		return "Direct modification inside .git/ is blocked";
	}

	return null;
}

function mentionsSecretInBash(command: string): string | null {
	if (/(?:^|[\s"'=/])(?:\.ssh|\.gnupg|\.aws|\.config\/gcloud|\.netrc|auth\.json)(?:$|[\s"'/])/.test(command)) {
		return "Command accesses protected credential path";
	}
	return null;
}

export default function activate(pi: ExtensionAPI): void {
	const approvedWriteDirs = new Set<string>(["/tmp"]);
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;
	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		approvedWriteDirs.clear();
		approvedWriteDirs.add("/tmp");
		checkpoints.clear();
		if (ctx.hasUI) {
			ctx.ui.setStatus("safety", enabled ? "🛡️ safety" : "");
		}
	});

	// Silent git checkpoint before each turn so `/fork` can recover working tree state
	pi.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("turn_start", async () => {
		if (!enabled) return;
		try {
			const { stdout, code } = await pi.exec("git", ["stash", "create"]);
			const ref = stdout.trim();
			if (code === 0 && ref && currentEntryId) {
				checkpoints.set(currentEntryId, ref);
			}
		} catch {
			// Not a git repository or git unavailable
		}
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref || !ctx.hasUI) return;

		const choice = await ctx.ui.select("Restore working tree to checkpoint before this turn?", [
			"No, keep current files",
			"Yes, restore checkpoint",
		]);

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Working tree restored to checkpoint", "info");
		}
	});

	pi.on("tool_call", async (event, ctx: ExtensionContext) => {
		if (!enabled) return undefined;

		const tool = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;

		// 1. Read-only file tools: allow everywhere except credential/secret files
		if (tool === "read" || tool === "grep" || tool === "find" || tool === "ls") {
			const rawPath = typeof input.path === "string" ? input.path : ".";
			const resolved = expandPath(rawPath, ctx.cwd);
			const secretReason = isSecretPath(resolved);
			if (secretReason) {
				return { block: true, reason: secretReason };
			}
			return undefined;
		}

		// 2. File mutation tools: allow inside cwd, block secrets/.git, ask once per external directory
		if (tool === "edit" || tool === "write") {
			if (typeof input.path !== "string") return undefined;
			const resolved = expandPath(input.path, ctx.cwd);

			const protectedReason = isProtectedWritePath(resolved);
			if (protectedReason) {
				if (ctx.hasUI) ctx.ui.notify(protectedReason, "warning");
				return { block: true, reason: protectedReason };
			}

			if (isWithin(resolved, ctx.cwd)) {
				return undefined;
			}

			for (const allowedDir of approvedWriteDirs) {
				if (isWithin(resolved, allowedDir)) {
					return undefined;
				}
			}

			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `Write outside cwd blocked in non-interactive mode: ${resolved}`,
				};
			}

			const targetDir = path.dirname(resolved);
			const choice = await ctx.ui.select(
				`Allow ${tool} outside working directory?\n\n  File: ${resolved}\n  CWD:  ${ctx.cwd}`,
				[
					"Allow once",
					`Allow directory for session (${targetDir})`,
					"Block",
				],
			);

			if (choice === `Allow directory for session (${targetDir})`) {
				approvedWriteDirs.add(targetDir);
				return undefined;
			}
			if (choice === "Allow once") {
				return undefined;
			}

			return { block: true, reason: `User blocked external ${tool}: ${resolved}` };
		}

		// 3. Bash tool: silent allow for normal build/test/inspect, gate only high-risk commands
		if (tool === "bash") {
			const command = typeof input.command === "string" ? input.command : "";

			const secretAccess = mentionsSecretInBash(command);
			if (secretAccess) {
				if (ctx.hasUI) ctx.ui.notify(secretAccess, "warning");
				return { block: true, reason: secretAccess };
			}

			for (const rule of BASH_RULES) {
				if (!rule.pattern.test(command)) continue;

				if (rule.hardBlock) {
					const reason = `Blocked by safety policy (${rule.label}): ${command}`;
					if (ctx.hasUI) ctx.ui.notify(reason, "warning");
					return { block: true, reason };
				}

				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `High-impact command blocked in non-interactive mode (${rule.label})`,
					};
				}

				const approved = await ctx.ui.confirm(
					`Confirm ${rule.label}`,
					`${command}\n\nAllow this command?`,
				);

				if (!approved) {
					return { block: true, reason: `Blocked by user (${rule.label})` };
				}
				return undefined;
			}
		}

		return undefined;
	});

	pi.registerCommand("safety", {
		description: "Inspect or toggle safety-gate: /safety [on|off|status]",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else if (arg === "toggle") enabled = !enabled;

			ctx.ui.setStatus("safety", enabled ? "🛡️ safety" : "");
			const dirs = [...approvedWriteDirs].join(", ");
			ctx.ui.notify(
				`safety-gate: ${enabled ? "ON" : "OFF"} | session-allowed write dirs: ${dirs}`,
				"info",
			);
		},
	});
}
