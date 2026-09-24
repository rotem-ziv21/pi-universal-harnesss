/**
 * The user's request, split into the things it asks for. Deterministic, no model.
 *
 * Jev judges best when a broad question ("is the task done?") is decomposed into
 * one question per item and the code counts. The items come from the request's
 * own structure: numbered lines, bullets, or sentences. A language model would
 * paraphrase; this keeps the user's words, so the item Jev is asked about is the
 * item the user wrote.
 *
 * Only the latest prompt is split: earlier prompts are context for the action
 * gate, but the completion being judged is the most recent request.
 */

const MAX_ITEMS = 16;
const MAX_ITEM_CHARS = 400;
const MIN_ITEM_CHARS = 12;

const MARKER = /^\s*(?:(\d{1,2})[.)]|[-*•]|\[[ x]\])\s+(.*)$/;
const HEADER = /^[^.!?]{0,60}:\s*$/;

export function splitRequestItems(request: string): string[] {
	const text = request.replace(/\r\n/g, "\n").trim();
	if (!text) return [];

	const lines = text.split("\n");
	const markers = lines.filter((line) => MARKER.test(line)).length;
	const items = markers >= 2 ? fromList(lines) : fromSentences(text);

	const cleaned = items.map(tidy).filter((item) => item.length >= MIN_ITEM_CHARS);
	if (cleaned.length === 0) return [tidy(text)].filter((item) => item.length > 0);
	return cleaned.slice(0, MAX_ITEMS);
}

/** Numbered or bulleted lines are items; indented continuation lines join the item above. */
function fromList(lines: string[]): string[] {
	const items: string[] = [];
	let preamble: string[] = [];
	let current: string[] | undefined;
	let sawList = false;

	for (const raw of lines) {
		const line = raw.trimEnd();
		const match = MARKER.exec(line);
		if (match) {
			const indent = raw.length - raw.trimStart().length;
			// A nested bullet elaborates the item above it rather than starting a new one.
			if (current && indent >= 2 && !match[1]) {
				current.push(match[2] ?? "");
				continue;
			}
			if (current) items.push(current.join(" "));
			current = [match[2] ?? ""];
			sawList = true;
			continue;
		}
		if (line.trim() === "") {
			if (current) {
				items.push(current.join(" "));
				current = undefined;
			}
			continue;
		}
		if (current) {
			current.push(line.trim());
			continue;
		}
		if (!sawList) preamble.push(line.trim());
		else if (!HEADER.test(line)) {
			// A paragraph after the list ("Constraints: ...") is a requirement too.
			items.push(line.trim());
		}
	}
	if (current) items.push(current.join(" "));

	// The sentence before the list often carries the main ask ("Build a CLI called x").
	const lead = preamble.filter((line) => !HEADER.test(line)).join(" ");
	const leadSentence = fromSentences(lead)[0];
	return leadSentence ? [leadSentence, ...items] : items;
}

function fromSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+(?=[A-Z`"'(])|\n+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0 && !HEADER.test(part));
}

function tidy(item: string): string {
	const collapsed = item.replace(/\s+/g, " ").trim();
	return collapsed.length > MAX_ITEM_CHARS ? `${collapsed.slice(0, MAX_ITEM_CHARS - 1)}…` : collapsed;
}
