/** `Queued C-12 in To Do` → `{ label: 'C-12', number: 12 }`. */
export function cardLabelOf(
  summary: string,
): { label: string; number: number } | null {
  const match = /\bC-(\d+)\b/.exec(summary);
  if (!match) return null;
  return { label: `C-${match[1]}`, number: Number(match[1]) };
}
