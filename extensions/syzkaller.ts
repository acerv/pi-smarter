import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";

/* =====================================================================
 * Types & Interfaces
 * ===================================================================== */

interface CrashFrame {
	func: string;
	offset?: string;
	size?: string;
	file?: string;
	line?: number;
	isInline?: boolean;
	raw: string;
}

interface ParsedReport {
	title: string;
	category: string;
	faultLocation?: {
		func: string;
		offset?: string;
		size?: string;
		file?: string;
		line?: number;
		isInline?: boolean;
	};
	access?: {
		type: string;
		size: string;
		addr: string;
		task?: string;
	};
	slab?: {
		addr: string;
		cache: string;
		size?: string;
	};
	memoryRegion?: {
		offset: string;
		state?: string;
		size: string;
		start: string;
		end: string;
	};
	context?: {
		cpu?: string;
		pid?: string;
		comm?: string;
		tainted?: string;
		hardware?: string;
		workqueue?: string;
	};
	codeBytes?: string;
	registers?: Record<string, string>;
	headCommit?: string;
	gitTree?: string;
	crashFrames: CrashFrame[];
	allocFrames: CrashFrame[];
	allocTask?: string;
	freedFrames: CrashFrame[];
	freedTask?: string;
	rawText: string;
}

interface LocalSnippet {
	file: string;
	line: number;
	role: "crash" | "alloc" | "free";
	snippet: string;
	gitCommit?: string;
}

interface SyzbotDiscussion {
	title: string;
	url: string;
}

interface SyzkallerBugSummary {
	id: string;
	title: string;
	labels: string[];
	repro: string;
	hasC: boolean;
	hasSyz: boolean;
	count: string;
	age: string;
	url: string;
}

interface SyzkallerListResult {
	bugs: SyzkallerBugSummary[];
	totalOpen: number;
	timeframe: "recent" | "all";
	isFallback: boolean;
	subsystem?: string;
}

interface SyzkallerResultData {
	title: string;
	category: string;
	sourceLocation?: string;
	status?: string;
	reportedBy?: string;
	subsystems: string[];
	discussions: SyzbotDiscussion[];
	parsedReport?: ParsedReport;
	localSnippets: LocalSnippet[];
	reproC?: string;
	reproSyz?: string;
	url?: string;
	filePath?: string;
}

/* =====================================================================
 * Parameter Schemas
 * ===================================================================== */

const SyzkallerListParams = Type.Object({
	subsystem: Type.Optional(
		Type.String({
			description: "Optional subsystem filter (e.g. 'fs', 'net', 'usb', 'bpf', 'kernel', 'input', 'mm', 'media').",
		}),
	),
	timeframe: Type.Optional(
		Type.String({
			description:
				"Timeframe filter: 'recent' for bugs from today & yesterday (default), or 'all' to see all open bugs without date restrictions.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of bugs to return (default: all matching bugs for today & yesterday, or specified count).",
		}),
	),
	hasReproOnly: Type.Optional(
		Type.Boolean({
			description: "Only include bugs with reproducer (C or syz) available (default: false).",
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "Optional keyword filter for bug title.",
		}),
	),
});

const SyzkallerReportParams = Type.Object({
	target: Type.String({
		description:
			"Syzbot bug URL, bug extid (e.g. 8420e667af06b1709c00), local crash file (crash.log, repro.c), local crash directory, or raw report text.",
	}),
	fetchReproducer: Type.Optional(
		Type.Boolean({
			description: "Whether to fetch and include C and Syzkaller reproducers if available (default: true).",
		}),
	),
	checkLocalSource: Type.Optional(
		Type.Boolean({
			description:
				"Whether to correlate faulting files and lines against the local git tree / working directory (default: true).",
		}),
	),
});

/* =====================================================================
 * Text & HTML Utilities
 * ===================================================================== */

function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#43;/g, "+")
		.trim();
}

function normalizeSyzbotUrl(raw: string): string {
	return decodeHtmlEntities(raw).replace(/&amp;/g, "&");
}

/**
 * Checks whether an age string corresponds to today (< 24h) or yesterday (1d..2d).
 * Examples: "32m", "1h15m", "11h55m", "1d02h", "1d14h"
 */
function isTodayOrYesterday(age: string): boolean {
	return /^[0-9]+[hm]/.test(age) || /^1d\b|^1d[0-9]/.test(age);
}

function classifyBug(title: string, text: string): string {
	const combined = `${title}\n${text}`.toLowerCase();
	if (combined.includes("slab-use-after-free") || combined.includes("page-use-after-free") || combined.includes("use-after-free")) {
		return "Use-After-Free (UAF)";
	}
	if (combined.includes("null-ptr-deref") || combined.includes("null pointer") || combined.includes("dereferencing a null")) {
		return "Null Pointer Dereference";
	}
	if (combined.includes("slab-out-of-bounds") || combined.includes("global-out-of-bounds") || combined.includes("stack-out-of-bounds") || combined.includes("out-of-bounds")) {
		return "Out-Of-Bounds (OOB)";
	}
	if (combined.includes("double-free") || combined.includes("double free")) {
		return "Double Free";
	}
	if (combined.includes("kmsan") || combined.includes("uninit-value") || combined.includes("uninitialized memory")) {
		return "Uninitialized Memory (KMSAN)";
	}
	if (combined.includes("circular locking") || combined.includes("possible deadlock") || combined.includes("lockdep")) {
		return "Deadlock / Lockdep";
	}
	if (combined.includes("kernel bug at") || combined.includes("bug_on") || combined.includes("warn_on") || combined.includes("warning in") || combined.includes("warning:")) {
		return "Kernel Warning / Assertion";
	}
	if (combined.includes("general protection fault") || combined.includes("non-canonical address")) {
		return "General Protection Fault (GPF)";
	}
	if (combined.includes("unable to handle page fault") || combined.includes("page fault")) {
		return "Page Fault";
	}
	if (combined.includes("memory leak") || combined.includes("kmemleak")) {
		return "Memory Leak";
	}
	if (combined.includes("task hung") || combined.includes("soft lockup") || combined.includes("rcu stalls")) {
		return "Hung Task / Lockup";
	}
	return "Kernel Crash / Bug";
}

function parseTraceFrames(text: string): CrashFrame[] {
	const lines = text.split("\n");
	const frames: CrashFrame[] = [];
	const frameRegex =
		/^\s*(?:\[\s*<[0-9a-fA-Fx]+>\s*\]\s*)?([a-zA-Z0-9_.]+)(?:\+0x([0-9a-fA-F]+)\/0x([0-9a-fA-F]+))?(?:\s+([a-zA-Z0-9_./-]+):(\d+))?(\s+\[inline\])?/i;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("Call Trace:") || trimmed.startsWith("<TASK>") || trimmed.startsWith("</TASK>") || trimmed.startsWith("<IRQ>") || trimmed.startsWith("</IRQ>")) {
			continue;
		}
		const m = line.match(frameRegex);
		if (m && (m[2] || m[4])) {
			frames.push({
				func: m[1],
				offset: m[2] ? `0x${m[2]}` : undefined,
				size: m[3] ? `0x${m[3]}` : undefined,
				file: m[4],
				line: m[5] ? parseInt(m[5], 10) : undefined,
				isInline: !!m[6],
				raw: trimmed,
			});
		}
	}
	return frames;
}

