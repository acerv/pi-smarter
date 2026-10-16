import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * Common Linux kernel subsystem and project aliases for patchwork.kernel.org.
 */
const PROJECT_ALIASES: Record<string, string> = {
	all: "all",
	netdev: "netdevbpf",
	net: "netdevbpf",
	bpf: "netdevbpf",
	netdevbpf: "netdevbpf",
	ltp: "ltp",
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
	btrfs: "linux-btrfs",
	"linux-btrfs": "linux-btrfs",
	nfs: "linux-nfs",
	"linux-nfs": "linux-nfs",
	nvme: "linux-nvme",
	"linux-nvme": "linux-nvme",
	rdma: "linux-rdma",
	"linux-rdma": "linux-rdma",
	media: "linux-media",
	"linux-media": "linux-media",
	kbuild: "linux-kbuild",
	"linux-kbuild": "linux-kbuild",
	kselftest: "linux-kselftest",
	"linux-kselftest": "linux-kselftest",
	acpi: "linux-acpi",
	"linux-acpi": "linux-acpi",
	input: "linux-input",
	"linux-input": "linux-input",
	iio: "linux-iio",
	"linux-iio": "linux-iio",
	hwmon: "linux-hwmon",
	"linux-hwmon": "linux-hwmon",
	xfs: "xfs",
	f2fs: "f2fs",
	dm: "dm-devel",
	"dm-devel": "dm-devel",
	s390: "linux-s390",
	"linux-s390": "linux-s390",
	dri: "dri-devel",
	"dri-devel": "dri-devel",
	drm: "dri-devel",
	intel: "intel-gfx",
	"intel-gfx": "intel-gfx",
	mptcp: "mptcp",
	rcu: "rcu",
	bluetooth: "bluetooth",
	selinux: "selinux",
	cifs: "cifs-client",
	"cifs-client": "cifs-client",
};

function resolveProjectName(raw?: string): string {
	if (!raw) return "all";
	const key = raw.trim().toLowerCase();
	if (PROJECT_ALIASES[key]) return PROJECT_ALIASES[key];
	if (key.startsWith("linux-")) {
		const unprefixed = key.slice(6);
		if (PROJECT_ALIASES[unprefixed]) return PROJECT_ALIASES[unprefixed];
	} else {
		const prefixed = `linux-${key}`;
		if (PROJECT_ALIASES[prefixed]) return PROJECT_ALIASES[prefixed];
	}
	return key;
}

/**
 * Format UTC date YYYY-MM-DDT00:00:00 for Patchwork since queries.
 */
