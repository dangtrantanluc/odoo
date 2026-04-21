import { apiClient } from "@/lib/apiClient";

export type DashboardKpis = {
  projects: { active: number; planned: number; completed: number; onHold: number };
  pendingBacklogs: number;
  tasksByStatus: Record<string, number>;
  thisMonth: { hours: number; cost: number };
};

export type DashboardCharts = {
  hoursByDay: { day: string; hours: number; cost: number }[];
  costByProject: { id: number; name: string; totalCost: number; totalHours: number }[];
  budgetUsage: { id: number; name: string; budget: number; totalCost: number; usagePct: number; status: string }[];
};

export async function fetchKpis() {
  const { data } = await apiClient.get<{ data: DashboardKpis }>("/dashboard/kpis");
  return data.data;
}

export async function fetchCharts(range: "7d" | "30d" | "90d" = "30d") {
  const { data } = await apiClient.get<{ data: DashboardCharts }>("/dashboard/charts", { params: { range } });
  return data.data;
}
