import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { gunzipSync } from "node:zlib";

/**
 * Common Linux kernel mailing list aliases and shortcuts for lore.kernel.org.
 */
const LIST_ALIASES: Record<string, string> = {
	lkml: "lkml",
	"linux-kernel": "lkml",
	netdev: "netdev",
	bpf: "bpf",
	arm: "linux-arm-kernel",
	"linux-arm": "linux-arm-kernel",
	"linux-arm-kernel": "linux-arm-kernel",
	riscv: "linux-riscv",
	"linux-riscv": "linux-riscv",
	kvm: "kvm",
	fs: "linux-fsdevel",
	fsdevel: "linux-fsdevel",
	"linux-fsdevel": "linux-fsdevel",
	mm: "linux-mm",
	"linux-mm": "linux-mm",
	ext4: "linux-ext4",
	"linux-ext4": "linux-ext4",
	bcachefs: "linux-bcachefs",
	"linux-bcachefs": "linux-bcachefs",
	wireless: "linux-wireless",
	"linux-wireless": "linux-wireless",
	block: "linux-block",
	"linux-block": "linux-block",
	"io-uring": "io-uring",
	io_uring: "io-uring",
	rust: "rust-for-linux",
	"rust-for-linux": "rust-for-linux",
	usb: "linux-usb",
	"linux-usb": "linux-usb",
	pci: "linux-pci",
	"linux-pci": "linux-pci",
	crypto: "linux-crypto",
	"linux-crypto": "linux-crypto",
	scsi: "linux-scsi",
	"linux-scsi": "linux-scsi",
	pm: "linux-pm",
	"linux-pm": "linux-pm",
	all: "all",
};

function resolveListName(rawList?: string): string {
	if (!rawList) return "all";
	const key = rawList.trim().toLowerCase();
	return LIST_ALIASES[key] || key;
}

/**
 * XML / HTML entity decoding.
 */
function decodeXml(str: string): string {
	if (!str) return "";
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Strip XML/HTML tags and decode content for clean snippets.
 */
function stripHtml(html: string): string {
	if (!html) return "";
	return decodeXml(html.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Decode RFC2047 encoded header strings (e.g., =?UTF-8?B?...?= or =?UTF-8?Q?...?=).
 */
function decodeRfc2047(str: string): string {
	if (!str) return "";
	return str.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
		try {
			const enc = encoding.toUpperCase();
			if (enc === "B") {
				return Buffer.from(text, "base64").toString(charset.toLowerCase().includes("utf") ? "utf-8" : "latin1");
			}
			if (enc === "Q") {
				return text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16)));
			}
		} catch {
			// fallback to raw text on error
		}
		return text;
	});
}

/**
 * Decode Quoted-Printable body text.
 */