function getYesterdayDateStr(): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - 1);
	const year = d.getUTCFullYear();
	const month = String(d.getUTCMonth() + 1).padStart(2, "0");
	const day = String(d.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}T00:00:00`;
}

interface PatchworkSubmitter {
	name?: string | null;
	email?: string | null;
}

interface PatchworkComment {
	id: number;
	date: string;
	submitter: PatchworkSubmitter;
	subject: string;
	content: string;
}

interface PatchworkPatchItem {
	id: number;
	name: string;
	web_url?: string;
	msgid?: string;
	date?: string;
	submitter?: PatchworkSubmitter;
	state?: string;
	content?: string;
	diff?: string;
	comments?: PatchworkComment[];
}

interface PatchworkCoverLetter {
	id: number;
	name: string;
	web_url?: string;
	msgid?: string;
	date?: string;
	submitter?: PatchworkSubmitter;
	content?: string;
	comments?: PatchworkComment[];
}

interface PatchworkSeriesData {
	id?: number;
	name: string;
	web_url?: string;
	version?: number;
	total?: number;
	cover_letter?: PatchworkCoverLetter | null;
	patches: PatchworkPatchItem[];
}

export interface PatchworkPatchListItem {
	index: number;
	id: number;
	title: string;
	authorName: string;
	authorEmail?: string;
	date: string;
	state: string;
	check?: string;
	webUrl: string;
	msgId?: string;
	project: {
		name: string;
		linkName: string;
	};
	series?: {
		id: number;
		name: string;
		version?: number;
	};
}

/**
 * Truncate large diffs so they don't consume the entire context window
 * while keeping enough information for the LLM to inspect the changes.
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
 * Clean up Patchwork message ID strings.
 */
function cleanMsgId(raw?: string): string {
	if (!raw) return "";
	return decodeURIComponent(raw)
		.trim()
		.replace(/^<|>$/g, "")
		.replace(/\/$/, "");
}

/**
 * Helper to fetch JSON from Patchwork REST API safely.
 */
async function fetchJsonSafe<T = any>(url: string): Promise<{ ok: boolean; status: number; data?: T }> {
	try {
		const res = await fetch(url, {
			headers: {
				Accept: "application/json",
				"User-Agent": "pi-coding-agent/patchwork-plugin",
			},
		});
		if (!res.ok) {
			return { ok: false, status: res.status };
		}
		const data = (await res.json()) as T;
		return { ok: true, status: res.status, data };
	} catch {
		return { ok: false, status: 0 };
	}
}

async function fetchJson<T = any>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: {
			Accept: "application/json",
			"User-Agent": "pi-coding-agent/patchwork-plugin",
		},
	});
	if (!res.ok) {
		throw new Error(`HTTP error ${res.status} (${res.statusText}) fetching ${url}`);
	}
	return (await res.json()) as T;
}

/**
 * Fetch and parse list of patches from Patchwork REST API.
 * Default behavior: retrieves patches from today and yesterday.
 * If limit is a number: retrieves up to that count.
 * If all is true or limit is 'all': retrieves all available patches (paginated up to 1000).
 */
async function fetchPatchworkPatchesList(options: {
	subsystem?: string;
	project?: string;
	query?: string;
	limit?: number | "all";
	all?: boolean;
	state?: string;
	baseUrl?: string;
}): Promise<{
	projectName: string;
	url: string;
	totalFound: number;
	items: PatchworkPatchListItem[];
	note?: string;
}> {
	const rawProject = options.subsystem || options.project || "all";
	const projectName = resolveProjectName(rawProject);
	const origin = options.baseUrl || "https://patchwork.kernel.org";
	const isAll = options.all === true || options.limit === "all" || (typeof options.limit === "number" && options.limit <= 0);
	const targetCount = isAll ? 1000 : (typeof options.limit === "number" ? options.limit : undefined);
	const userQuery = options.query?.trim();
	const userState = options.state?.trim();

	let isDefaultDateFilter = false;
	let yesterdayStr = "";
	let sinceParam: string | undefined;

	if (targetCount === undefined && !isAll) {
		// Default mode: today + yesterday
		isDefaultDateFilter = true;
		yesterdayStr = getYesterdayDateStr();
		sinceParam = yesterdayStr;
	}

	async function fetchBatches(since?: string, countLimit?: number): Promise<{ items: PatchworkPatchListItem[]; firstUrl: string }> {
		const resultItems: PatchworkPatchListItem[] = [];
		let page = 1;
		let firstUrl = "";
		const needed = countLimit ?? 1000;

		while (resultItems.length < needed) {
			const perPage = Math.min(needed - resultItems.length, 250);
			const params = new URLSearchParams();
			params.set("order", "-id");
			params.set("per_page", String(perPage));
			params.set("page", String(page));

			if (projectName !== "all") {
				params.set("project", projectName);
			}
			if (userQuery) {
				params.set("q", userQuery);
			}
			if (userState) {
				params.set("state", userState);
			}
			if (since) {
				params.set("since", since);
			}

			const pageUrl = `${origin}/api/1.3/patches/?${params.toString()}`;
			if (!firstUrl) {
				firstUrl = pageUrl;
			}

			const res = await fetchJsonSafe<any[]>(pageUrl);
			if (!res.ok || !res.data || res.data.length === 0) {
				break;
			}

			for (const p of res.data) {
				resultItems.push({
					index: resultItems.length + 1,
					id: p.id,
					title: p.name,
					authorName: p.submitter?.name || p.submitter?.email || "Unknown",
					authorEmail: p.submitter?.email || undefined,
					date: p.date,
					state: p.state || "unknown",
					check: typeof p.check === "string" ? p.check : undefined,
					webUrl: p.web_url || `${origin}/patch/${p.id}/`,
					msgId: cleanMsgId(p.msgid || ""),
					project: {
						name: p.project?.name || projectName,
						linkName: p.project?.link_name || projectName,
					},
					series:
						p.series && p.series.length > 0
							? {
									id: p.series[0].id,
									name: p.series[0].name,
									version: p.series[0].version,
							  }
							: undefined,
				});
			}

			if (res.data.length < perPage) {
				break;
			}

			page++;
		}

		return { items: resultItems, firstUrl };
	}

	let note: string | undefined;
	const { items: fetchedItems, firstUrl } = await fetchBatches(sinceParam, targetCount);
	let items = fetchedItems;

	// Fallback if default today+yesterday mode returned 0 items
	if (isDefaultDateFilter && items.length === 0) {
		note = `No patches found from today or yesterday (since ${yesterdayStr.slice(0, 10)}). Falling back to the 20 most recent submissions.`;
		const fallback = await fetchBatches(undefined, 20);
		items = fallback.items.slice(0, 20);
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
		projectName,
		url: firstUrl,
		totalFound: items.length,
		items,
		note,
	};
}

/**
 * Format patch list for model consumption.
 */
function serializePatchListForModel(data: {
	projectName: string;
	url: string;
	totalFound: number;
	items: PatchworkPatchListItem[];
	note?: string;
}): string {
	const parts: string[] = [];
	parts.push(`# Patchwork Patches List: ${data.projectName} (${data.totalFound} items found)`);
	parts.push(`API URL: ${data.url}\n`);

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
		parts.push(`- **Patch ID**: ${item.id}`);
		parts.push(`- **Project**: ${item.project.name} (\`${item.project.linkName}\`)`);
		parts.push(`- **Author**: ${author}`);
		parts.push(`- **Date**: ${item.date}`);
		parts.push(`- **State**: ${item.state}`);
		if (item.check) {
			parts.push(`- **Check / CI**: ${item.check}`);
		}
		if (item.series) {
			const verStr = item.series.version ? ` v${item.series.version}` : "";
			parts.push(`- **Series**: "${item.series.name}"${verStr} (Series ID: ${item.series.id})`);
		}
		if (item.msgId) {
			parts.push(`- **Message-ID**: \`${item.msgId}\``);
		}
		parts.push(`- **Patchwork URL**: ${item.webUrl}`);
		parts.push("");
	}

	parts.push("================================================================");
	parts.push("## Instructions for Assistant:");
	parts.push("- Present a clear, well-organized overview of these patches.");
	parts.push("- Group them logically or highlight notable series, bugfixes, and subsystems.");
	parts.push("- Let the user know they can inspect any patch or series in full depth (overview + diff + comments) by using `/patchwork read <url-or-id>` or calling the patchwork tool.");

	return parts.join("\n");
}

