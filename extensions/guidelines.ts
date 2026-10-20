import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUIDELINES_PATH = path.resolve(__dirname, "../rules/guidelines.md");

function loadGuidelines(): string | null {
	try {
		if (fs.existsSync(GUIDELINES_PATH)) {
			return fs.readFileSync(GUIDELINES_PATH, "utf-8").trim();
		}
	} catch {
		// Ignore read errors
	}
	return null;
}

export default function activate(pi: ExtensionAPI): void {
	const content = loadGuidelines();
	if (!content) {
		return;
	}

	pi.on("before_agent_start", (event) => {
		const exists = event.systemPromptOptions.contextFiles?.some(
			(file) => file.path === GUIDELINES_PATH,
		);

		if (!exists) {
			event.systemPromptOptions.contextFiles = [
				...(event.systemPromptOptions.contextFiles ?? []),
				{
					path: GUIDELINES_PATH,
					content,
				},
			];
		}
	});
}