function findEffectiveCrashSite(frames: CrashFrame[]): CrashFrame | undefined {
	const infraPrefixes = [
		"dump_stack",
		"__dump_stack",
		"kasan",
		"__kasan",
		"kfence",
		"__kfence",
		"kmsan",
		"__kmsan",
		"ubsan",
		"__ubsan",
		"print_report",
		"print_address",
		"panic",
		"check_panic_on_warn",
		"warn_slowpath",
		"report_bug",
		"oops_end",
		"die",
		"do_trap",
	];

	for (const f of frames) {
		const lower = f.func.toLowerCase();
		if (!infraPrefixes.some((p) => lower.startsWith(p))) {
			return f;
		}
	}
	return frames[0];
}

function parseSyzkallerReport(rawText: string): ParsedReport {
	const titleRegex =
		/(?:BUG:\s*(?:KASAN:\s*[^\n]+|KFENCE:\s*[^\n]+|KMSAN:\s*[^\n]+|[^\n]+)|Oops:\s*[^\n]+|kernel BUG at\s*[^\n]+|WARNING:\s*[^\n]+|general protection fault[^\n]*|INFO:\s*task hung[^\n]+|possible circular locking[^\n]+)/i;
	const titleMatch = rawText.match(titleRegex);
	let title = titleMatch ? titleMatch[0].trim() : "Kernel Crash";
	title = title.replace(/^BUG:\s*/, "");

	const category = classifyBug(title, rawText);

	const commitMatch = rawText.match(/HEAD commit:\s*([0-9a-fA-F]+)/i);
	const headCommit = commitMatch ? commitMatch[1] : undefined;

	const treeMatch = rawText.match(/git tree:\s*([^\n]+)/i);
	const gitTree = treeMatch ? treeMatch[1].trim() : undefined;

	const cpuMatch = rawText.match(/CPU:\s*(\d+)(?:\s+UID:\s*\d+)?\s+PID:\s*(\d+)\s+Comm:\s*([^\s]+)(?:\s+([^\n]+))?/i);
	const hwMatch = rawText.match(/Hardware name:\s*([^\n]+)/i);
	const wqMatch = rawText.match(/Workqueue:\s*([^\n]+)/i);

	const context = {
		cpu: cpuMatch ? cpuMatch[1] : undefined,
		pid: cpuMatch ? cpuMatch[2] : undefined,
		comm: cpuMatch ? cpuMatch[3] : undefined,
		tainted: cpuMatch && cpuMatch[4] ? cpuMatch[4].trim() : undefined,
		hardware: hwMatch ? hwMatch[1].trim() : undefined,
		workqueue: wqMatch ? wqMatch[1].trim() : undefined,
	};

	const accessRegex = /(Read|Write|Execute) of size (\d+) at addr ([0-9a-fA-Fx]+)(?:\s+by task\s+([^\n]+))?/i;
	const am = rawText.match(accessRegex);
	const access = am
		? {
				type: am[1],
				size: am[2],
				addr: am[3],
				task: am[4]?.trim(),
		  }
		: undefined;

	const slabRegex =
		/The buggy address belongs to the object at ([0-9a-fA-Fx]+)\s+which belongs to the cache ([a-zA-Z0-9_\-]+)(?:\s+of size (\d+))?/i;
	const sm = rawText.match(slabRegex);
	const slab = sm
		? {
				addr: sm[1],
				cache: sm[2],
				size: sm[3],
		  }
		: undefined;

	const regionRegex =
		/The buggy address is located (\d+) bytes inside of\s+(freed|allocated)?\s*(\d+)-byte region \[([0-9a-fA-Fx]+),\s*([0-9a-fA-Fx]+)\)/i;
	const rgm = rawText.match(regionRegex);
	const memoryRegion = rgm
		? {
				offset: rgm[1],
				state: rgm[2],
				size: rgm[3],
				start: rgm[4],
				end: rgm[5],
		  }
		: undefined;

	const ripRegex =
		/RIP:\s*(?:[0-9a-fA-F]+:)?\s*([a-zA-Z0-9_.]+)\+0x([0-9a-fA-F]+)\/0x([0-9a-fA-F]+)(?:\s+([a-zA-Z0-9_./-]+):(\d+))?/i;
	const rm = rawText.match(ripRegex);
	let faultLocation: ParsedReport["faultLocation"] = rm
		? {
				func: rm[1],
				offset: `0x${rm[2]}`,
				size: `0x${rm[3]}`,
				file: rm[4],
				line: rm[5] ? parseInt(rm[5], 10) : undefined,
		  }
		: undefined;

	const codeMatch = rawText.match(/Code:\s*([^\n]+)/i);
	const codeBytes = codeMatch ? codeMatch[1].trim() : undefined;

	const registers: Record<string, string> = {};
	const regRegex = /\b(RAX|RBX|RCX|RDX|RSI|RDI|RBP|RSP|R08|R09|R10|R11|R12|R13|R14|R15|CR2|CR3|CR4):\s*([0-9a-fA-Fx]+)/gi;
	let regM;
	while ((regM = regRegex.exec(rawText)) !== null) {
		registers[regM[1].toUpperCase()] = regM[2];
	}

	const callTraceMatch = rawText.match(
		/Call Trace:\s*([\s\S]*?)(?=(?:\n\s*\n\s*(?:Allocated|Freed|The buggy|Modules linked|---\[ end trace|\b[A-Z0-9_]+:)|$))/i,
	);
	const crashFrames = callTraceMatch ? parseTraceFrames(callTraceMatch[1]) : [];

	if (!faultLocation && crashFrames.length > 0) {
		const effective = findEffectiveCrashSite(crashFrames);
		if (effective) {
			faultLocation = {
				func: effective.func,
				offset: effective.offset,
				size: effective.size,
				file: effective.file,
				line: effective.line,
				isInline: effective.isInline,
			};
		}
	}

	const allocMatch = rawText.match(
		/Allocated by task (\d+):\s*([\s\S]*?)(?=(?:\n\s*\n\s*(?:Freed|The buggy|Modules linked|---\[ end trace|\b[A-Z0-9_]+:)|$))/i,
	);
	const allocFrames = allocMatch ? parseTraceFrames(allocMatch[2]) : [];
	const allocTask = allocMatch ? allocMatch[1] : undefined;

	const freedMatch = rawText.match(
		/Freed by task (\d+):\s*([\s\S]*?)(?=(?:\n\s*\n\s*(?:The buggy|Modules linked|---\[ end trace|\b[A-Z0-9_]+:)|$))/i,
	);
	const freedFrames = freedMatch ? parseTraceFrames(freedMatch[2]) : [];
	const freedTask = freedMatch ? freedMatch[1] : undefined;

	return {
		title,
		category,
		faultLocation,
		access,
		slab,
		memoryRegion,
		context,
		codeBytes,
		registers: Object.keys(registers).length > 0 ? registers : undefined,
		headCommit,
		gitTree,
		crashFrames,
		allocFrames,
		allocTask,
		freedFrames,
		freedTask,
		rawText,
	};
}

/* =====================================================================
 * Local Source Code Inspection
 * ===================================================================== */

function getLocalCodeSnippet(cwd: string, filePath: string, line: number, context = 10): string | null {
	const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
		return null;
	}

	try {
		const content = fs.readFileSync(resolved, "utf-8");
		const lines = content.split("\n");
		const start = Math.max(1, line - context);
		const end = Math.min(lines.length, line + context);

		const out: string[] = [];
		for (let i = start; i <= end; i++) {
			const prefix = i === line ? "--> " : "    ";
			const lineNum = String(i).padStart(5, " ");
			out.push(`${prefix}${lineNum} | ${lines[i - 1]}`);
		}
		return out.join("\n");
	} catch {
		return null;
	}
}

function getRecentGitCommit(cwd: string, filePath: string): string | undefined {
	try {
		const output = execSync(`git log -n 1 --oneline -- "${filePath}"`, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return output || undefined;
	} catch {
		return undefined;
	}
}

/* =====================================================================
 * Reproducer Formatting
 * ===================================================================== */

function formatCRepro(cText: string, maxLines = 180): string {
	const lines = cText.split("\n");
	if (lines.length <= maxLines) {
		return cText.trim();
	}

	let splitIdx = lines.findIndex((l) =>
		/^(?:void\s+execute_call|static\s+void\s+loop|void\s+loop|int\s+main)\b/.test(l),
	);
	if (splitIdx === -1) {
		splitIdx = Math.max(0, lines.length - (maxLines - 35));
	}

	const topLines = lines.slice(0, 30);
	const bottomLines = lines.slice(splitIdx);
	const elidedCount = lines.length - 30 - bottomLines.length;

	return [
		...topLines,
		"",
		`/* ... [${elidedCount} lines of Syzkaller setup boilerplate elided; full reproducer has ${lines.length} lines] ... */`,
		"",
		...bottomLines,
	]
		.join("\n")
		.trim();
}

/* =====================================================================
 * Network Fetchers
 * ===================================================================== */

async function fetchHttpText(url: string): Promise<string> {
	const res = await fetch(url, {
		headers: {
			Accept: "text/plain, text/html, */*",
			"User-Agent": "pi-coding-agent/syzkaller-plugin",
		},
	});
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} (${res.statusText}) fetching ${url}`);
	}
	return await res.text();
}

/**
 * Fetch bug list from Syzbot upstream or subsystem dashboard.
 * By default filters for bugs active today & yesterday (< 48h).
 */
async function fetchSyzbotBugList(
	subsystem?: string,
	timeframe: "recent" | "all" = "recent",
	limit?: number,
	hasReproOnly = false,
	query = "",
): Promise<SyzkallerListResult> {
	const cleanSub = subsystem?.trim().toLowerCase();
	const url = cleanSub && cleanSub !== "all"
		? `https://syzkaller.appspot.com/upstream/s/${encodeURIComponent(cleanSub)}`
		: `https://syzkaller.appspot.com/upstream`;

	const html = await fetchHttpText(url);
	const allScrapedBugs: SyzkallerBugSummary[] = [];

	const rowRegex =
		/<tr[^>]*>[\s\S]*?<td class="title">\s*<a href="(\/bug\?[^"]+)">([^<]+)<\/a>([\s\S]*?)<\/td>\s*<td class="stat">([^<]*)<\/td>\s*<td class="stat">([^<]*)<\/td>[\s\S]*?<td class="stat[^"]*"(?:\s+sort-value="[^"]*")?>([^<]*)<\/td>\s*<td class="stat">([^<]*)<\/td>/gi;

	let m;
	while ((m = rowRegex.exec(html)) !== null) {
		const rawLink = m[1];
		const title = decodeHtmlEntities(m[2]);
		const labelsBlock = m[3];
		const repro = m[5].trim();
		const count = m[6].trim();
		const age = m[7].trim();

		const hasC = repro.includes("C");
		const hasSyz = repro.includes("syz");

		if (hasReproOnly && !hasC && !hasSyz) continue;
		if (query && !title.toLowerCase().includes(query.toLowerCase())) continue;

		const labels: string[] = [];
		const labelRegex = /<span class="bug-label"><a[^>]*>([^<]+)<\/a><\/span>/g;
		let lm;
		while ((lm = labelRegex.exec(labelsBlock)) !== null) {
			labels.push(decodeHtmlEntities(lm[1]));
		}

		const extidMatch = rawLink.match(/extid=([0-9a-fA-F]+)/);
		const idMatch = rawLink.match(/id=([0-9a-fA-F]+)/);
		const id = extidMatch ? extidMatch[1] : idMatch ? idMatch[1] : "";

		allScrapedBugs.push({
			id,
			title,
			labels,
			repro: repro || "none",
			hasC,
			hasSyz,
			count,
			age,
			url: `https://syzkaller.appspot.com${rawLink}`,
		});
	}

	const totalOpen = allScrapedBugs.length;
	let resultBugs: SyzkallerBugSummary[] = [];
	let isFallback = false;

	if (timeframe === "recent") {
		// Filter bugs from today (< 24h) and yesterday (1d..2d)
		resultBugs = allScrapedBugs.filter((b) => isTodayOrYesterday(b.age));

		// Fallback for quiet subsystems with no bugs in the last 48 hours
		if (resultBugs.length === 0 && allScrapedBugs.length > 0) {
			isFallback = true;
			resultBugs = allScrapedBugs.slice(0, limit || 10);
		} else if (limit) {
			resultBugs = resultBugs.slice(0, limit);
		}
	} else {
		// "all" timeframe: return all or up to limit
		resultBugs = limit ? allScrapedBugs.slice(0, limit) : allScrapedBugs;
	}

	return {
		bugs: resultBugs,
		totalOpen,
		timeframe,
		isFallback,
		subsystem: cleanSub && cleanSub !== "all" ? cleanSub : undefined,
	};
}

async function fetchFromSyzbotPage(bugUrl: string, fetchRepro = true): Promise<SyzkallerResultData> {
	const parsedUrl = new URL(bugUrl);
	const origin = parsedUrl.origin;
	const html = await fetchHttpText(bugUrl);

	const titleMatch = html.match(/<b>(.*?)<\/b><br><br>/i) || html.match(/<title>(.*?)<\/title>/i);
	const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : "Syzkaller Bug";

	const reportedByMatch = html.match(/Reported-by:\s*([^\s<]+)/i);
	const reportedBy = reportedByMatch ? decodeHtmlEntities(reportedByMatch[1]) : undefined;

	const statusMatch = html.match(/Status:\s*<a[^>]*>(.*?)<\/a>/i);
	const status = statusMatch ? decodeHtmlEntities(statusMatch[1]) : undefined;

	const subsystems: string[] = [];
	const subRegex = /<span class="bug-label"><a href="\/[^/]+\/s\/([^"]+)">/g;
	let sm;
	while ((sm = subRegex.exec(html)) !== null) {
		if (!subsystems.includes(sm[1])) {
			subsystems.push(sm[1]);
		}
	}

	const discussions: SyzbotDiscussion[] = [];
	const discRegex = /<a href="(https:\/\/lore\.kernel\.org\/[^"]+)">([^<]+)<\/a>/g;
	let dm;
	while ((dm = discRegex.exec(html)) !== null) {
		discussions.push({
			url: dm[1],
			title: decodeHtmlEntities(dm[2]),
		});
	}

	const crashReportMatch = html.match(/href="([^"]*(?:tag=CrashReport|report\.txt)[^"]*)"/i);
	const reproCMatch = html.match(/href="([^"]*(?:tag=ReproC|repro\.c)[^"]*)"/i);
	const reproSyzMatch = html.match(/href="([^"]*(?:tag=ReproSyz|repro\.syz)[^"]*)"/i);

	let rawReportText = "";
	if (crashReportMatch) {
		const rUrl = normalizeSyzbotUrl(crashReportMatch[1].startsWith("http") ? crashReportMatch[1] : `${origin}${crashReportMatch[1]}`);
		try {
			rawReportText = await fetchHttpText(rUrl);
		} catch {
			// ignore
		}
	}

	let reproC: string | undefined;
	let reproSyz: string | undefined;

	if (fetchRepro) {
		if (reproCMatch) {
			const cUrl = normalizeSyzbotUrl(reproCMatch[1].startsWith("http") ? reproCMatch[1] : `${origin}${reproCMatch[1]}`);
			try {
				reproC = await fetchHttpText(cUrl);
			} catch {
				// ignore
			}
		}
		if (reproSyzMatch) {
			const sUrl = normalizeSyzbotUrl(reproSyzMatch[1].startsWith("http") ? reproSyzMatch[1] : `${origin}${reproSyzMatch[1]}`);
			try {
				reproSyz = await fetchHttpText(sUrl);
			} catch {
				// ignore
			}
		}
	}

	const parsedReport = rawReportText ? parseSyzkallerReport(rawReportText) : undefined;
	const category = parsedReport?.category || classifyBug(title, rawReportText);

	let sourceLocation: string | undefined;
	if (parsedReport?.faultLocation?.file) {
		sourceLocation = `${parsedReport.faultLocation.file}${parsedReport.faultLocation.line ? `:${parsedReport.faultLocation.line}` : ""}`;
	}

	return {
		title: parsedReport?.title || title,
		category,
		sourceLocation,
		status,
		reportedBy,
		subsystems,
		discussions,
		parsedReport,
		localSnippets: [],
		reproC,
		reproSyz,
		url: bugUrl,
	};
}