/**
 * Resolves any Patchwork URL, numeric ID, or Message-ID to full series/patch information.
 */
async function fetchFullPatchworkSeries(input: string): Promise<PatchworkSeriesData> {
	const raw = input.trim();
	let origin = "https://patchwork.kernel.org";
	let seriesId: number | null = null;
	let standalonePatch: any = null;

	if (raw.startsWith("http://") || raw.startsWith("https://")) {
		const parsed = new URL(raw);
		origin = parsed.origin;
		const pathname = parsed.pathname;

		// 1. /series/:id
		const seriesMatch = pathname.match(/\/series\/(\d+)/);
		if (seriesMatch) {
			seriesId = parseInt(seriesMatch[1], 10);
		}

		// 2. Query param ?series=:id
		if (!seriesId && parsed.searchParams.has("series")) {
			const sParam = parsed.searchParams.get("series");
			if (sParam && /^\d+$/.test(sParam)) {
				seriesId = parseInt(sParam, 10);
			}
		}

		// 3. Cover letter URL: /project/:project/cover/:id_or_msgid/ or /cover/:id/
		if (!seriesId) {
			const coverMatch =
				pathname.match(/\/project\/[^/]+\/cover\/([^/]+)/) ||
				pathname.match(/\/cover\/([^/]+)/);
			if (coverMatch) {
				const idOrMsg = cleanMsgId(coverMatch[1]);
				let coverObj: any = null;
				if (/^\d+$/.test(idOrMsg)) {
					const r = await fetchJsonSafe(`${origin}/api/1.3/covers/${idOrMsg}/`);
					if (r.ok) coverObj = r.data;
				} else {
					const r = await fetchJsonSafe<any[]>(`${origin}/api/1.3/covers/?msgid=${encodeURIComponent(idOrMsg)}`);
					if (r.ok && r.data && r.data.length > 0) coverObj = r.data[0];
				}

				if (coverObj && coverObj.series && coverObj.series.length > 0) {
					seriesId = coverObj.series[0].id;
				}
			}
		}

		// 4. Patch URL: /project/:project/patch/:id_or_msgid/ or /patch/:id/
		if (!seriesId) {
			const patchMatch =
				pathname.match(/\/project\/[^/]+\/patch\/([^/]+)/) ||
				pathname.match(/\/patch\/([^/]+)/);
			if (patchMatch) {
				const idOrMsg = cleanMsgId(patchMatch[1]);
				let patchObj: any = null;
				if (/^\d+$/.test(idOrMsg)) {
					const r = await fetchJsonSafe(`${origin}/api/1.3/patches/${idOrMsg}/`);
					if (r.ok) patchObj = r.data;
				} else {
					const r = await fetchJsonSafe<any[]>(`${origin}/api/1.3/patches/?msgid=${encodeURIComponent(idOrMsg)}`);
					if (r.ok && r.data && r.data.length > 0) patchObj = r.data[0];
				}

				if (patchObj) {
					if (patchObj.series && patchObj.series.length > 0) {
						seriesId = patchObj.series[0].id;
					} else {
						standalonePatch = patchObj;
					}
				}
			}
		}
	} else {
		// Non-URL input: pure numeric ID or Message-ID
		const cleaned = cleanMsgId(raw);
		if (/^\d+$/.test(cleaned)) {
			// Try as patch ID first
			const patchRes = await fetchJsonSafe<any>(`${origin}/api/1.3/patches/${cleaned}/`);
			if (patchRes.ok && patchRes.data) {
				if (patchRes.data.series && patchRes.data.series.length > 0) {
					seriesId = patchRes.data.series[0].id;
				} else {
					standalonePatch = patchRes.data;
				}
			} else {
				// Try as series ID
				const seriesRes = await fetchJsonSafe<any>(`${origin}/api/1.3/series/${cleaned}/`);
				if (seriesRes.ok && seriesRes.data) {
					seriesId = seriesRes.data.id;
				} else {
					// Try as cover ID
					const coverRes = await fetchJsonSafe<any>(`${origin}/api/1.3/covers/${cleaned}/`);
					if (coverRes.ok && coverRes.data?.series?.length > 0) {
						seriesId = coverRes.data.series[0].id;
					}
				}
			}
		} else {
			// Message-ID
			const patchRes = await fetchJsonSafe<any[]>(`${origin}/api/1.3/patches/?msgid=${encodeURIComponent(cleaned)}`);
			if (patchRes.ok && patchRes.data && patchRes.data.length > 0) {
				const patchObj = patchRes.data[0];
				if (patchObj.series && patchObj.series.length > 0) {
					seriesId = patchObj.series[0].id;
				} else {
					standalonePatch = patchObj;
				}
			} else {
				// Try cover
				const coverRes = await fetchJsonSafe<any[]>(`${origin}/api/1.3/covers/?msgid=${encodeURIComponent(cleaned)}`);
				if (coverRes.ok && coverRes.data && coverRes.data.length > 0) {
					const coverObj = coverRes.data[0];
					if (coverObj.series && coverObj.series.length > 0) {
						seriesId = coverObj.series[0].id;
					}
				}
			}
		}
	}

	// If series found, fetch the full series object
	if (seriesId) {
		const seriesObj = await fetchJson<any>(`${origin}/api/1.3/series/${seriesId}/`);
		let coverLetter: PatchworkCoverLetter | null = null;

		// Fetch cover letter if present
		if (seriesObj.cover_letter) {
			try {
				const cl = await fetchJson<any>(seriesObj.cover_letter.url);
				let clComments: PatchworkComment[] = [];
				if (cl.comments) {
					try {
						clComments = await fetchJson<PatchworkComment[]>(cl.comments);
					} catch {
						// ignore comments error
					}
				}
				coverLetter = {
					id: cl.id,
					name: cl.name,
					web_url: cl.web_url,
					msgid: cl.msgid,
					date: cl.date,
					submitter: cl.submitter,
					content: cl.content,
					comments: clComments,
				};
			} catch {
				// cover letter fetch error fallback
			}
		}

		// Fetch all patches in the series in parallel
		const patchesList: any[] = seriesObj.patches || [];
		const patches: PatchworkPatchItem[] = await Promise.all(
			patchesList.map(async (p) => {
				const patchDetail = await fetchJson<any>(p.url);
				let comments: PatchworkComment[] = [];
				if (patchDetail.comments) {
					try {
						comments = await fetchJson<PatchworkComment[]>(patchDetail.comments);
					} catch {
						// ignore comment fetch failure
					}
				}
				return {
					id: patchDetail.id,
					name: patchDetail.name,
					web_url: patchDetail.web_url,
					msgid: patchDetail.msgid,
					date: patchDetail.date,
					submitter: patchDetail.submitter,
					state: patchDetail.state,
					content: patchDetail.content,
					diff: patchDetail.diff,
					comments,
				};
			}),
		);

		return {
			id: seriesObj.id,
			name: seriesObj.name,
			web_url: seriesObj.web_url,
			version: seriesObj.version,
			total: seriesObj.total || patches.length,
			cover_letter: coverLetter,
			patches,
		};
	}

	// If it's a standalone patch
	if (standalonePatch) {
		let comments: PatchworkComment[] = [];
		if (standalonePatch.comments) {
			try {
				comments = await fetchJson<PatchworkComment[]>(standalonePatch.comments);
			} catch {
				// ignore
			}
		}
		const singlePatch: PatchworkPatchItem = {
			id: standalonePatch.id,
			name: standalonePatch.name,
			web_url: standalonePatch.web_url,
			msgid: standalonePatch.msgid,
			date: standalonePatch.date,
			submitter: standalonePatch.submitter,
			state: standalonePatch.state,
			content: standalonePatch.content,
			diff: standalonePatch.diff,
			comments,
		};
		return {
			name: standalonePatch.name,
			web_url: standalonePatch.web_url,
			total: 1,
			cover_letter: null,
			patches: [singlePatch],
		};
	}

	throw new Error(`Unable to find patch or series for input: ${input}`);
}

