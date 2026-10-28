import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface QuotaBucket {
	bucketId: string;
	displayName: string;
	window?: string;
	remainingFraction?: number;
	resetTime?: string;
}

interface QuotaGroup {
	displayName: string;
	buckets: QuotaBucket[];
}

interface QuotaState {
	gemini5h?: number;
	gemini5hReset?: string;
	geminiWeekly?: number;
	geminiWeeklyReset?: string;
	claude5h?: number;
	claude5hReset?: string;
	claudeWeekly?: number;
	claudeWeeklyReset?: string;
	lastFetched: number;
	error?: string;
}

let cachedQuota: QuotaState | null = null;
let isFetching = false;
let footerEnabled = true;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home?: string): string {
	if (!home) return cwd;
	const resolvedCwd = path.resolve(cwd);
	const resolvedHome = path.resolve(home);
	const relativeToHome = path.relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${path.sep}${relativeToHome}`;
}

function formatReset(resetTime?: string): string {
	if (!resetTime) return "";
	const ts = Date.parse(resetTime);
	if (!Number.isFinite(ts)) return "";
	const delta = ts - Date.now();
	if (delta <= 0) return "resets now";
	const totalMin = Math.round(delta / 60000);
	const days = Math.floor(totalMin / (60 * 24));
	const hours = Math.floor((totalMin % (60 * 24)) / 60);
	const mins = totalMin % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${mins}m`;
	return `${mins}m`;
}

async function getAntigravityToken(ctx?: ExtensionContext | ExtensionCommandContext): Promise<string | null> {
	if (ctx?.modelRegistry) {
		try {
			const apiKeyRaw = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
			if (apiKeyRaw) {
				try {
					const parsed = JSON.parse(apiKeyRaw) as { token?: string };
					if (parsed.token) return parsed.token;
				} catch {
					return apiKeyRaw;
				}
			}
		} catch {
			// fall back to auth.json
		}
	}

	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		if (fs.existsSync(authPath)) {
			const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
			if (auth.antigravity?.access) {
				return auth.antigravity.access;
			}
		}
	} catch {
		// ignore
	}

	return null;
}

async function fetchQuota(ctx?: ExtensionContext | ExtensionCommandContext): Promise<QuotaState | null> {
	if (isFetching) return cachedQuota;
	isFetching = true;

	try {
		const token = await getAntigravityToken(ctx);
		if (!token) return null;

		const endpoints = [
			"https://daily-cloudcode-pa.googleapis.com",
			"https://cloudcode-pa.googleapis.com",
		];

		let rawData: { groups?: QuotaGroup[] } | null = null;
		for (const endpoint of endpoints) {
			try {
				const res = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
						"User-Agent": "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)",
					},
					body: "{}",
				});
				if (!res.ok) continue;
				rawData = (await res.json()) as { groups?: QuotaGroup[] };
				break;
			} catch {
				continue;
			}
		}

		if (!rawData?.groups) return cachedQuota;

		const state: QuotaState = {
			lastFetched: Date.now(),
		};

		for (const group of rawData.groups) {
			const name = group.displayName?.toLowerCase() || "";
			const isGemini = name.includes("gemini");
			const isClaude = name.includes("claude") || name.includes("gpt");

			for (const bucket of group.buckets || []) {
				const bId = bucket.bucketId?.toLowerCase() || "";
				const frac = typeof bucket.remainingFraction === "number" ? Math.max(0, Math.min(1, bucket.remainingFraction)) : undefined;

				if (isGemini) {
					if (bId.includes("5h") || bucket.window === "5h") {
						state.gemini5h = frac;
						state.gemini5hReset = bucket.resetTime;
					} else if (bId.includes("weekly") || bucket.window === "weekly") {
						state.geminiWeekly = frac;
						state.geminiWeeklyReset = bucket.resetTime;
					}
				} else if (isClaude) {
					if (bId.includes("5h") || bucket.window === "5h") {
						state.claude5h = frac;
						state.claude5hReset = bucket.resetTime;
					} else if (bId.includes("weekly") || bucket.window === "weekly") {
						state.claudeWeekly = frac;
						state.claudeWeeklyReset = bucket.resetTime;
					}
				}
			}
		}

		cachedQuota = state;
		return state;
	} catch (e) {
		if (cachedQuota) cachedQuota.error = String(e);
		return cachedQuota;
	} finally {
		isFetching = false;
	}
}