function decodeQuotedPrintable(str: string): string {
	return str
		.replace(/=\r?\n/g, "")
		.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Decode Base64 body text.
 */
function decodeBase64(str: string): string {
	try {
		return Buffer.from(str.replace(/\s+/g, ""), "base64").toString("utf-8");
	} catch {
		return str;
	}
}

/**
 * Extract plain text body from RFC822 email, handling multipart, quoted-printable, and base64.
 */
function extractEmailBody(headers: Record<string, string>, rawBody: string): string {
	const contentType = (headers["content-type"] || "text/plain").toLowerCase();
	const transferEncoding = (headers["content-transfer-encoding"] || "").toLowerCase().trim();

	if (contentType.includes("multipart/")) {
		const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
		if (boundaryMatch) {
			const boundary = boundaryMatch[1];
			const parts = rawBody.split(new RegExp(`--${boundary}(?:--)?`));
			for (const part of parts) {
				const partHeaderEnd = part.search(/\r?\n\r?\n/);
				if (partHeaderEnd !== -1) {
					const partHeadersText = part.slice(0, partHeaderEnd);
					const partBody = part.slice(partHeaderEnd).replace(/^\r?\n\r?\n/, "");
					if (/content-type:\s*text\/plain/i.test(partHeadersText) || !/content-type:/i.test(partHeadersText)) {
						const partEnc = partHeadersText.match(/content-transfer-encoding:\s*([^\r\n]+)/i)?.[1]?.toLowerCase().trim() || "";
						return decodeBodyEncoding(partBody, partEnc);
					}
				}
			}
		}
	}

	return decodeBodyEncoding(rawBody, transferEncoding);
}

function decodeBodyEncoding(body: string, encoding: string): string {
	if (encoding === "quoted-printable") {
		return decodeQuotedPrintable(body);
	}
	if (encoding === "base64") {
		return decodeBase64(body);
	}
	return body;
}

/**
 * Clean Message-ID strings.
 */
function cleanMsgId(raw?: string): string {
	if (!raw) return "";
	return decodeURIComponent(raw.trim())
		.replace(/^<|>$/g, "")
		.replace(/\/$/, "");
}

/**
 * Parse input target (URL or Message-ID) into clean msgId and list name.
 */
function parseTarget(input: string): { msgId: string; list: string } {
	let target = input.trim().replace(/^<|>$/g, "").trim();

	if (target.startsWith("http://") || target.startsWith("https://")) {
		try {
			const url = new URL(target);
			const parts = url.pathname.split("/").filter(Boolean);
			if (parts.length >= 2) {
				const list = parts[0];
				let msgId = parts[1];
				if (list === "all" && parts.length >= 2) {
					msgId = parts[1];
				}
				msgId = decodeURIComponent(msgId.replace(/\.(mbox(\.gz)?|raw)$/, ""));
				return { msgId, list: list === "all" ? "" : list };
			}
		} catch {
			// fall through
		}
	}

	const cleaned = decodeURIComponent(target.replace(/^<|>$/g, "").replace(/\/$/, ""));
	return { msgId: cleaned, list: "" };
}

/**
 * Separate commit message, notes/diffstat, and diff in a git email.
 */
function splitPatchBody(body: string): { commitMsg: string; notes: string; diff: string } {
	const diffMatch = body.match(/\n(?=(?:diff --git |Index: |--- [a-zA-Z0-9_\.\/]+\t|=== modified file|--- [a-z0-9_\.\/-]+\n\+\+\+ [a-z0-9_\.\/-]+))/);
	if (!diffMatch || diffMatch.index === undefined) {
		return { commitMsg: body.trim(), notes: "", diff: "" };
	}

	const diffIdx = diffMatch.index + 1;
	const beforeDiff = body.slice(0, diffIdx);
	const diff = body.slice(diffIdx).trim();

	const dashMatch = beforeDiff.match(/\n---\s*(?:\n|$)/);
	if (dashMatch && dashMatch.index !== undefined) {
		const commitMsg = beforeDiff.slice(0, dashMatch.index).trim();
		const notes = beforeDiff.slice(dashMatch.index + dashMatch[0].length).trim();
		return { commitMsg, notes, diff };
	}

	return { commitMsg: beforeDiff.trim(), notes: "", diff };
}

/**
 * Truncate long diffs to keep context manageable.
 */
function formatDiff(diff?: string, maxLines = 150): string {
	if (!diff) return "";
	const lines = diff.split("\n");
	if (lines.length <= maxLines) {
		return diff;
	}
	const head = lines.slice(0, maxLines).join("\n");
	const omitted = lines.length - maxLines;
	return `${head}\n\n[... Diff truncated: ${omitted} additional lines omitted ...]`;
}

/**
 * Parse patch subject info (cover letter, series index, version, standalone).
 */
function extractPatchSubjectInfo(subject: string): {
	type: "cover" | "patch" | "reply" | "standalone";
	index?: number;
	total?: number;
	version?: string;
} {
	if (/^\s*re:\s*/i.test(subject)) {
		return { type: "reply" };
	}

	const vMatch = subject.match(/\bv(\d+)\b/i);
	const version = vMatch ? `v${vMatch[1]}` : undefined;

	const numMatch = subject.match(/\[(?:[^\]]*\s+)?(\d+)\/(\d+)\]/i);
	if (numMatch) {
		const index = parseInt(numMatch[1], 10);
		const total = parseInt(numMatch[2], 10);
		if (index === 0) {
			return { type: "cover", index: 0, total, version };
		}
		return { type: "patch", index, total, version };
	}

	if (/\[(?:[^\]]*\s+)?PATCH/i.test(subject)) {
		return { type: "standalone", index: 1, total: 1, version };
	}

	return { type: "standalone" };
}

/**
 * Atom entry item representation.
 */
export interface LorePatchListItem {
	index: number;
	title: string;
	authorName: string;
	authorEmail?: string;
	date: string;
	link: string;
	msgId: string;
	snippet: string;
	patchType: string;
	isCoverLetter: boolean;
	totalInSeries?: number;
}

/**
 * Detailed structures for full patch/series inspection.
 */
export interface LoreCommentItem {
	msgId: string;
	author: string;
	date: string;
	subject: string;
	content: string;
	inReplyTo?: string;
	reviewTags: string[];
}

export interface LorePatchDetailItem {
	msgId: string;
	index: number;
	total?: number;
	subject: string;
	author: string;
	date: string;
	commitMsg: string;
	notes?: string;
	diff?: string;
	comments: LoreCommentItem[];
}

export interface LoreCoverLetterItem {
	msgId: string;
	subject: string;
	author: string;
	date: string;
	content: string;
	comments: LoreCommentItem[];
}

export interface LoreSeriesDetail {
	title: string;
	url: string;
	msgId: string;
	list?: string;
	coverLetter?: LoreCoverLetterItem | null;
	patches: LorePatchDetailItem[];
	standaloneComments: LoreCommentItem[];
}

/**
 * Format UTC date YYYYMMDD for public-inbox date queries.
 */
function getYesterdayDateStr(): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - 1);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

