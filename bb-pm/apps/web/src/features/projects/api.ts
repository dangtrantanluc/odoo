import { apiClient } from "@/lib/apiClient";
import type { ProjectCreateInput, ProjectUpdateInput, ProjectStatus } from "@bb-pm/shared";

export type ProjectListItem = {
  id: number;
  name: string;
  code: string | null;
  status: ProjectStatus;
  priority: string;
  startDate: string | null;
  endDate: string | null;
  totalCost: string;
  totalHours: number;
  budget: string | null;
  budgetRemaining: string | null;
  taskCount: number;
  memberCount: number;
  owner: { id: number; fullName: string; avatarUrl: string | null };
  customer: { id: number; name: string } | null;
  currency: { id: number; code: string; symbol: string } | null;
  tags: { id: number; name: string; color: number | null }[];
};

export type ProjectListParams = {
  status?: ProjectStatus;
  customerId?: number;
  tagId?: number;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: string;
};

export async function listProjects(params: ProjectListParams = {}) {
  const { data } = await apiClient.get<{
    data: ProjectListItem[];
    meta: { page: number; pageSize: number; total: number };
  }>("/projects", { params });
  return data;
}

export async function getProject(id: number) {
  const { data } = await apiClient.get<{ data: any }>(`/projects/${id}`);
  return data.data;
}

export async function createProject(input: ProjectCreateInput) {
  const { data } = await apiClient.post<{ data: any }>("/projects", input);
  return data.data;
}

export async function updateProject(id: number, input: ProjectUpdateInput) {
  const { data } = await apiClient.patch<{ data: any }>(`/projects/${id}`, input);
  return data.data;
}

export async function deleteProject(id: number) {
  await apiClient.delete(`/projects/${id}`);
}

export async function transitionProject(id: number, status: ProjectStatus) {
  const { data } = await apiClient.post<{ data: any }>(`/projects/${id}/transition`, { status });
  return data.data;
}
