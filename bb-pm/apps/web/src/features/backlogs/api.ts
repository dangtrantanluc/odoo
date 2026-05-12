import { apiClient } from "@/lib/apiClient";
import type { BacklogCreateInput, BacklogStatus } from "@bb-pm/shared";

export type Backlog = {
  id: number;
  status: BacklogStatus;
  workDate: string;
  hours: string;
  description: string | null;
  costPerHourSnapshot: string | null;
  totalCostSnapshot: string | null;
  rejectedReason: string | null;
  approvedAt: string | null;
  task: { id: number; name: string };
  project: { id: number; name: string; code: string | null } | null;
  user: { id: number; fullName: string; avatarUrl: string | null };
  approver: { id: number; fullName: string } | null;
  currency: { id: number; code: string; symbol: string } | null;
};

export type BacklogListParams = {
  status?: BacklogStatus;
  userId?: number;
  mine?: boolean;
  projectId?: number;
  taskId?: number;
  workDateFrom?: string;
  workDateTo?: string;
  page?: number;
  pageSize?: number;
};

export async function listBacklogs(params: BacklogListParams = {}) {
  const { data } = await apiClient.get<{
    data: Backlog[];
    meta: { page: number; pageSize: number; total: number };
  }>("/backlogs", { params });
  return data;
}

export async function createBacklog(taskId: number, input: BacklogCreateInput) {
  const { data } = await apiClient.post<{ data: Backlog }>(`/backlogs/by-task/${taskId}`, input);
  return data.data;
}

export async function updateBacklog(id: number, input: Partial<BacklogCreateInput>) {
  const { data } = await apiClient.patch<{ data: Backlog }>(`/backlogs/${id}`, input);
  return data.data;
}

export async function deleteBacklog(id: number) {
  await apiClient.delete(`/backlogs/${id}`);
}

export async function approveBacklog(id: number) {
  const { data } = await apiClient.post<{ data: Backlog }>(`/backlogs/${id}/approve`);
  return data.data;
}

export async function rejectBacklog(id: number, reason: string) {
  const { data } = await apiClient.post<{ data: Backlog }>(`/backlogs/${id}/reject`, { reason });
  return data.data;
}

export async function resetBacklog(id: number) {
  const { data } = await apiClient.post<{ data: Backlog }>(`/backlogs/${id}/reset`);
  return data.data;
}