/**
 * Fetch and parse list of patches from lore.kernel.org Atom feed.
 * Default behavior: retrieves all patches from today and yesterday (the most recent ones).
 * If limit is a number: retrieves up to that specific number of patches.
 * If all is true or limit is 'all': retrieves all available patches (paginated).
 */
async function fetchLorePatchesList(options: {
	list?: string;
	query?: string;
	limit?: number | "all";
	all?: boolean;
	onlyOriginalSubmissions?: boolean;
}): Promise<{
	listName: string;
	feedUrl: string;
	totalFound: number;
	items: LorePatchListItem[];
	note?: string;
}> {
	const listName = resolveListName(options.list);
	const onlyOriginal = options.onlyOriginalSubmissions !== false;
	const isAll = options.all === true || options.limit === "all" || (typeof options.limit === "number" && options.limit <= 0);
	const targetCount = isAll ? 1000 : (typeof options.limit === "number" ? options.limit : undefined);
	const userQuery = options.query?.trim();

	let baseQuery = "";
	let isDefaultDateFilter = false;
	let yesterdayStr = "";

	if (targetCount === undefined && !isAll) {
		// Default mode: today + yesterday
		isDefaultDateFilter = true;
		yesterdayStr = getYesterdayDateStr();
		const dateFilter = `d:${yesterdayStr}..`;
		if (onlyOriginal) {
			baseQuery = userQuery ? `s:PATCH AND NOT s:Re: AND ${dateFilter} AND (${userQuery})` : `s:PATCH AND NOT s:Re: AND ${dateFilter}`;
		} else {
			baseQuery = userQuery ? `${dateFilter} AND (${userQuery})` : dateFilter;
		}
	} else {
		// Explicit count or "all"
		if (onlyOriginal) {
			baseQuery = userQuery ? `s:PATCH AND NOT s:Re: AND (${userQuery})` : "s:PATCH AND NOT s:Re:";
		} else {
			baseQuery = userQuery || "";
		}
	}

	async function fetchPage(query: string, offset: number): Promise<{ items: LorePatchListItem[]; pageCount: number; feedUrl: string }> {
		const feedUrl = query
			? `https://lore.kernel.org/${listName}/?q=${encodeURIComponent(query)}&x=A&o=${offset}`
			: `https://lore.kernel.org/${listName}/new.atom?o=${offset}`;

		const res = await fetch(feedUrl, {
			headers: {
				"User-Agent": "git/2.43.0",
				"Accept-Encoding": "gzip, deflate",
			},
		});

		if (!res.ok) {
			if (res.status === 404) {
				const errorBody = await res.text().catch(() => "");
				if (errorBody.includes("No results found") || offset > 0) {
					return { items: [], pageCount: 0, feedUrl };
				}
			}
			throw new Error(`HTTP ${res.status} (${res.statusText}) fetching ${feedUrl}`);
		}

		const text = await res.text();
		const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
		const pageItems: LorePatchListItem[] = [];
		let match: RegExpExecArray | null;

		while ((match = entryRegex.exec(text)) !== null) {
			const block = match[1];
			const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || "Untitled");
			const authorName = decodeXml(block.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/)?.[1]?.trim() || "Unknown");
			const authorEmail = decodeXml(block.match(/<email>([\s\S]*?)<\/email>/)?.[1]?.trim() || "");
			const updated = block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1]?.trim() || "";
			const link = block.match(/<link\s+href="([^"]+)"/)?.[1]?.trim() || "";
			const rawContent = block.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || "";
			const snippet = stripHtml(rawContent).slice(0, 160);

			const msgIdMatch = link.match(/\/([^/]+)\/?$/);
			const msgId = msgIdMatch ? decodeURIComponent(msgIdMatch[1]) : "";

			const info = extractPatchSubjectInfo(title);
			let patchType = "Patch";
			let isCoverLetter = false;

			if (info.type === "cover") {
				patchType = `Series Cover Letter (${info.total} patches)`;
				isCoverLetter = true;
			} else if (info.type === "patch") {
				patchType = `Patch ${info.index}/${info.total}`;
			} else if (info.type === "standalone") {
				patchType = "Standalone Patch";
			} else if (info.type === "reply") {
				patchType = "Review / Reply";
			}

			pageItems.push({
				index: 0,
				title,
				authorName,
				authorEmail,
				date: updated,
				link,
				msgId,
				snippet,
				patchType,
				isCoverLetter,
				totalInSeries: info.total,
			});
		}

		return { items: pageItems, pageCount: pageItems.length, feedUrl };
	}

	let items: LorePatchListItem[] = [];
	let offset = 0;
	let note: string | undefined;
	let initialFeedUrl = "";
	const maxNeeded = targetCount ?? 1000;

	while (items.length < maxNeeded) {
		const page = await fetchPage(baseQuery, offset);
		if (!initialFeedUrl) {
			initialFeedUrl = page.feedUrl;
		}
		if (page.items.length === 0) break;

		items.push(...page.items);
		offset += 200;

		// If public-inbox returned less than 200 items, there are no more pages
		if (page.pageCount < 200) break;
	}

	// Fallback if default today+yesterday mode returned 0 items
	if (isDefaultDateFilter && items.length === 0) {
		note = `No patches found from today or yesterday (since ${yesterdayStr}). Falling back to the 20 most recent submissions.`;
		const fallbackQuery = onlyOriginal
			? (userQuery ? `s:PATCH AND NOT s:Re: AND (${userQuery})` : "s:PATCH AND NOT s:Re:")
			: (userQuery || "");
		const page = await fetchPage(fallbackQuery, 0);
		initialFeedUrl = page.feedUrl;
		items = page.items.slice(0, 20);
	} else if (targetCount !== undefined && items.length > targetCount) {
		items = items.slice(0, targetCount);
	} else if (isAll && items.length >= 1000) {
		note = `Results capped at 1000 patches to maintain context size. Use a query filter or date range for older archives.`;
	}

	// Re-index items 1..N
	items.forEach((it, i) => {
		it.index = i + 1;
	});

	return {
		listName,
		feedUrl: initialFeedUrl,
		totalFound: items.length,
		items,
		note,
	};
}

