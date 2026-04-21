import { apiClient } from "@/lib/apiClient";
import type { MemberCreateInput, MemberRateCreateInput } from "@bb-pm/shared";

export type Member = {
  id: number;
  projectId: number;
  userId: number;
  role: string | null;
  joinedAt: string;
  user: { id: number; fullName: string; email: string; avatarUrl: string | null; role: string };
  rates: Rate[];
};

export type Rate = {
  id: number;
  memberId: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  costPerHour: string;
  currencyId: number | null;
  currency: { id: number; code: string; symbol: string } | null;
};

export async function listMembers(projectId: number) {
  const { data } = await apiClient.get<{ data: Member[] }>(`/members/by-project/${projectId}`);
  return data.data;
}

export async function createMember(projectId: number, input: MemberCreateInput) {
  const { data } = await apiClient.post<{ data: Member }>(`/members/by-project/${projectId}`, input);
  return data.data;
}

export async function updateMember(id: number, input: { role?: string | null }) {
  const { data } = await apiClient.patch<{ data: Member }>(`/members/${id}`, input);
  return data.data;
}

export async function deleteMember(id: number) {
  await apiClient.delete(`/members/${id}`);
}

export async function listRates(memberId: number) {
  const { data } = await apiClient.get<{ data: Rate[] }>(`/members/${memberId}/rates`);
  return data.data;
}

export async function createRate(memberId: number, input: MemberRateCreateInput) {
  const { data } = await apiClient.post<{ data: Rate }>(`/members/${memberId}/rates`, input);
  return data.data;
}

export async function updateRate(id: number, input: Partial<MemberRateCreateInput>) {
  const { data } = await apiClient.patch<{ data: Rate }>(`/rates/${id}`, input);
  return data.data;
}

export async function deleteRate(id: number) {
  await apiClient.delete(`/rates/${id}`);
}
