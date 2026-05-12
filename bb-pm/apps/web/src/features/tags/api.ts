import { apiClient } from "@/lib/apiClient";
import type { TagCreateInput } from "@bb-pm/shared";

export type Tag = {
  id: number;
  name: string;
  color: number | null;
  _count?: { projects: number; tasks: number };
};

export async function listTags() {
  const { data } = await apiClient.get<{ data: Tag[] }>("/tags");
  return data.data;
}

export async function createTag(input: TagCreateInput) {
  const { data } = await apiClient.post<{ data: Tag }>("/tags", input);
  return data.data;
}

export async function updateTag(id: number, input: Partial<TagCreateInput>) {
  const { data } = await apiClient.patch<{ data: Tag }>(`/tags/${id}`, input);
  return data.data;
}

export async function deleteTag(id: number) {
  await apiClient.delete(`/tags/${id}`);
}