/**
 * Fetch thread mbox (or single raw message) and parse full patch series details.
 */
async function fetchLoreSeriesDetail(targetInput: string, maxDiffLines = 150): Promise<LoreSeriesDetail> {
	const { msgId, list } = parseTarget(targetInput);
	if (!msgId) {
		throw new Error(`Unable to determine Message-ID from "${targetInput}"`);
	}

	const candidates = [
		list ? `https://lore.kernel.org/${list}/${encodeURIComponent(msgId)}/t.mbox.gz` : null,
		`https://lore.kernel.org/all/${encodeURIComponent(msgId)}/t.mbox.gz`,
		list ? `https://lore.kernel.org/${list}/${encodeURIComponent(msgId)}/raw` : null,
		`https://lore.kernel.org/all/${encodeURIComponent(msgId)}/raw`,
	].filter(Boolean) as string[];

	let rawMbox = "";
	let fetchedFromUrl = "";

	for (const url of candidates) {
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": "git/2.43.0",
					"Accept-Encoding": "gzip, deflate",
				},
			});

			if (!res.ok) continue;

			if (url.endsWith(".gz")) {
				const buf = Buffer.from(await res.arrayBuffer());
				rawMbox = gunzipSync(buf).toString("utf-8");
			} else {
				rawMbox = await res.text();
			}

			if (rawMbox.trim().length > 0) {
				fetchedFromUrl = url;
				break;
			}
		} catch {
			// try next candidate
		}
	}

	if (!rawMbox) {
		throw new Error(`Could not retrieve thread or patch for Message-ID <${msgId}> from lore.kernel.org`);
	}

	// Parse mbox messages
	const rawMessages = rawMbox.split(/\n(?=From [^\n]+)/);
	const parsedMessages: Array<{
		msgId: string;
		subject: string;
		from: string;
		date: string;
		inReplyTo: string;
		headers: Record<string, string>;
		body: string;
	}> = [];

	for (const rawMsg of rawMessages) {
		const headerEnd = rawMsg.search(/\r?\n\r?\n/);
		if (headerEnd === -1) continue;
		const headerText = rawMsg.slice(0, headerEnd);
		const rawBody = rawMsg.slice(headerEnd).replace(/^\r?\n\r?\n/, "");

		const lines = headerText.split(/\r?\n/);
		const headers: Record<string, string> = {};
		let curKey = "";
		for (const line of lines) {
			if (/^\s/.test(line) && curKey) {
				headers[curKey] += " " + line.trim();
			} else {
				const colon = line.indexOf(":");
				if (colon !== -1) {
					curKey = line.slice(0, colon).toLowerCase().trim();
					headers[curKey] = line.slice(colon + 1).trim();
				}
			}
		}

		const mid = cleanMsgId(headers["message-id"]);
		const subj = decodeRfc2047(headers["subject"] || "").replace(/\r?\n\s+/g, " ").trim();
		const from = decodeRfc2047(headers["from"] || "").replace(/\r?\n\s+/g, " ").trim();
		const date = headers["date"] || "";
		const inReplyTo = cleanMsgId(headers["in-reply-to"]);
		const body = extractEmailBody(headers, rawBody);

		parsedMessages.push({
			msgId: mid,
			subject: subj,
			from,
			date,
			inReplyTo,
			headers,
			body,
		});
	}

	let coverLetter: LoreCoverLetterItem | null = null;
	const patches: LorePatchDetailItem[] = [];
	const comments: LoreCommentItem[] = [];

	for (const msg of parsedMessages) {
		const info = extractPatchSubjectInfo(msg.subject);

		if (info.type === "reply") {
			const reviewTags = [...msg.body.matchAll(/^(?:Reviewed-by|Acked-by|Tested-by|Reported-by|Suggested-by|Signed-off-by):[^\r\n]+/gim)].map((m) =>
				m[0].trim(),
			);
			comments.push({
				msgId: msg.msgId,
				author: msg.from,
				date: msg.date,
				subject: msg.subject,
				content: msg.body.trim(),
				inReplyTo: msg.inReplyTo,
				reviewTags,
			});
			continue;
		}

		if (info.type === "cover") {
			coverLetter = {
				msgId: msg.msgId,
				subject: msg.subject,
				author: msg.from,
				date: msg.date,
				content: msg.body.trim(),
				comments: [],
			};
			continue;
		}

		// Standalone or patch in a series
		const { commitMsg, notes, diff } = splitPatchBody(msg.body);
		patches.push({
			msgId: msg.msgId,
			index: info.index ?? patches.length + 1,
			total: info.total,
			subject: msg.subject,
			author: msg.from,
			date: msg.date,
			commitMsg,
			notes,
			diff: diff ? formatDiff(diff, maxDiffLines) : undefined,
			comments: [],
		});
	}

	// Sort patches by series index
	patches.sort((a, b) => a.index - b.index);

	// Map comments to their parent patch or cover letter
	const standaloneComments: LoreCommentItem[] = [];
	const patchMap = new Map<string, LorePatchDetailItem>();
	for (const p of patches) {
		patchMap.set(p.msgId, p);
	}

	const commentParentMap = new Map<string, string>();
	for (const c of comments) {
		if (c.inReplyTo) {
			commentParentMap.set(c.msgId, c.inReplyTo);
		}
	}

	function findRootId(currentMid?: string): string | undefined {
		let curr = currentMid;
		let depth = 0;
		while (curr && depth < 10) {
			if (patchMap.has(curr) || (coverLetter && coverLetter.msgId === curr)) {
				return curr;
			}
			curr = commentParentMap.get(curr);
			depth++;
		}
		return undefined;
	}

	for (const c of comments) {
		const rootId = findRootId(c.inReplyTo);
		if (coverLetter && rootId === coverLetter.msgId) {
			coverLetter.comments.push(c);
		} else if (rootId && patchMap.has(rootId)) {
			patchMap.get(rootId)!.comments.push(c);
		} else {
			standaloneComments.push(c);
		}
	}

	const title = coverLetter ? coverLetter.subject : patches[0]?.subject || parsedMessages[0]?.subject || "Kernel Patch";
	const primaryList = list || "all";
	const canonicalUrl = `https://lore.kernel.org/${primaryList}/${encodeURIComponent(msgId)}/`;

	return {
		title,
		url: canonicalUrl,
		msgId,
		list: primaryList,
		coverLetter,
		patches,
		standaloneComments,
	};
}