export default function (pi: ExtensionAPI) {
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let currentContext: ExtensionContext | null = null;

	const triggerQuotaRefresh = async (requestRender?: () => void) => {
		await fetchQuota(currentContext || undefined);
		if (requestRender) requestRender();
	};

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		currentContext = ctx;
		if (!ctx.hasUI) return;

		// Initial quota fetch in background
		void triggerQuotaRefresh();

		// Install custom footer
		installFooter(ctx);

		// Periodic background polling (every 60s)
		if (pollInterval) clearInterval(pollInterval);
		pollInterval = setInterval(() => {
			void triggerQuotaRefresh();
		}, 60000);
	});

	pi.on("agent_end", async () => {
		// Update quota right after model generation completes
		void triggerQuotaRefresh();
	});

	pi.on("session_shutdown", () => {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
		currentContext = null;
	});

	function installFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsub();
				},
				invalidate() {
					// no-op
				},
				render(width: number): string[] {
					if (!footerEnabled) return [];

					// 1. Gather session usage totals
					let cost = 0;

					for (const entry of ctx.sessionManager.getBranch()) {
						if (entry.type === "message" && (entry.message as any).role === "assistant") {
							const m = entry.message as AssistantMessage;
							cost += m.usage.cost.total;
						}
					}

					// 2. Line 1: Directory, Git Branch & Session Name
					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));

					// 3. Line 2: Stats (Context + Quota/Cost) & Model
					const statsParts: string[] = [];

					// Context usage tokens, percentage & window limit
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const currentTokens = contextUsage?.tokens ?? 0;
					const contextPercentVal = contextUsage?.percent ?? 0;

					const contextDisplay = currentTokens > 0
						? `${formatTokens(currentTokens)}/${formatTokens(contextWindow)} (${contextPercentVal.toFixed(1)}%)`
						: (contextUsage?.percent !== null
							? `${contextPercentVal.toFixed(1)}%/${formatTokens(contextWindow)}`
							: `?/${formatTokens(contextWindow)}`);

					if (contextPercentVal > 90) {
						statsParts.push(theme.fg("error", contextDisplay));
					} else if (contextPercentVal > 70) {
						statsParts.push(theme.fg("warning", contextDisplay));
					} else {
						statsParts.push(theme.fg("dim", contextDisplay));
					}

					const activeModel = ctx.model;
					const isAntigravity = activeModel?.provider === "antigravity";

					if (isAntigravity) {
						// Real Antigravity pool quota display
						if (cachedQuota) {
							const colorizeFrac = (frac?: number, text?: string) => {
								if (frac === undefined) return text || "?%";
								const str = text || `${Math.round(frac * 100)}%`;
								if (frac < 0.2) return theme.fg("error", str);
								if (frac < 0.5) return theme.fg("warning", str);
								return theme.fg("success", str);
							};

							const modelId = activeModel?.id?.toLowerCase() || "";
							const isGeminiModel = modelId.includes("gemini");
							const isClaudeModel = modelId.includes("claude") || modelId.includes("gpt");

							const gem5h = cachedQuota.gemini5h !== undefined ? Math.round(cachedQuota.gemini5h * 100) : undefined;
							const cld5h = cachedQuota.claude5h !== undefined ? Math.round(cachedQuota.claude5h * 100) : undefined;
							const gemReset = formatReset(cachedQuota.gemini5hReset);
							const cldReset = formatReset(cachedQuota.claude5hReset);

							let quotaBadge = "";
							if (isGeminiModel && gem5h !== undefined) {
								const timer = gemReset ? ` (${gemReset})` : "";
								quotaBadge = `[Gem: ${colorizeFrac(cachedQuota.gemini5h, `${gem5h}%`)}${timer}]`;
							} else if (isClaudeModel && cld5h !== undefined) {
								const timer = cldReset ? ` (${cldReset})` : "";
								quotaBadge = `[Claude: ${colorizeFrac(cachedQuota.claude5h, `${cld5h}%`)}${timer}]`;
							} else if (gem5h !== undefined || cld5h !== undefined) {
								const gPart = gem5h !== undefined ? `G: ${colorizeFrac(cachedQuota.gemini5h, `${gem5h}%`)}` : "";
								const cPart = cld5h !== undefined ? `C: ${colorizeFrac(cachedQuota.claude5h, `${cld5h}%`)}` : "";
								quotaBadge = `[${[gPart, cPart].filter(Boolean).join(" · ")}]`;
							}

							if (quotaBadge) {
								statsParts.push(quotaBadge);
							}
						} else {
							statsParts.push(theme.fg("dim", "[AG Quota…]"));
						}
					} else {
						// Non-antigravity model: normal cost
						if (cost > 0) {
							statsParts.push(`$${cost.toFixed(3)}`);
						}
					}



					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);

					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					// Right side: Model ID & Thinking level
					const modelName = activeModel?.id || "no-model";
					let rightSide = modelName;
					if (activeModel?.reasoning) {
						const thinkingLevel = ctx.model?.thinkingLevelMap ? "thinking" : "off";
						rightSide = `${modelName} • ${thinkingLevel}`;
					}

					const minPadding = 2;
					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

					let statsLine = "";
					if (totalNeeded <= width) {
						const pad = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + pad + theme.fg("dim", rightSide);
					} else {
						const availableForRight = width - statsLeftWidth - minPadding;
						if (availableForRight > 0) {
							const truncated = truncateToWidth(rightSide, availableForRight, "");
							const pad = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncated)));
							statsLine = statsLeft + pad + theme.fg("dim", truncated);
						} else {
							statsLine = statsLeft;
						}
					}

					const lines = [pwdLine, statsLine];

					// Extension statuses line (if any)
					const statuses = footerData.getExtensionStatuses();
					if (statuses && statuses.size > 0) {
						const sorted = Array.from(statuses.entries())
							.sort((a: any, b: any) => String(a[0]).localeCompare(String(b[0])))
							.map((entry: any) => String(entry[1]).trim());
						lines.push(truncateToWidth(theme.fg("dim", sorted.join(" ")), width, "..."));
					}

					return lines;
				},
			};
		});
	}

	pi.registerCommand("antigravity.footer", {
		description: "Refresh or toggle Antigravity live quota footer (usage: /antigravity.footer [refresh|toggle])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const cmd = (args || "").trim().toLowerCase();
			if (cmd === "toggle") {
				footerEnabled = !footerEnabled;
				if (footerEnabled) {
					installFooter(ctx as unknown as ExtensionContext);
					ctx.ui.notify("Antigravity quota footer enabled", "info");
				} else {
					ctx.ui.setFooter(undefined);
					ctx.ui.notify("Default footer restored", "info");
				}
				return;
			}

			ctx.ui.notify("Refreshing Antigravity quota…", "info");
			const state = await fetchQuota(ctx);
			if (state) {
				const gem = state.gemini5h !== undefined ? `${Math.round(state.gemini5h * 100)}% (5h)` : "n/a";
				const cld = state.claude5h !== undefined ? `${Math.round(state.claude5h * 100)}% (5h)` : "n/a";
				ctx.ui.notify(`Antigravity quota: Gemini ${gem} · Claude ${cld}`, "info");
			} else {
				ctx.ui.notify("Failed to fetch Antigravity quota", "warning");
			}
		},
	});
}