/**
 * Serializes series information into a comprehensive prompt for the model.
 */
function serializeSeriesForModel(series: PatchworkSeriesData): string {
	const isMultiPatch = series.patches.length > 1;
	const parts: string[] = [];

	parts.push(`# Patchwork Series Information`);
	parts.push(`Series Name: ${series.name}`);
	if (series.web_url) parts.push(`Series URL: ${series.web_url}`);
	parts.push(`Number of Patches: ${series.patches.length}`);
	if (series.version) parts.push(`Series Version: v${series.version}`);
	parts.push("");

	// Cover letter
	if (series.cover_letter) {
		parts.push(`## Cover Letter: ${series.cover_letter.name}`);
		if (series.cover_letter.submitter?.name) {
			parts.push(
				`Submitter: ${series.cover_letter.submitter.name} <${series.cover_letter.submitter.email ?? ""}>`,
			);
		}
		if (series.cover_letter.date) parts.push(`Date: ${series.cover_letter.date}`);
		parts.push("\n### Cover Letter Content:\n");
		parts.push(series.cover_letter.content?.trim() || "(No content)");
		parts.push("");

		if (series.cover_letter.comments && series.cover_letter.comments.length > 0) {
			parts.push(`### Comments on Cover Letter (${series.cover_letter.comments.length}):`);
			for (const c of series.cover_letter.comments) {
				const author = c.submitter?.name || c.submitter?.email || "Unknown";
				parts.push(`\n--- Comment by ${author} (${c.date}) ---`);
				parts.push(c.content.trim());
			}
			parts.push("");
		}
	}

	// Patches
	for (let i = 0; i < series.patches.length; i++) {
		const p = series.patches[i];
		const patchNum = i + 1;
		parts.push("\n================================================================");
		parts.push(`## Patch ${patchNum}/${series.patches.length}: ${p.name}`);
		parts.push(`Patch ID: ${p.id}`);
		if (p.web_url) parts.push(`URL: ${p.web_url}`);
		if (p.submitter?.name) {
			parts.push(`Author: ${p.submitter.name} <${p.submitter.email ?? ""}>`);
		}
		if (p.date) parts.push(`Date: ${p.date}`);
		if (p.state) parts.push(`State: ${p.state}`);

		parts.push("\n### Commit Message & Description:");
		parts.push(p.content?.trim() || "(No description)");

		if (p.diff) {
			parts.push("\n### Patch Diff:");
			parts.push("```diff");
			parts.push(formatDiff(p.diff));
			parts.push("```");
		}

		const comments = p.comments || [];
		parts.push(`\n### Review Comments (${comments.length}):`);
		if (comments.length === 0) {
			parts.push("(No review comments recorded)");
		} else {
			for (const c of comments) {
				const author = c.submitter?.name || c.submitter?.email || "Unknown";
				parts.push(`\n--- Comment by ${author} on ${c.date} ---`);
				parts.push(c.content.trim());
			}
		}
	}

	parts.push("\n================================================================");
	parts.push(`## Summarization Instructions for Assistant:`);
	parts.push(`Please generate a clear, well-structured markdown summary based on the fetched information:`);
	if (isMultiPatch) {
		parts.push(`1. Main Series Overview (at the beginning):`);
		parts.push(`   - Explain what this series as a whole aims to accomplish, the overarching problem, context, and changes.`);
		parts.push(`2. Individual Patch Sections (one section for each single patch in the series):`);
		parts.push(`   For each patch, provide:`);
		parts.push(`   - **Patch Overview**: High-level summary of what the patch changes and its scope.`);
		parts.push(`   - **Reason of the Patch**: Why this change is necessary (bug, missing feature, test failure, refactoring).`);
		parts.push(`   - **Overview of Comments**: Synthesis of reviewer feedback, discussion points, concerns raised, and review tags (Reviewed-by, Acked-by, etc.).`);
	} else {
		parts.push(`For this patch, provide:`);
		parts.push(`- **Patch Overview**: High-level summary of what the patch changes and its scope.`);
		parts.push(`- **Reason of the Patch**: Why this change is necessary (bug, missing feature, test failure, refactoring).`);
		parts.push(`- **Overview of Comments**: Synthesis of reviewer feedback, discussion points, concerns raised, and review tags (Reviewed-by, Acked-by, etc.).`);
	}

	return parts.join("\n");
}