function readFromLocalDirectory(dirPath: string): SyzkallerResultData {
	const entries = fs.readdirSync(dirPath);

	let title = path.basename(dirPath);
	let rawReportText = "";
	let reproC: string | undefined;
	let reproSyz: string | undefined;

	if (entries.includes("description")) {
		try {
			title = fs.readFileSync(path.join(dirPath, "description"), "utf-8").trim();
		} catch {
			// ignore
		}
	}

	const reportFile = entries.find((e) => /^(?:repro\.report|report\d*|report\.txt|crash\.log)$/i.test(e));
	if (reportFile) {
		try {
			rawReportText = fs.readFileSync(path.join(dirPath, reportFile), "utf-8");
		} catch {
			// ignore
		}
	}

	const cFile = entries.find((e) => /^(?:repro\.cprog|repro\d*\.cprog|repro\.c|repro\d*\.c)$/i.test(e));
	if (cFile) {
		try {
			reproC = fs.readFileSync(path.join(dirPath, cFile), "utf-8");
		} catch {
			// ignore
		}
	}

	const syzFile = entries.find((e) => /^(?:repro\.prog|repro\d*\.prog|repro\.syz|repro\d*\.syz)$/i.test(e));
	if (syzFile) {
		try {
			reproSyz = fs.readFileSync(path.join(dirPath, syzFile), "utf-8");
		} catch {
			// ignore
		}
	}

	const parsedReport = rawReportText ? parseSyzkallerReport(rawReportText) : undefined;
	const category = parsedReport?.category || classifyBug(title, rawReportText);

	let sourceLocation: string | undefined;
	if (parsedReport?.faultLocation?.file) {
		sourceLocation = `${parsedReport.faultLocation.file}${parsedReport.faultLocation.line ? `:${parsedReport.faultLocation.line}` : ""}`;
	}

	return {
		title: parsedReport?.title || title,
		category,
		sourceLocation,
		subsystems: [],
		discussions: [],
		parsedReport,
		localSnippets: [],
		reproC,
		reproSyz,
		filePath: dirPath,
	};
}

