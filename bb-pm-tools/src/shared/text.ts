/** Shared text helpers for Vietnamese chat matching. */
export function normalizeVietnameseText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

export function normalizeLooseText(text: string): string {
  return normalizeVietnameseText(text)
    .replace(/[?!.,;:()"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
