import type { ProjectStatus, TaskStatus, BacklogStatus, Role } from "@prisma/client";

const PROJECT: Record<ProjectStatus, ProjectStatus[]> = {
  PLANNED:     ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD:     ["IN_PROGRESS", "CANCELLED"],
  COMPLETED:   ["IN_PROGRESS"],   // admin-only reopen
  CANCELLED:   ["IN_PROGRESS"],
};

const TASK: Record<TaskStatus, TaskStatus[]> = {
  TODO:        ["IN_PROGRESS"],
  IN_PROGRESS: ["TODO", "REVIEW", "DONE"],
  REVIEW:      ["IN_PROGRESS", "DONE"],
  DONE:        ["IN_PROGRESS", "REVIEW"],
};

const BACKLOG: Record<BacklogStatus, BacklogStatus[]> = {
  PENDING:  ["APPROVED", "REJECTED"],
  APPROVED: ["PENDING"],
  REJECTED: ["PENDING"],
};

export function isProjectTransitionAllowed(from: ProjectStatus, to: ProjectStatus, role: Role, isSuperAdmin: boolean) {
  if (from === to) return false;
  if (!PROJECT[from].includes(to)) return false;
  // reopen từ COMPLETED/CANCELLED → chỉ ADMIN
  if ((from === "COMPLETED" || from === "CANCELLED") && !isSuperAdmin && role !== "ADMIN") return false;
  return true;
}

export function isTaskTransitionAllowed(from: TaskStatus, to: TaskStatus) {
  return from !== to && TASK[from].includes(to);
}

export function isBacklogTransitionAllowed(from: BacklogStatus, to: BacklogStatus) {
  return from !== to && BACKLOG[from].includes(to);
}
