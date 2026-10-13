// Repair legacy lines containing only adjacent bold headings, preserving prose.
export function formatReasoningSummary(text: string): string {
  return text.replace(/^(?:\*\*[^*\r\n]+\*\*){2,}$/gm, line =>
    line.replace(/\*\*(?=\*\*)/g, "**\n\n"));
}