function readFromLocalFile(filePath: string): SyzkallerResultData {
	const content = fs.readFileSync(filePath, "utf-8");
	const basename = path.basename(filePath).toLowerCase();

	let title = path.basename(filePath);
	let rawReportText = "";
	let reproC: string | undefined;
	let reproSyz: string | undefined;

	if (basename.endsWith(".c") || (content.includes("#define _GNU_SOURCE") && content.includes("<linux/"))) {
		reproC = content;
		title = `C Reproducer (${path.basename(filePath)})`;
	} else if (basename.endsWith(".syz") || basename.endsWith(".prog") || content.includes("syz_")) {
		reproSyz = content;
		title = `Syzkaller Reproducer (${path.basename(filePath)})`;
	} else {
		rawReportText = content;
	}

	const parsedReport = rawReportText ? parseSyzkallerReport(rawReportText) : undefined;
	const category = parsedReport?.category || classifyBug(title, rawReportText || reproC || reproSyz || "");

	let sourceLocation: string | undefined;
	if (parsedReport?.faultLocation?.file) {
		sourceLocation = `${parsedReport.faultLocation.file}${parsedReport.faultLocation.line ? `:${parsedReport.faultLocation.line}` : ""}`;
	}

	return {
		title: parsedReport?.title || title,
		category,
		sourceLocation,
		subsystems: [],
		discussions: [],
		parsedReport,
		localSnippets: [],
		reproC,
		reproSyz,
		filePath,
	};
}