/**
 * Format patch list for model consumption.
 */
function serializePatchListForModel(data: {
	listName: string;
	feedUrl: string;
	totalFound: number;
	items: LorePatchListItem[];
	note?: string;
}): string {
	const parts: string[] = [];
	parts.push(`# Lore Patches List: ${data.listName} (${data.totalFound} items found)`);
	parts.push(`Feed URL: ${data.feedUrl}\n`);

	if (data.note) {
		parts.push(`> ℹ️ ${data.note}\n`);
	}

	if (data.items.length === 0) {
		parts.push("No patches found matching the query or filter.\n");
		return parts.join("\n");
	}

	parts.push("## Recent Patches / Submissions:\n");
	for (const item of data.items) {
		const author = item.authorEmail ? `${item.authorName} <${item.authorEmail}>` : item.authorName;
		parts.push(`### ${item.index}. ${item.title}`);
		parts.push(`- **Type**: ${item.patchType}`);
		parts.push(`- **Author**: ${author}`);
		parts.push(`- **Date**: ${item.date}`);
		parts.push(`- **Message-ID**: \`${item.msgId}\``);
		parts.push(`- **Lore URL**: ${item.link}`);
		if (item.snippet) {
			parts.push(`- **Summary**: ${item.snippet}`);
		}
		parts.push("");
	}

	parts.push("================================================================");
	parts.push("## Instructions for Assistant:");
	parts.push("- Present a clear, well-organized overview of these recent patches.");
	parts.push("- Group them logically or highlight notable series, bugfixes, and subsystems.");
	parts.push("- Let the user know they can inspect any patch or series in full depth (overview + commit message + diff + comments) by saying so or using `/lore read <msgid_or_url>`.");

	return parts.join("\n");
}

/**
 * Format full series detail (overview + patches + comments) for model consumption.
 */
