// Sprint 8 Day 2 — minimal Mustache-style template renderer cho bulk tools.
// Tránh dependency mới — regex replace `{{var}}`.
//
// Vd: render("Chào {{name}}, task {{taskName}} hạn {{deadline}}", {
//   name: "Lực", taskName: "WS-3", deadline: "2026-05-10"
// })
// → "Chào Lực, task WS-3 hạn 2026-05-10"

const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

export function renderTemplate(
  template: string,
  params: Record<string, unknown> = {},
): string {
  if (!template) return "";
  return template.replace(VAR_RE, (_match, key: string) => {
    const v = params[key];
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  });
}

/** List vars referenced trong template (không dedup). Dùng để validate. */
export function extractVars(template: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(VAR_RE.source, "g");
  while ((m = re.exec(template)) !== null) out.push(m[1]);
  return out;
}
