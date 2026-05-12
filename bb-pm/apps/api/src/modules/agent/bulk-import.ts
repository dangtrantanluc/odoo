/**
 * Bulk import Gapo Work members into bb-pm.
 *
 * Maps each Gapo profile (department + position) to a bb-pm role using a
 * deterministic ruleset. Idempotent: re-running upserts by email +
 * (channel, external_id).
 */

type GapoMember = {
  name: string;
  workspace: string;
  department: string;
  position: string;
  conversationId: string;
};

export type BbPmRole = "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";

/**
 * Map a Gapo profile (department + position) to a bb-pm role.
 *
 * Rules in priority order:
 *   1. Position contains "CEO" / "CCO" / "CTO" / "CFO" → ADMIN
 *   2. Position contains "Manager" / "Lead" / "Director" / "Head" → MANAGER
 *   3. Department in {AI, Software, BA, UI/UX, Testing, Content-Media, Engineering, Dev}
 *      AND position not VIEWER-ish → MEMBER
 *   4. Department in {HR, Sales, Partnership, Marketing, Finance} → VIEWER
 *   5. Default → MEMBER
 */
export function mapGapoToRole(member: GapoMember): BbPmRole {
  const pos = (member.position || "").toLowerCase();
  const dept = (member.department || "").toLowerCase();

  // C-suite first
  if (/\b(ceo|cto|cfo|cco|coo|founder|co.?founder)\b/i.test(member.position)) {
    return "ADMIN";
  }
  // BOD = Board of Directors → ADMIN-tier
  if (dept === "bod" || dept.includes("bod")) {
    return "ADMIN";
  }

  // Manager / Lead / Director / Head
  if (/\b(manager|lead|leader|director|head|trưởng)\b/i.test(member.position)) {
    return "MANAGER";
  }

  // Engineering / build roles → MEMBER
  const buildDepts = ["ai", "software", "ba", "ui/ux", "testing", "content-media", "engineering", "dev", "design"];
  if (buildDepts.some(d => dept.includes(d))) {
    return "MEMBER";
  }

  // Support / non-build → VIEWER
  const viewerDepts = ["hr", "sales", "partnership", "marketing", "finance", "admin"];
  if (viewerDepts.some(d => dept.includes(d))) {
    return "VIEWER";
  }

  return "MEMBER";
}

/**
 * Synthesize an internal email when Gapo doesn't expose user emails.
 * We'll use the conversation id as a unique fallback.
 */
export function synthEmail(member: GapoMember): string {
  const slug = member.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
  return `${slug || "user"}.${member.conversationId}@gapo.local`;
}

/**
 * Don't downgrade roles. Only upgrade if the new role is "higher" than the
 * existing one. Used by bulk-import to avoid clobbering an admin who was
 * manually promoted to ADMIN but their Gapo title still says "Junior BA".
 */
const ROLE_RANK: Record<string, number> = { VIEWER: 0, MEMBER: 1, MANAGER: 2, ADMIN: 3 };
export function shouldUpgradeRole(current: string, proposed: string): boolean {
  return (ROLE_RANK[proposed] ?? 0) > (ROLE_RANK[current] ?? 0);
}

export interface BulkImportResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ name: string; error: string }>;
  details: Array<{
    name: string;
    role: BbPmRole;
    department: string;
    position: string;
    bbPmUserId: number;
    action: "created" | "updated" | "skipped";
  }>;
}
