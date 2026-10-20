import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Toggle token-saving (terse output) mode via `/save_tokens`.
//   /save_tokens         -> toggle on/off
//   /save_tokens on|off  -> force a state
//   /save_tokens status  -> show current state

const TERSE_INSTRUCTIONS = [
	"TOKEN-SAVING MODE IS ON. Optimize hard for fewer output tokens:",
	"- Answer in the fewest words that fully resolve the request.",
	"- No preamble, no recap, no restating the question, no pleasantries.",
	"- Prefer a single sentence or terse bullets over paragraphs.",
	"- Show only the code/diff that changed; skip unchanged context.",
	"- Omit explanations unless explicitly asked.",
].join("\n");

export default function activate(pi: ExtensionAPI): void {
	let terse = false;

	pi.on("before_agent_start", async (event) => {
		if (!terse) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${TERSE_INSTRUCTIONS}` };
	});

	pi.registerCommand("save_tokens", {
		description: "Toggle token-saving (terse output) mode. Args: on|off|status",
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();

			if (arg === "status") {
				ctx.ui.notify(terse ? "save_tokens: ON" : "save_tokens: off", "info");
				return;
			}

			if (arg === "on") terse = true;
			else if (arg === "off") terse = false;
			else terse = !terse;

			ctx.ui.setStatus("save_tokens", terse ? "💸 save_tokens" : "");
			ctx.ui.notify(
				terse ? "Token-saving mode ON — responses will be terse." : "Token-saving mode OFF.",
				"info",
			);
		},
	});
}
