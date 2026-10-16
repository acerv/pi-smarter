import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

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

const PatchworkParams = Type.Object({
	url: Type.String({
		description:
			"The Patchwork URL of a patch, series, or cover letter (e.g., https://patchwork.kernel.org/project/ltp/patch/as9x2R-9IQb7vjn7@toolbx/)",
	}),
});

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
function cleanMsgId(raw: string): string {
	return decodeURIComponent(raw)
		.trim()
		.replace(/^<|>$/g, "")
		.replace(/\/$/, "");
}

/**
 * Helper to fetch JSON from Patchwork REST API.
 */
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
 * Resolves any Patchwork URL to full series information.
 */
async function fetchFullPatchworkSeries(inputUrl: string): Promise<PatchworkSeriesData> {
	const parsed = new URL(inputUrl.trim());
	const origin = parsed.origin;
	const pathname = parsed.pathname;

	let seriesId: number | null = null;
	let standalonePatch: any = null;

	// Check if URL directly points to a series
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
				coverObj = await fetchJson(`${origin}/api/1.3/covers/${idOrMsg}/`);
			} else {
				const list = await fetchJson<any[]>(`${origin}/api/1.3/covers/?msgid=${encodeURIComponent(idOrMsg)}`);
				if (list && list.length > 0) coverObj = list[0];
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
				patchObj = await fetchJson(`${origin}/api/1.3/patches/${idOrMsg}/`);
			} else {
				const list = await fetchJson<any[]>(`${origin}/api/1.3/patches/?msgid=${encodeURIComponent(idOrMsg)}`);
				if (list && list.length > 0) {
					patchObj = list[0];
				}
			}

			if (patchObj) {
				if (patchObj.series && patchObj.series.length > 0) {
					seriesId = patchObj.series[0].id;
				} else {
					// Standalone patch without a registered series object
					standalonePatch = patchObj;
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

	throw new Error(`Unable to find patch or series for URL: ${inputUrl}`);
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
		parts.push(`\n================================================================`);
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

export default function patchworkPlugin(pi: ExtensionAPI) {
	// Register the tool
	pi.registerTool({
		name: "patchwork_fetch_series",
		label: "Patchwork Series",
		description:
			"Fetch and analyze a full patch series from Patchwork via REST API (e.g., patchwork.kernel.org). Resolves single patches to their complete series, fetching the cover letter, all patches, diffs, commit messages, and review comments.",
		parameters: PatchworkParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				const seriesData = await fetchFullPatchworkSeries(params.url);
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
			} catch (err: any) {
				throw new Error(`Failed to fetch Patchwork series from ${params.url}: ${err.message}`);
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("patchwork "));
			text += theme.fg("accent", args.url);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| {
						seriesName?: string;
						patchCount?: number;
						totalComments?: number;
				  }
				| undefined;

			if (!details) {
				return new Text(theme.fg("success", "Patchwork series fetched"), 0, 0);
			}

			let summary = theme.fg("success", `✓ Fetched "${details.seriesName}"`);
			summary += theme.fg("muted", ` (${details.patchCount} patch(es), ${details.totalComments} comment(s))`);

			if (expanded && result.content[0]?.type === "text") {
				const preview = result.content[0].text.split("\n").slice(0, 15).join("\n");
				summary += `\n${theme.fg("dim", preview)}\n${theme.fg("muted", "...")}`;
			}

			return new Text(summary, 0, 0);
		},
	});

	// Register the /patchwork slash command
	pi.registerCommand("patchwork", {
		description: "Fetch and summarize a Patchwork series or patch: /patchwork <url>",
		handler: async (args, ctx) => {
			const url = args.trim();
			if (!url) {
				ctx.ui.notify(
					"Usage: /patchwork <patchwork-url>\nExample: /patchwork https://patchwork.kernel.org/project/ltp/patch/as9x2R-9IQb7vjn7@toolbx/",
					"warning",
				);
				return;
			}

			await pi.sendUserMessage(
				`Please fetch and summarize the Patchwork series at ${url} using the patchwork_fetch_series tool.\n\n` +
					`Make sure the response follows this structure:\n` +
					`- If there are multiple patches in the series: provide an overview of the main series at the beginning, followed by sections for each individual patch.\n` +
					`- For each patch, provide:\n` +
					`  1. Patch overview\n` +
					`  2. Reason of the patch\n` +
					`  3. Overview of comments for the patch`,
			);
		},
	});
}
