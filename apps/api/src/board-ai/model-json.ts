/**
 * The first JSON object of a model's answer: a fenced ```json block or the
 * text from the first `{` to the last `}`. Null when there is none or it does
 * not parse — the caller treats that as an answer out of contract.
 */
export const modelJson = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
};