/* =====================================================================
 * Serializers
 * ===================================================================== */

function serializeBugListForModel(listData: SyzkallerListResult): string {
	const { bugs, totalOpen, timeframe, isFallback, subsystem } = listData;
	const parts: string[] = [];

	const subTitle = subsystem ? `[${subsystem}]` : "[All Upstream]";
	let titleHeader = "";

	if (timeframe === "recent") {
		if (isFallback) {
			titleHeader = `# Syzbot Open Bugs: ${subTitle} (Most Recent ${bugs.length} of ${totalOpen} total)`;
		} else {
			titleHeader = `# Syzbot Bugs Active Today & Yesterday: ${subTitle} (${bugs.length} found, ${totalOpen} total open)`;
		}
	} else {
		titleHeader = `# Syzbot Open Bugs: ${subTitle} (${bugs.length} shown, ${totalOpen} total open)`;
	}

	parts.push(titleHeader);
	parts.push("");

	if (isFallback) {
		parts.push(`*Note: No new or active crashes were reported today or yesterday in ${subTitle}. Showing the most recent open bugs instead.*`);
		parts.push("");
	}

	parts.push(`| # | Title | Subsystem / Labels | Repro | Crashes | Last Seen | ID |`);
	parts.push(`|---|---|---|---|---|---|---|`);

	for (let i = 0; i < bugs.length; i++) {
		const b = bugs[i];
		const labels = b.labels.length > 0 ? b.labels.join(", ") : "-";
		parts.push(`| ${i + 1} | ${b.title} | ${labels} | \`${b.repro}\` | ${b.count} | ${b.age} | \`${b.id}\` |`);
	}

	parts.push("");
	parts.push(`### Next Steps for Assistant:`);
	parts.push(`1. Present this list clearly to the user in a formatted markdown table.`);
	if (timeframe === "recent") {
		parts.push(`2. Mention to the user that this shows bugs active from **today & yesterday** by default (${bugs.length} bugs).`);
		parts.push(`3. Remind the user:`);
		parts.push(`   - To see more or older bugs, they can ask for *"all"* (which will list all ${totalOpen} bugs) or specify an amount (e.g. *"show 50"*).`);
		parts.push(`   - To investigate any bug, reply with its number (e.g. \`#1\`), extid, or title, and you will produce a complete **overview + patch**.`);
	} else {
		parts.push(`2. Prompt the user to pick a bug (by number or ID) to examine in-depth with an **overview and patch**.`);
	}

	return parts.join("\n");
}