/**
 * TypeBox Parameter Schemas.
 */
const PatchworkListParams = Type.Object({
	subsystem: Type.Optional(
		Type.String({
			description:
				"Subsystem or project name or shortcut (e.g., 'ltp', 'netdev', 'bpf', 'arm', 'riscv', 'kvm', 'fs', 'mm', 'io-uring', 'rust', or 'all'). Default is 'all'.",
		}),
	),
	project: Type.Optional(
		Type.String({
			description: "Alias for subsystem: Project link_name on patchwork.kernel.org.",
		}),
	),
	query: Type.Optional(
		Type.String({
			description: "Optional search query or keyword filter (e.g., 'sched', 'tcp', 'mlx5', author name, etc.).",
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
	state: Type.Optional(
		Type.String({
			description:
				"Optional patch state filter (e.g., 'new', 'under-review', 'accepted', 'superseded', 'rejected', 'rfc').",
		}),
	),
});

const PatchworkReadParams = Type.Object({
	target: Type.Optional(
		Type.String({
			description:
				"Patchwork URL, patch ID, or Message-ID (e.g., https://patchwork.kernel.org/project/ltp/patch/as9x2R-9IQb7vjn7@toolbx/, 14894280, or <...moxa.com>)",
		}),
	),
	url: Type.Optional(
		Type.String({
			description: "Patchwork URL (backwards-compatible alias for target).",
		}),
	),
});

export default function patchworkPlugin(pi: ExtensionAPI) {
	// 1. Tool to list patches
	pi.registerTool({
		name: "patchwork_list_patches",
		label: "Patchwork Patches List",
		description:
			"Fetch recent patches from Patchwork (patchwork.kernel.org). By default, fetches patches from today and yesterday (the most recent submissions). Specify a numeric limit (e.g. 20, 50, 100), or set all=true (or limit='all') to retrieve all patches. Can be filtered by subsystem/project, search query, or state.",
		parameters: PatchworkListParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const result = await fetchPatchworkPatchesList({
					subsystem: params.subsystem,
					project: params.project,
					query: params.query,
					limit: params.limit,
					all: params.all,
					state: params.state,
				});

				const formattedText = serializePatchListForModel(result);

				return {
					content: [{ type: "text", text: formattedText }],
					details: {
						project: result.projectName,
						query: params.query || null,
						state: params.state || null,
						count: result.totalFound,
						note: result.note || null,
						firstTitles: result.items.slice(0, 5).map((it) => `${it.title} (${it.authorName})`),
					},
				};
			} catch (err: any) {
				throw new Error(`Failed to list patches from Patchwork: ${err.message}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("patchwork list "));
			text += theme.fg("accent", args.subsystem || args.project || "all");
			if (args.query) {
				text += " " + theme.fg("muted", `"${args.query}"`);
			}
			if (args.state) {
				text += " " + theme.fg("dim", `[state: ${args.state}]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						project?: string;
						query?: string | null;
						state?: string | null;
						count?: number;
						firstTitles?: string[];
				  }
				| undefined;

			if (!details) {
				return new Text(theme.fg("success", "Patchwork patches list fetched"), 0, 0);
			}

			let summary = theme.fg("success", `✓ Found ${details.count} patch(es) in Patchwork (${details.project})`);
			if (details.query) {
				summary += theme.fg("muted", ` (matching "${details.query}")`);
			}
			if (details.state) {
				summary += theme.fg("dim", ` [state: ${details.state}]`);
			}

			if (expanded && details.firstTitles && details.firstTitles.length > 0) {
				summary += "\n" + theme.fg("dim", details.firstTitles.map((t, i) => `  ${i + 1}. ${t}`).join("\n"));
			}

			return new Text(summary, 0, 0);
		},
	});

	// Shared handler for reading patches/series
	async function handleReadPatch(params: { target?: string; url?: string }) {
		const input = params.target || params.url;
		if (!input) {
			throw new Error("Either 'target' or 'url' parameter must be provided.");
		}
		const seriesData = await fetchFullPatchworkSeries(input);
		const formattedText = serializeSeriesForModel(seriesData);

		return {
			content: [{ type: "text", text: formattedText }],
			details: {
				seriesName: seriesData.name,
				patchCount: seriesData.patches.length,
				hasCoverLetter: !!seriesData.cover_letter,
				totalComments:
					(seriesData.cover_letter?.comments?.length || 0) +
					seriesData.patches.reduce((acc, p) => acc + (p.comments?.length || 0), 0),
			},
		};
	}

	function renderReadCall(args: { target?: string; url?: string }, theme: any) {
		let text = theme.fg("toolTitle", theme.bold("patchwork read "));
		text += theme.fg("accent", args.target || args.url || "");
		return new Text(text, 0, 0);
	}

	function renderReadResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
		const details = result.details as
			| {
					seriesName?: string;
					patchCount?: number;
					totalComments?: number;
			  }
			| undefined;

		if (!details) {
			return new Text(theme.fg("success", "Patchwork patch/series fetched"), 0, 0);
		}

		let summary = theme.fg("success", `✓ Fetched "${details.seriesName}"`);
		summary += theme.fg("muted", ` (${details.patchCount} patch(es), ${details.totalComments} comment(s))`);

		if (expanded && result.content[0]?.type === "text") {
			const preview = result.content[0].text.split("\n").slice(0, 15).join("\n");
			summary += `\n${theme.fg("dim", preview)}\n${theme.fg("muted", "...")}`;
		}

		return new Text(summary, 0, 0);
	}

	// 2. Tool to read deep patch/series overview, diff, and comments (new lore-style name)
	pi.registerTool({
		name: "patchwork_read_patch",
		label: "Patchwork Read Patch/Series",
		description:
			"Fetch and analyze a full patch series or patch from Patchwork via URL, numeric ID, or Message-ID. Resolves single patches to their complete series, fetching the cover letter, all patches, diffs, commit messages, and review comments.",
		parameters: PatchworkReadParams,
		async execute(_toolCallId, params) {
			try {
				return await handleReadPatch(params);
			} catch (err: any) {
				throw new Error(`Failed to read Patchwork patch/series: ${err.message}`);
			}
		},
		renderCall: renderReadCall,
		renderResult: renderReadResult,
	});

	// 3. Tool to fetch series (backward-compatible)
	pi.registerTool({
		name: "patchwork_fetch_series",
		label: "Patchwork Series",
		description:
			"Fetch and analyze a full patch series from Patchwork via REST API (e.g., patchwork.kernel.org). Resolves single patches to their complete series, fetching the cover letter, all patches, diffs, commit messages, and review comments.",
		parameters: PatchworkReadParams,
		async execute(_toolCallId, params) {
			try {
				return await handleReadPatch(params);
			} catch (err: any) {
				throw new Error(`Failed to fetch Patchwork series: ${err.message}`);
			}
		},
		renderCall: renderReadCall,
		renderResult: renderReadResult,
	});

	// Helper to parse arguments for list command
	function parseListTokens(tokens: string[]): { subsystem: string; limit?: number | "all"; query: string } {
		if (tokens.length === 0) return { subsystem: "all", query: "" };

		let subsystem = "all";
		let limit: number | "all" | undefined;
		let queryStartIndex = 0;

		const first = tokens[0].toLowerCase();
		if (first === "all" && tokens.length > 1 && (/^\d+$/.test(tokens[1]) || tokens[1].toLowerCase() === "all")) {
			subsystem = "all";
			if (tokens[1].toLowerCase() === "all") {
				limit = "all";
			} else {
				limit = parseInt(tokens[1], 10);
			}
			queryStartIndex = 2;
		} else if (/^\d+$/.test(first)) {
			subsystem = "all";
			limit = parseInt(first, 10);
			queryStartIndex = 1;
		} else {
			subsystem = tokens[0];
			queryStartIndex = 1;

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
		}

		const query = tokens.slice(queryStartIndex).join(" ").trim();
		return { subsystem, limit, query };
	}

	function buildListPrompt(parsed: { subsystem: string; limit?: number | "all"; query: string }): string {
		const { subsystem, limit, query } = parsed;
		let msg = "";
		if (limit === "all") {
			msg = `Please list all patches from Patchwork for subsystem/project "${subsystem}"`;
			if (query) msg += ` matching query "${query}"`;
			msg += ` using the patchwork_list_patches tool with all=true.`;
		} else if (typeof limit === "number") {
			msg = `Please list ${limit} patches from Patchwork for subsystem/project "${subsystem}"`;
			if (query) msg += ` matching query "${query}"`;
			msg += ` using the patchwork_list_patches tool with limit=${limit}.`;
		} else {
			msg = `Please list recent patches (from today and yesterday) from Patchwork for subsystem/project "${subsystem}"`;
			if (query) msg += ` matching query "${query}"`;
			msg += ` using the patchwork_list_patches tool.`;
		}
		return msg;
	}

	// 4. Register the /patchwork slash command
	pi.registerCommand("patchwork", {
		description: "Browse and read Linux kernel patches from Patchwork: /patchwork [list|read] [args]",
		handler: async (args, ctx) => {
			const raw = args.trim();

			if (!raw || raw === "help") {
				ctx.ui.notify(
					"Patchwork Plugin Usage:\n\n" +
						"  /patchwork list [subsystem] [count|all] [query]  - List patches (default: today+yesterday)\n" +
						"  /patchwork read <url-or-id-or-msgid>             - Deep dive: overview + patch + comments\n" +
						"  /patchwork <url-or-id-or-msgid>                  - Read & summarize (auto-detected)\n" +
						"  /patchwork <subsystem> [count|all] [query]       - List patches from subsystem/project\n\n" +
						"Popular subsystems: ltp, netdev, bpf, arm, riscv, kvm, fs, mm, io-uring, rust, usb, all\n\n" +
						"Examples:\n" +
						"  /patchwork list ltp             - Recent patches from today and yesterday\n" +
						"  /patchwork list ltp 30          - Last 30 patches from LTP\n" +
						"  /patchwork list ltp all         - All available patches from LTP\n" +
						"  /patchwork list netdev 50 tcp   - 50 recent TCP patches on netdev\n" +
						"  /patchwork read 14894280        - Read patch ID 14894280\n" +
						"  /patchwork read https://patchwork.kernel.org/project/ltp/patch/as9x2R-9IQb7vjn7@toolbx/",
					"info",
				);
				return;
			}

			// Subcommand: read / fetch
			if (raw.startsWith("read ") || raw.startsWith("fetch ")) {
				const target = raw.replace(/^(?:read|fetch)\s+/, "").trim();
				await pi.sendUserMessage(
					`Please read and summarize the patch/series "${target}" from Patchwork using the patchwork_read_patch tool.\n\n` +
						`Make sure the response follows this structure:\n` +
						`- If there are multiple patches in the series: provide an overview of the main series at the beginning, followed by sections for each individual patch.\n` +
						`- For each patch, provide:\n` +
						`  1. Patch overview\n` +
						`  2. Reason of the patch\n` +
						`  3. Overview of comments for the patch`,
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

			// Auto-detection: URL, Message-ID, or numeric ID
			if (raw.startsWith("http://") || raw.startsWith("https://") || raw.includes("@") || /^\d+$/.test(raw)) {
				await pi.sendUserMessage(
					`Please read and summarize the patch/series "${raw}" from Patchwork using the patchwork_read_patch tool.\n\n` +
						`Make sure the response follows this structure:\n` +
						`- If there are multiple patches in the series: provide an overview of the main series at the beginning, followed by sections for each individual patch.\n` +
						`- For each patch, provide:\n` +
						`  1. Patch overview\n` +
						`  2. Reason of the patch\n` +
						`  3. Overview of comments for the patch`,
				);
				return;
			}

			// Default: treat as subsystem name + optional limit/all + query (e.g. "/patchwork netdev" or "/patchwork ltp 20")
			const tokens = raw.split(/\s+/);
			const parsed = parseListTokens(tokens);
			await pi.sendUserMessage(buildListPrompt(parsed));
		},
	});
}