function serializeSeriesDetailForModel(series: LoreSeriesDetail, includeComments = true): string {
	const parts: string[] = [];
	const isMultiPatch = series.patches.length > 1;

	parts.push(`# Lore Patch Details: ${series.title}`);
	parts.push(`Lore URL: ${series.url}`);
	parts.push(`Message-ID: <${series.msgId}>`);
	parts.push(`Total Patches: ${series.patches.length}`);
	const totalComments =
		(series.coverLetter?.comments.length || 0) +
		series.patches.reduce((acc, p) => acc + p.comments.length, 0) +
		series.standaloneComments.length;
	parts.push(`Total Review Comments: ${totalComments}`);
	parts.push("");

	// Cover Letter (Overview)
	if (series.coverLetter) {
		parts.push(`## Cover Letter: ${series.coverLetter.subject}`);
		parts.push(`Submitter: ${series.coverLetter.author}`);
		parts.push(`Date: ${series.coverLetter.date}`);
		parts.push("\n### Series Overview & Motivation:");
		parts.push(series.coverLetter.content || "(No description)");
		parts.push("");

		if (includeComments && series.coverLetter.comments.length > 0) {
			parts.push(`### Comments on Cover Letter (${series.coverLetter.comments.length}):`);
			for (const c of series.coverLetter.comments) {
				parts.push(`\n--- Comment by ${c.author} (${c.date}) ---`);
				if (c.reviewTags.length > 0) {
					parts.push(`Tags: ${c.reviewTags.join(", ")}`);
				}
				parts.push(c.content);
			}
			parts.push("");
		}
	}

	// Patches
	for (let i = 0; i < series.patches.length; i++) {
		const p = series.patches[i];
		const patchNum = i + 1;
		parts.push("\n================================================================");
		parts.push(`## Patch ${patchNum}/${series.patches.length}: ${p.subject}`);
		parts.push(`Message-ID: <${p.msgId}>`);
		parts.push(`Author: ${p.author}`);
		parts.push(`Date: ${p.date}`);

		parts.push("\n### Commit Message & Description:");
		parts.push(p.commitMsg || "(No commit message)");

		if (p.notes) {
			parts.push("\n### Patch Notes / Changelog:");
			parts.push(p.notes);
		}

		if (p.diff) {
			parts.push("\n### Patch Diff:");
			parts.push("```diff");
			parts.push(p.diff);
			parts.push("```");
		}

		if (includeComments) {
			parts.push(`\n### Review Comments (${p.comments.length}):`);
			if (p.comments.length === 0) {
				parts.push("(No review comments recorded for this patch)");
			} else {
				for (const c of p.comments) {
					parts.push(`\n--- Comment by ${c.author} (${c.date}) ---`);
					if (c.reviewTags.length > 0) {
						parts.push(`Review Tags: ${c.reviewTags.join(", ")}`);
					}
					parts.push(c.content);
				}
			}
		}
	}

	if (includeComments && series.standaloneComments.length > 0) {
		parts.push("\n================================================================");
		parts.push(`## Additional Thread Discussions (${series.standaloneComments.length}):`);
		for (const c of series.standaloneComments) {
			parts.push(`\n--- Discussion by ${c.author} (${c.date}) ---`);
			if (c.reviewTags.length > 0) {
				parts.push(`Tags: ${c.reviewTags.join(", ")}`);
			}
			parts.push(c.content);
		}
	}

	parts.push("\n================================================================");
	parts.push("## Summarization Instructions for Assistant:");
	parts.push("Please generate a clear, well-structured markdown summary based on the fetched patch information:");
	if (isMultiPatch) {
		parts.push("1. **Series Overview**: High-level motivation, context, overarching problem, and architecture of the series.");
		parts.push("2. **Individual Patch Breakdown**: For each patch:");
		parts.push("   - **Patch Overview**: What changes are made and scope.");
		parts.push("   - **Reason of the Patch**: Why this fix or feature is necessary.");
		parts.push("   - **Diff Summary**: Key functions/structures touched.");
		parts.push("   - **Review Comments & Discussion**: Review feedback, discussion points, concerns, and tags (Reviewed-by, Acked-by).");
	} else {
		parts.push("1. **Patch Overview**: High-level summary of what the patch changes.");
		parts.push("2. **Reason of the Patch**: Why this fix or feature is necessary.");
		parts.push("3. **Diff Summary**: Key functions/structures touched.");
		parts.push("4. **Review Comments & Discussion**: Synthesis of feedback and review tags (Reviewed-by, Acked-by).");
	}

	return parts.join("\n");
}

/**
 * TypeBox Parameter Schemas.
 */
const LoreListParams = Type.Object({
	list: Type.Optional(
		Type.String({
			description:
				"Mailing list name or shortcut (e.g., 'netdev', 'lkml', 'bpf', 'arm', 'riscv', 'kvm', 'fsdevel', 'mm', 'io-uring', 'rust', or 'all'). Default is 'all'.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "Optional search query or keyword filter (e.g., 'sched', 'tcp', 'bcachefs', author name, etc.).",
		}),
	),
	limit: Type.Optional(
		Type.Union([
			Type.Integer({
				description:
					"Specific number of patch items to retrieve (e.g., 20, 50, 100). If omitted and 'all' is not true, defaults to patches from today and yesterday.",
				minimum: -1,
			}),
			Type.Literal("all"),
		]),
	),
	all: Type.Optional(
		Type.Boolean({
			description: "Set to true to retrieve all patches without limiting to today + yesterday. Equivalent to limit='all'.",
		}),
	),
	onlyOriginalSubmissions: Type.Optional(
		Type.Boolean({
			description: "Filter for patch submissions and cover letters, excluding review reply emails. Default is true.",
		}),
	),
});