function serializeReportForModel(data: SyzkallerResultData): string {
	const parts: string[] = [];

	parts.push(`# Syzkaller Crash Report & Bug Analysis`);
	parts.push("");

	// 1. Bug Overview
	parts.push(`## 1. Bug Overview`);
	parts.push(`- **Title**: ${data.title}`);
	parts.push(`- **Category**: ${data.category}`);
	if (data.sourceLocation) parts.push(`- **Faulting Location**: \`${data.sourceLocation}\``);
	if (data.status) parts.push(`- **Status**: ${data.status}`);
	if (data.reportedBy) parts.push(`- **Reported-by**: \`${data.reportedBy}\``);
	if (data.subsystems.length > 0) parts.push(`- **Subsystems**: ${data.subsystems.map((s) => `\`${s}\``).join(", ")}`);
	if (data.url) parts.push(`- **Syzbot URL**: ${data.url}`);
	if (data.filePath) parts.push(`- **Local Path**: \`${data.filePath}\``);
	parts.push("");

	// 2. Crash Details
	const rep = data.parsedReport;
	if (rep) {
		parts.push(`## 2. Crash Details`);
		if (rep.faultLocation) {
			const loc = rep.faultLocation;
			const inlineNote = loc.isInline ? " [inlined]" : "";
			parts.push(`- **Faulting Instruction**: \`${loc.func}${loc.offset ? `+${loc.offset}/${loc.size}` : ""}\`${inlineNote}`);
			if (loc.file) parts.push(`- **Source File & Line**: \`${loc.file}:${loc.line || "?"}\``);
		}
		if (rep.access) {
			parts.push(
				`- **Memory Access**: **${rep.access.type}** of ${rep.access.size} bytes at address \`${rep.access.addr}\`${rep.access.task ? ` (Task: \`${rep.access.task}\`)` : ""}`,
			);
		}
		if (rep.slab) {
			parts.push(`- **Slab Cache**: \`${rep.slab.cache}\` (address \`${rep.slab.addr}\`${rep.slab.size ? `, size: ${rep.slab.size}` : ""})`);
		}
		if (rep.memoryRegion) {
			parts.push(
				`- **Memory State**: ${rep.memoryRegion.state ? `**${rep.memoryRegion.state}**` : "region"} ${rep.memoryRegion.size} bytes, offset ${rep.memoryRegion.offset} within [${rep.memoryRegion.start}, ${rep.memoryRegion.end})`,
			);
		}
		if (rep.context) {
			const ctx = rep.context;
			const details: string[] = [];
			if (ctx.cpu !== undefined) details.push(`CPU ${ctx.cpu}`);
			if (ctx.pid) details.push(`PID ${ctx.pid}`);
			if (ctx.comm) details.push(`Comm: \`${ctx.comm}\``);
			if (ctx.tainted) details.push(`Tainted: ${ctx.tainted}`);
			if (details.length > 0) parts.push(`- **Execution Context**: ${details.join(" | ")}`);
			if (ctx.workqueue) parts.push(`- **Workqueue**: \`${ctx.workqueue}\``);
			if (ctx.hardware) parts.push(`- **Hardware / VM**: ${ctx.hardware}`);
		}
		if (rep.headCommit) {
			parts.push(`- **Kernel HEAD Commit**: \`${rep.headCommit}\`${rep.gitTree ? ` (${rep.gitTree})` : ""}`);
		}
		if (rep.codeBytes) {
			parts.push(`- **Opcode (` + "`Code:`" + `)**: \`${rep.codeBytes}\``);
		}
		if (rep.registers) {
			const regList = Object.entries(rep.registers)
				.map(([k, v]) => `${k}=${v}`)
				.join("  ");
			parts.push(`- **Registers**: \`${regList}\``);
		}
		parts.push("");
	}

	// 3. Local Source Code Correlation
	if (data.localSnippets.length > 0) {
		parts.push(`## 3. Correlated Local Source Code (Working Tree)`);
		for (const snippet of data.localSnippets) {
			const label = snippet.role === "crash" ? "Crash Location" : snippet.role === "alloc" ? "Allocation Site" : "Free Site";
			parts.push(`### ${label}: \`${snippet.file}:${snippet.line}\``);
			if (snippet.gitCommit) {
				parts.push(`*Last git commit touching this file: \`${snippet.gitCommit}\`*`);
			}
			parts.push("```c");
			parts.push(snippet.snippet);
			parts.push("```");
			parts.push("");
		}
	}

	// 4. Stack Traces
	if (rep && (rep.crashFrames.length > 0 || rep.allocFrames.length > 0 || rep.freedFrames.length > 0)) {
		parts.push(`## 4. Stack Backtraces`);

		if (rep.crashFrames.length > 0) {
			parts.push(`### Crash Call Trace:`);
			for (let i = 0; i < Math.min(rep.crashFrames.length, 25); i++) {
				const f = rep.crashFrames[i];
				const inlineStr = f.isInline ? " [inline]" : "";
				const fileStr = f.file ? ` at ${f.file}:${f.line || "?"}` : "";
				parts.push(`  ${i + 1}. \`${f.func}${f.offset ? `+${f.offset}/${f.size}` : ""}\`${inlineStr}${fileStr}`);
			}
			if (rep.crashFrames.length > 25) {
				parts.push(`  ... (${rep.crashFrames.length - 25} deeper frames omitted)`);
			}
			parts.push("");
		}

		if (rep.allocFrames.length > 0) {
			parts.push(`### Allocation Trace (Task ${rep.allocTask || "unknown"}):`);
			for (let i = 0; i < Math.min(rep.allocFrames.length, 18); i++) {
				const f = rep.allocFrames[i];
				const inlineStr = f.isInline ? " [inline]" : "";
				const fileStr = f.file ? ` at ${f.file}:${f.line || "?"}` : "";
				parts.push(`  ${i + 1}. \`${f.func}${f.offset ? `+${f.offset}/${f.size}` : ""}\`${inlineStr}${fileStr}`);
			}
			if (rep.allocFrames.length > 18) {
				parts.push(`  ... (${rep.allocFrames.length - 18} deeper frames omitted)`);
			}
			parts.push("");
		}

		if (rep.freedFrames.length > 0) {
			parts.push(`### Free Trace (Task ${rep.freedTask || "unknown"}):`);
			for (let i = 0; i < Math.min(rep.freedFrames.length, 18); i++) {
				const f = rep.freedFrames[i];
				const inlineStr = f.isInline ? " [inline]" : "";
				const fileStr = f.file ? ` at ${f.file}:${f.line || "?"}` : "";
				parts.push(`  ${i + 1}. \`${f.func}${f.offset ? `+${f.offset}/${f.size}` : ""}\`${inlineStr}${fileStr}`);
			}
			if (rep.freedFrames.length > 18) {
				parts.push(`  ... (${rep.freedFrames.length - 18} deeper frames omitted)`);
			}
			parts.push("");
		}
	}

	// 5. Reproducer
	if (data.reproSyz || data.reproC) {
		parts.push(`## 5. Bug Reproducer`);
		if (data.reproSyz) {
			parts.push(`### Syzkaller Program (.syz):`);
			parts.push("```syz");
			parts.push(data.reproSyz.trim());
			parts.push("```");
			parts.push("");
		}
		if (data.reproC) {
			parts.push(`### C Standalone Reproducer (.c):`);
			parts.push("```c");
			parts.push(formatCRepro(data.reproC));
			parts.push("```");
			parts.push("");
		}
	}

	// 6. Discussions / Patches
	if (data.discussions.length > 0) {
		parts.push(`## 6. Mailing List Discussions & Proposed Patches (lore.kernel.org)`);
		for (const d of data.discussions) {
			parts.push(`- [${d.title}](${d.url})`);
		}
		parts.push("");
	}

	// 7. Instructions for Overview + Patch
	parts.push(`## 7. Deep-Dive Instructions for Assistant: Overview + Patch`);
	parts.push(`The user has asked to go deeper into this issue. Please structure your response as follows:`);
	parts.push("");
	parts.push(`### Section 1: Overview & Root Cause Analysis`);
	parts.push(`- **Bug Summary**: Concise explanation of the bug type, subsystem, and execution context.`);
	parts.push(`- **Root Cause**: Deep-dive explanation of why the crash happens (e.g. missing NULL check, lifetime race, reference count leak, improper unregistration, integer overflow).`);
	parts.push(`- **Trace & Location**: Walk through the call trace to the faulting line in \`${data.sourceLocation || "source"}\`.`);
	parts.push(`- **Reproducer Mechanism**: Explain how the reproducer triggers this specific state.`);
	parts.push(`- **Prior Discussions**: Note whether existing patches were discussed on the mailing list.`);
	parts.push("");
	parts.push(`### Section 2: Proposed Fix & Patch`);
	parts.push(`- Explain the proposed resolution logic and why it is safe.`);
	parts.push(`- Provide a production-ready, upstream-format Linux kernel patch (\`git diff\` format):`);
	parts.push(`  - Descriptive commit title & message explaining the problem, root cause, and fix.`);
	parts.push(`  - Relevant tags (\`Fixes:\` if identifiable, \`Reported-by: ${data.reportedBy || "syzbot"}\`, \`Signed-off-by:\`).`);
	parts.push(`  - Clean, minimal diff fixing the bug.`);

	return parts.join("\n");
}

/* =====================================================================
 * Extension Entry Point
 * ===================================================================== */

