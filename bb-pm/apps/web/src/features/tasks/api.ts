import { apiClient } from "@/lib/apiClient";
import type { TaskCreateInput, TaskStatus } from "@bb-pm/shared";

export type TaskListItem = {
  id: number;
  name: string;
  status: TaskStatus;
  priority: string;
  deadline: string | null;
  description: string | null;
  totalCost: string;
  totalHours: number;
  assignee: { id: number; fullName: string; avatarUrl: string | null } | null;
  milestone: { id: number; name: string } | null;
  project: { id: number; name: string; code: string | null };
  tags: { id: number; name: string; color: number | null }[];
  _count: { backlogs: number };
};

export type TaskListParams = {
  projectId?: number;
  status?: TaskStatus;
  assigneeId?: number;
  milestoneId?: number;
  tagId?: number;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
};

export async function listTasks(params: TaskListParams = {}) {
  const { data } = await apiClient.get<{
    data: TaskListItem[];
    meta: { total: number; page: number; pageSize: number };
  }>("/tasks", { params });
  return data;
}

export async function getTask(id: number) {
  const { data } = await apiClient.get<{ data: any }>(`/tasks/${id}`);
  return data.data;
}

export async function createTask(projectId: number, input: TaskCreateInput) {
  const { data } = await apiClient.post<{ data: any }>(`/tasks/by-project/${projectId}`, input);
  return data.data;
}

export async function updateTask(id: number, input: Partial<TaskCreateInput>) {
  const { data } = await apiClient.patch<{ data: any }>(`/tasks/${id}`, input);
  return data.data;
}

export async function deleteTask(id: number) {
  await apiClient.delete(`/tasks/${id}`);
}

export async function transitionTask(id: number, status: TaskStatus) {
  const { data } = await apiClient.post<{ data: any }>(`/tasks/${id}/transition`, { status });
  return data.data;
}