const LoreReadParams = Type.Object({
	target: Type.String({
		description:
			"Lore URL (e.g., https://lore.kernel.org/netdev/20261016.../) or Message-ID (e.g., 20261016-b4-enic-...@cisco.com or <20261016-...@cisco.com>)",
	}),
	includeComments: Type.Optional(
		Type.Boolean({
			description: "Whether to include review comments and discussion from the thread (default: true).",
		}),
	),
	maxDiffLines: Type.Optional(
		Type.Integer({
			description: "Maximum number of diff lines to include per patch before truncating (default: 150).",
			minimum: 20,
			maximum: 1000,
		}),
	),
});

export default function lorePlugin(pi: ExtensionAPI) {
	// 1. Tool to list patches
	pi.registerTool({
		name: "lore_list_patches",
		label: "Lore Patches List",
		description:
			"Fetch recent patches from lore.kernel.org mailing lists. By default, fetches patches from today and yesterday (the most recent submissions). Specify a numeric limit (e.g. 50, 100), or set all=true (or limit='all') to retrieve all patches.",
		parameters: LoreListParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const result = await fetchLorePatchesList({
					list: params.list,
					query: params.query,
					limit: params.limit,
					all: params.all,
					onlyOriginalSubmissions: params.onlyOriginalSubmissions,
				});

				const formattedText = serializePatchListForModel(result);

				return {
					content: [{ type: "text", text: formattedText }],
					details: {
						list: result.listName,
						query: params.query || null,
						count: result.totalFound,
						note: result.note || null,
						firstTitles: result.items.slice(0, 5).map((it) => `${it.title} (${it.authorName})`),
					},
				};
			} catch (err: any) {
				throw new Error(`Failed to list patches from lore.kernel.org: ${err.message}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("lore list "));
			text += theme.fg("accent", args.list || "all");
			if (args.query) {
				text += " " + theme.fg("muted", `"${args.query}"`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						list?: string;
						query?: string | null;
						count?: number;
						firstTitles?: string[];
				  }
				| undefined;

			if (!details) {
				return new Text(theme.fg("success", "Lore patches list fetched"), 0, 0);
			}

			let summary = theme.fg("success", `✓ Found ${details.count} patch(es) in lore.kernel.org/${details.list}`);
			if (details.query) {
				summary += theme.fg("muted", ` (matching "${details.query}")`);
			}

			if (expanded && details.firstTitles && details.firstTitles.length > 0) {
				summary += "\n" + theme.fg("dim", details.firstTitles.map((t, i) => `  ${i + 1}. ${t}`).join("\n"));
			}

			return new Text(summary, 0, 0);
		},
	});

	// 2. Tool to read deep patch/series overview, diff, and comments
	pi.registerTool({
		name: "lore_read_patch",
		label: "Lore Read Patch/Series",
		description:
			"Fetch and analyze a specific patch or patch series from lore.kernel.org via URL or Message-ID. Retrieves cover letter overview, commit message, patch diff, and reviewer comments.",
		parameters: LoreReadParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const seriesData = await fetchLoreSeriesDetail(params.target, params.maxDiffLines ?? 150);
				const formattedText = serializeSeriesDetailForModel(seriesData, params.includeComments !== false);

				const totalComments =
					(seriesData.coverLetter?.comments.length || 0) +
					seriesData.patches.reduce((acc, p) => acc + p.comments.length, 0) +
					seriesData.standaloneComments.length;

				return {
					content: [{ type: "text", text: formattedText }],
					details: {
						title: seriesData.title,
						patchCount: seriesData.patches.length,
						commentCount: totalComments,
						hasCoverLetter: !!seriesData.coverLetter,
					},
				};
			} catch (err: any) {
				throw new Error(`Failed to read patch/series "${params.target}" from lore: ${err.message}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("lore read "));
			text += theme.fg("accent", args.target);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						title?: string;
						patchCount?: number;
						commentCount?: number;
				  }
				| undefined;

			if (!details) {
				return new Text(theme.fg("success", "Lore patch fetched"), 0, 0);
			}

			let summary = theme.fg("success", `✓ Fetched "${details.title}"`);
			summary += theme.fg("muted", ` (${details.patchCount} patch(es), ${details.commentCount} comment(s))`);

			if (expanded && result.content[0]?.type === "text") {
				const preview = result.content[0].text.split("\n").slice(0, 12).join("\n");
				summary += `\n${theme.fg("dim", preview)}\n${theme.fg("muted", "...")}`;
			}

			return new Text(summary, 0, 0);
		},
	});

	// Helper to parse arguments for list command
	function parseListTokens(tokens: string[]): { list: string; limit?: number | "all"; query: string } {
		if (tokens.length === 0) return { list: "all", query: "" };
		const list = tokens[0];
		let limit: number | "all" | undefined;
		let queryStartIndex = 1;

		if (tokens.length > 1) {
			const second = tokens[1].toLowerCase();
			if (second === "all") {
				limit = "all";
				queryStartIndex = 2;
			} else if (/^\d+$/.test(second)) {
				limit = parseInt(second, 10);
				queryStartIndex = 2;
			}
		}

		const query = tokens.slice(queryStartIndex).join(" ").trim();
		return { list, limit, query };
	}

	function buildListPrompt(parsed: { list: string; limit?: number | "all"; query: string }): string {
		const { list, limit, query } = parsed;
		let msg = "";
		if (limit === "all") {
			msg = `Please list all patches from lore.kernel.org for mailing list "${list}"`;
			if (query) msg += ` matching query "${query}"`;
			msg += ` using the lore_list_patches tool with all=true.`;
		} else if (typeof limit === "number") {
			msg = `Please list ${limit} patches from lore.kernel.org for mailing list "${list}"`;
			if (query) msg += ` matching query "${query}"`;
			msg += ` using the lore_list_patches tool with limit=${limit}.`;
		} else {
			msg = `Please list recent patches (from today and yesterday) from lore.kernel.org for mailing list "${list}"`;
			if (query) msg += ` matching query "${query}"`;
			msg += ` using the lore_list_patches tool.`;
		}
		return msg;
	}

	// 3. Register the /lore slash command
	pi.registerCommand("lore", {
		description: "Browse and read Linux kernel patches from lore.kernel.org: /lore [list|read] [args]",
		handler: async (args, ctx) => {
			const raw = args.trim();

			if (!raw || raw === "help") {
				ctx.ui.notify(
					"Lore Plugin Usage:\n\n" +
						"  /lore list [mailing-list] [count|all] [query]  - List patches (default: today+yesterday)\n" +
						"  /lore read <url-or-msgid>                      - Deep dive: overview + patch + comments\n" +
						"  /lore <url-or-msgid>                           - Read & summarize (auto-detected)\n" +
						"  /lore <mailing-list> [count|all] [query]       - List patches from mailing list\n\n" +
						"Popular lists: ltp, netdev, lkml, bpf, arm, riscv, kvm, fsdevel, mm, io-uring, rust, all\n\n" +
						"Examples:\n" +
						"  /lore list ltp             - Recent patches from today and yesterday\n" +
						"  /lore list ltp 30          - Last 30 patches from LTP\n" +
						"  /lore list ltp all         - All available patches from LTP\n" +
						"  /lore list netdev 50 tcp   - 50 recent TCP patches on netdev\n" +
						"  /lore read 20261016-b4-enic-dma-vf-index-net-generic-first-v1-20261010-v1-0-d27b55f69883@cisco.com",
					"info",
				);
				return;
			}

			// Subcommand: read / fetch
			if (raw.startsWith("read ") || raw.startsWith("fetch ")) {
				const target = raw.replace(/^(?:read|fetch)\s+/, "").trim();
				await pi.sendUserMessage(
					`Please read and summarize the patch/series "${target}" from lore.kernel.org using the lore_read_patch tool.\n\n` +
						`Provide:\n` +
						`1. Series/patch overview and motivation\n` +
						`2. Patch details and diff breakdown\n` +
						`3. Synthesis of reviewer comments, discussions, and review tags`,
				);
				return;
			}

			// Subcommand: list
			if (raw.startsWith("list")) {
				const rest = raw.replace(/^list\s*/, "").trim();
				const tokens = rest ? rest.split(/\s+/) : [];
				const parsed = parseListTokens(tokens);
				await pi.sendUserMessage(buildListPrompt(parsed));
				return;
			}

			// Auto-detection: URL or Message-ID (contains '@' or starts with http)
			if (raw.startsWith("http://") || raw.startsWith("https://") || raw.includes("@")) {
				await pi.sendUserMessage(
					`Please read and summarize the patch/series "${raw}" from lore.kernel.org using the lore_read_patch tool.\n\n` +
						`Provide:\n` +
						`1. Series/patch overview and motivation\n` +
						`2. Patch details and diff breakdown\n` +
						`3. Synthesis of reviewer comments, discussions, and review tags`,
				);
				return;
			}

			// Default: treat as list name + optional limit/all + query (e.g. "/lore netdev" or "/lore bpf all xdp")
			const tokens = raw.split(/\s+/);
			const parsed = parseListTokens(tokens);
			await pi.sendUserMessage(buildListPrompt(parsed));
		},
	});
}