export default function syzkallerPlugin(pi: ExtensionAPI) {
	// Tool 1: List Syzbot Bugs
	pi.registerTool({
		name: "syzkaller_list_bugs",
		label: "Syzbot Bug List",
		description:
			"Fetch and display the list of open Linux kernel bugs from syzkaller/syzbot dashboard. By default returns bugs active today & yesterday (< 48h). Can be filtered by subsystem, query, or requested for 'all'.",
		parameters: SyzkallerListParams,

		async execute(_toolCallId, params) {
			const subsystem = params.subsystem;
			const timeframe = params.timeframe === "all" ? "all" : "recent";
			const limit = params.limit ? Math.max(1, params.limit) : undefined;
			const hasReproOnly = !!params.hasReproOnly;
			const query = params.query || "";

			try {
				const listData = await fetchSyzbotBugList(subsystem, timeframe, limit, hasReproOnly, query);
				const formattedText = serializeBugListForModel(listData);

				return {
					content: [{ type: "text", text: formattedText }],
					details: {
						count: listData.bugs.length,
						totalOpen: listData.totalOpen,
						timeframe: listData.timeframe,
						isFallback: listData.isFallback,
						subsystem: listData.subsystem || "all",
						reproCount: listData.bugs.filter((b) => b.hasC || b.hasSyz).length,
					},
				};
			} catch (err: any) {
				throw new Error(`Failed to fetch syzbot bug list: ${err.message}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("syzkaller list "));
			text += theme.fg("accent", args.subsystem || "all upstream");
			if (args.timeframe === "all") {
				text += theme.fg("muted", " [all dates]");
			} else {
				text += theme.fg("muted", " [today & yesterday]");
			}
			if (args.hasReproOnly) text += theme.fg("muted", " [with repro]");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as any;
			if (!details) {
				return new Text(theme.fg("success", "Syzbot bugs fetched"), 0, 0);
			}

			let summary = theme.fg("success", `✓ Fetched ${details.count} syzbot bugs`);
			const mode = details.timeframe === "recent" ? "today & yesterday" : "all dates";
			summary += theme.fg("muted", ` (${details.subsystem}, ${mode}, ${details.reproCount} with repro)`);

			if (expanded && result.content[0]?.type === "text") {
				const preview = result.content[0].text.split("\n").slice(0, 16).join("\n");
				summary += `\n${theme.fg("dim", preview)}\n${theme.fg("muted", "...")}`;
			}

			return new Text(summary, 0, 0);
		},
	});

	// Tool 2: Read Report & Deep Dive
	pi.registerTool({
		name: "syzkaller_read_report",
		label: "Syzkaller Report",
		description:
			"Read and analyze a specific Syzkaller/syzbot report, URL, extid, reproducer, or local crash file. Automatically correlates faulting code with the local kernel repository to generate an in-depth Overview + Patch.",
		parameters: SyzkallerReportParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let target = params.target.trim();
			const fetchReproducer = params.fetchReproducer !== false;
			const checkLocalSource = params.checkLocalSource !== false;

			// Handle raw extid or id (e.g. 8420e667af06b1709c00)
			if (/^[0-9a-fA-F]{16,40}$/.test(target)) {
				target = `https://syzkaller.appspot.com/bug?extid=${target}`;
			}

			let resultData: SyzkallerResultData;

			try {
				if (/^https?:\/\//i.test(target)) {
					const urlObj = new URL(target);
					if (urlObj.hostname.includes("syzkaller.appspot.com")) {
						if (urlObj.pathname === "/text" || urlObj.pathname.startsWith("/x/")) {
							const text = await fetchHttpText(target);
							const tag = urlObj.searchParams.get("tag") || "";
							if (tag === "ReproC" || target.includes("repro.c")) {
								resultData = {
									title: "Syzkaller C Reproducer",
									category: "Bug Reproducer",
									subsystems: [],
									discussions: [],
									localSnippets: [],
									reproC: text,
									url: target,
								};
							} else if (tag === "ReproSyz" || target.includes("repro.syz")) {
								resultData = {
									title: "Syzkaller .syz Reproducer",
									category: "Bug Reproducer",
									subsystems: [],
									discussions: [],
									localSnippets: [],
									reproSyz: text,
									url: target,
								};
							} else {
								const parsedReport = parseSyzkallerReport(text);
								resultData = {
									title: parsedReport.title,
									category: parsedReport.category,
									sourceLocation: parsedReport.faultLocation?.file
										? `${parsedReport.faultLocation.file}${parsedReport.faultLocation.line ? `:${parsedReport.faultLocation.line}` : ""}`
										: undefined,
									subsystems: [],
									discussions: [],
									parsedReport,
									localSnippets: [],
									url: target,
								};
							}
						} else {
							resultData = await fetchFromSyzbotPage(target, fetchReproducer);
						}
					} else {
						const text = await fetchHttpText(target);
						const parsedReport = parseSyzkallerReport(text);
						resultData = {
							title: parsedReport.title,
							category: parsedReport.category,
							sourceLocation: parsedReport.faultLocation?.file
								? `${parsedReport.faultLocation.file}${parsedReport.faultLocation.line ? `:${parsedReport.faultLocation.line}` : ""}`
								: undefined,
							subsystems: [],
							discussions: [],
							parsedReport,
							localSnippets: [],
							url: target,
						};
					}
				} else {
					const resolvedPath = path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target);
					if (fs.existsSync(resolvedPath)) {
						const stat = fs.statSync(resolvedPath);
						if (stat.isDirectory()) {
							resultData = readFromLocalDirectory(resolvedPath);
						} else {
							resultData = readFromLocalFile(resolvedPath);
						}
					} else if (target.includes("\n") || target.includes("Call Trace:") || target.includes("KASAN:")) {
						const parsedReport = parseSyzkallerReport(target);
						resultData = {
							title: parsedReport.title,
							category: parsedReport.category,
							sourceLocation: parsedReport.faultLocation?.file
								? `${parsedReport.faultLocation.file}${parsedReport.faultLocation.line ? `:${parsedReport.faultLocation.line}` : ""}`
								: undefined,
							subsystems: [],
							discussions: [],
							parsedReport,
							localSnippets: [],
						};
					} else {
						throw new Error(`Target is neither an accessible URL, hex extid, file, nor report text: "${target}"`);
					}
				}

				if (checkLocalSource && resultData.parsedReport) {
					const rep = resultData.parsedReport;

					if (rep.faultLocation?.file && rep.faultLocation.line) {
						const snippet = getLocalCodeSnippet(ctx.cwd, rep.faultLocation.file, rep.faultLocation.line);
						if (snippet) {
							resultData.localSnippets.push({
								file: rep.faultLocation.file,
								line: rep.faultLocation.line,
								role: "crash",
								snippet,
								gitCommit: getRecentGitCommit(ctx.cwd, rep.faultLocation.file),
							});
						}
					}

					if (rep.allocFrames.length > 0) {
						const topAlloc = findEffectiveCrashSite(rep.allocFrames);
						if (topAlloc?.file && topAlloc.line && topAlloc.file !== rep.faultLocation?.file) {
							const snippet = getLocalCodeSnippet(ctx.cwd, topAlloc.file, topAlloc.line);
							if (snippet) {
								resultData.localSnippets.push({
									file: topAlloc.file,
									line: topAlloc.line,
									role: "alloc",
									snippet,
									gitCommit: getRecentGitCommit(ctx.cwd, topAlloc.file),
								});
							}
						}
					}

					if (rep.freedFrames.length > 0) {
						const topFree = findEffectiveCrashSite(rep.freedFrames);
						if (topFree?.file && topFree.line && topFree.file !== rep.faultLocation?.file) {
							const snippet = getLocalCodeSnippet(ctx.cwd, topFree.file, topFree.line);
							if (snippet) {
								resultData.localSnippets.push({
									file: topFree.file,
									line: topFree.line,
									role: "free",
									snippet,
									gitCommit: getRecentGitCommit(ctx.cwd, topFree.file),
								});
							}
						}
					}
				}

				const formattedOutput = serializeReportForModel(resultData);

				return {
					content: [{ type: "text", text: formattedOutput }],
					details: {
						title: resultData.title,
						category: resultData.category,
						sourceLocation: resultData.sourceLocation,
						hasLocalSnippet: resultData.localSnippets.length > 0,
						hasReproC: !!resultData.reproC,
						hasReproSyz: !!resultData.reproSyz,
						discussionCount: resultData.discussions.length,
						status: resultData.status,
					},
				};
			} catch (err: any) {
				throw new Error(`Failed to process syzkaller report (${target}): ${err.message}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("syzkaller "));
			const target = args.target ? (args.target.length > 60 ? `${args.target.slice(0, 57)}...` : args.target) : "";
			text += theme.fg("accent", target);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as any;
			if (!details) {
				return new Text(theme.fg("success", "Syzkaller report loaded"), 0, 0);
			}

			let summary = theme.fg("success", `✓ [${details.category || "Crash"}] `);
			summary += theme.bold(details.title || "Report");

			const meta: string[] = [];
			if (details.sourceLocation) meta.push(`at ${details.sourceLocation}`);
			if (details.hasLocalSnippet) meta.push("local source matched");
			if (details.hasReproC) meta.push("C repro");
			if (details.hasReproSyz) meta.push("syz repro");
			if (details.discussionCount) meta.push(`${details.discussionCount} discussion(s)`);

			if (meta.length > 0) {
				summary += theme.fg("muted", ` (${meta.join(", ")})`);
			}

			if (expanded && result.content[0]?.type === "text") {
				const preview = result.content[0].text.split("\n").slice(0, 16).join("\n");
				summary += `\n${theme.fg("dim", preview)}\n${theme.fg("muted", "...")}`;
			}

			return new Text(summary, 0, 0);
		},
	});

	// Register the /syzkaller slash command
	pi.registerCommand("syzkaller", {
		description: "Fetch syzbot bugs (today & yesterday by default) or analyze a bug report: /syzkaller [subsystem | all | count | extid]",
		handler: async (args, ctx) => {
			const raw = args.trim();
			const parts = raw ? raw.split(/\s+/) : [];

			// Check if first arg is an extid, url, or file path
			if (
				parts.length > 0 &&
				(/^https?:\/\//i.test(parts[0]) ||
					/^[0-9a-fA-F]{16,40}$/.test(parts[0]) ||
					parts[0].includes(".log") ||
					parts[0].includes(".txt") ||
					parts[0].includes(".c"))
			) {
				await pi.sendUserMessage(
					`Please examine the Syzkaller bug report at '${parts[0]}' using the syzkaller_read_report tool.\n\n` +
						`Provide:\n` +
						`1. **Bug Overview & Root Cause Analysis**: Detailed explanation of why the crash happens, correlating stack traces, faulting lines, and reproducer.\n` +
						`2. **Proposed Fix & Patch**: Complete, ready-to-apply Linux kernel patch in git diff format with descriptive commit message and tags.`,
				);
				return;
			}

			// Otherwise, list bugs
			let subsystem: string | undefined;
			let timeframe: "recent" | "all" = "recent";
			let limit: number | undefined;

			for (const p of parts) {
				if (!p) continue;
				if (p.toLowerCase() === "all") {
					timeframe = "all";
				} else if (/^\d+$/.test(p)) {
					limit = parseInt(p, 10);
					timeframe = "all";
				} else if (/^[a-zA-Z0-9_\-]+$/.test(p)) {
					subsystem = p.toLowerCase();
				}
			}

			const subText = subsystem ? ` for subsystem '${subsystem}'` : "";
			const timeText = timeframe === "all" ? (limit ? ` (top ${limit} bugs)` : ` (all open bugs)`) : ` from today & yesterday`;

			await pi.sendUserMessage(
				`Please fetch and display open Linux kernel bugs from syzkaller${subText}${timeText} using the syzkaller_list_bugs tool with timeframe: '${timeframe}'${limit ? `, limit: ${limit}` : ""}${subsystem ? `, subsystem: '${subsystem}'` : ""}.\n\n` +
					`Important instructions:\n` +
					`- Only fetch and display the bug list table.\n` +
					`- Do not write deep-dive analyses or patches for every bug yet.\n` +
					`- Remind me that I can ask for 'all' or specify a count, or pick a bug number to examine in detail.`,
			);
		},
	});

	// Register alias /syz
	pi.registerCommand("syz", {
		description: "Alias for /syzkaller: /syz [subsystem | all | count | extid]",
		handler: async (args, ctx) => {
			const raw = args.trim();
			const parts = raw ? raw.split(/\s+/) : [];

			if (
				parts.length > 0 &&
				(/^https?:\/\//i.test(parts[0]) ||
					/^[0-9a-fA-F]{16,40}$/.test(parts[0]) ||
					parts[0].includes(".log") ||
					parts[0].includes(".txt") ||
					parts[0].includes(".c"))
			) {
				await pi.sendUserMessage(
					`Please examine the Syzkaller bug report at '${parts[0]}' using the syzkaller_read_report tool.\n\n` +
						`Provide:\n` +
						`1. **Bug Overview & Root Cause Analysis**: Detailed explanation of why the crash happens, correlating stack traces, faulting lines, and reproducer.\n` +
						`2. **Proposed Fix & Patch**: Complete, ready-to-apply Linux kernel patch in git diff format with descriptive commit message and tags.`,
				);
				return;
			}

			let subsystem: string | undefined;
			let timeframe: "recent" | "all" = "recent";
			let limit: number | undefined;

			for (const p of parts) {
				if (!p) continue;
				if (p.toLowerCase() === "all") {
					timeframe = "all";
				} else if (/^\d+$/.test(p)) {
					limit = parseInt(p, 10);
					timeframe = "all";
				} else if (/^[a-zA-Z0-9_\-]+$/.test(p)) {
					subsystem = p.toLowerCase();
				}
			}

			const subText = subsystem ? ` for subsystem '${subsystem}'` : "";
			const timeText = timeframe === "all" ? (limit ? ` (top ${limit} bugs)` : ` (all open bugs)`) : ` from today & yesterday`;

			await pi.sendUserMessage(
				`Please fetch and display open Linux kernel bugs from syzkaller${subText}${timeText} using the syzkaller_list_bugs tool with timeframe: '${timeframe}'${limit ? `, limit: ${limit}` : ""}${subsystem ? `, subsystem: '${subsystem}'` : ""}.\n\n` +
					`Important instructions:\n` +
					`- Only fetch and display the bug list table.\n` +
					`- Do not write deep-dive analyses or patches for every bug yet.\n` +
					`- Remind me that I can ask for 'all' or specify a count, or pick a bug number to examine in detail.`,
			);
		},
	});
}
