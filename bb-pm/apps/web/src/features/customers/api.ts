import { apiClient } from "@/lib/apiClient";
import type { CustomerCreateInput } from "@bb-pm/shared";

export type Customer = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  taxCode: string | null;
  notes: string | null;
  _count?: { projects: number };
};

export async function listCustomers(q?: string) {
  const { data } = await apiClient.get<{
    data: Customer[];
    meta: { total: number; page: number; pageSize: number };
  }>("/customers", { params: q ? { q } : {} });
  return data;
}

export async function getCustomer(id: number) {
  const { data } = await apiClient.get<{ data: Customer & { projects: any[] } }>(`/customers/${id}`);
  return data.data;
}

export async function createCustomer(input: CustomerCreateInput) {
  const { data } = await apiClient.post<{ data: Customer }>("/customers", input);
  return data.data;
}

export async function updateCustomer(id: number, input: Partial<CustomerCreateInput>) {
  const { data } = await apiClient.patch<{ data: Customer }>(`/customers/${id}`, input);
  return data.data;
}

export async function deleteCustomer(id: number) {
  await apiClient.delete(`/customers/${id}`);
}
