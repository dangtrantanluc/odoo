import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchCharts, fetchKpis } from "@/features/dashboard/api";
import { useAuth } from "@/features/auth/store";
import { formatHours, formatMoney, statusColors, statusLabels } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Link } from "react-router-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

const TASK_COLORS: Record<string, string> = {
  TODO: "#94a3b8",
  IN_PROGRESS: "#3b82f6",
  REVIEW: "#a855f7",
  DONE: "#10b981",
};

export function DashboardPage() {
  const user = useAuth((s) => s.user);
  const [range, setRange] = useState<"7d" | "30d" | "90d">("30d");

  const kpisQ = useQuery({ queryKey: ["dashboard-kpis"], queryFn: fetchKpis });
  const chartsQ = useQuery({ queryKey: ["dashboard-charts", range], queryFn: () => fetchCharts(range) });

  const kpis = kpisQ.data;
  const charts = chartsQ.data;

  const taskPieData = kpis
    ? Object.entries(kpis.tasksByStatus).map(([status, count]) => ({
        name: statusLabels[status] ?? status,
        status,
        value: count,
      }))
    : [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-slate-500">Xin chào {user?.fullName}</p>
        </div>
        <div className="flex gap-1 rounded-md border border-slate-200 bg-white">
          {(["7d", "30d", "90d"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 text-sm ${range === r ? "bg-brand-600 text-white" : "text-slate-600"}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 md:grid-cols-4">
        <Kpi label="Projects đang chạy" value={kpis?.projects.active ?? "—"} sub={`${kpis?.projects.planned ?? 0} planned · ${kpis?.projects.onHold ?? 0} on hold`} />
        <Kpi label="Backlog chờ duyệt" value={kpis?.pendingBacklogs ?? "—"} sub={<Link to="/backlogs" className="text-brand-700 hover:underline">Mở queue →</Link>} />
        <Kpi label="Giờ công tháng này" value={formatHours(kpis?.thisMonth.hours ?? 0)} />
        <Kpi label="Chi phí tháng này" value={formatMoney(kpis?.thisMonth.cost ?? 0, "₫")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Tasks by status */}
        <div className="card">
          <h2 className="mb-3 font-semibold">Tasks theo trạng thái</h2>
          {taskPieData.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">Chưa có task</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={taskPieData} dataKey="value" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                  {taskPieData.map((d) => (
                    <Cell key={d.status} fill={TASK_COLORS[d.status] ?? "#94a3b8"} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Hours by day */}
        <div className="card lg:col-span-2">
          <h2 className="mb-3 font-semibold">Giờ công được duyệt — {range}</h2>
          {!charts || charts.hoursByDay.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">Chưa có dữ liệu</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={charts.hoursByDay.map(d => ({ ...d, day: new Date(d.day).toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" }) }))}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} />
                <Tooltip formatter={(v: any, name) => name === "hours" ? `${v}h` : formatMoney(v, "₫")} />
                <Bar dataKey="hours" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Cost + Budget */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-3 font-semibold">Top 10 chi phí theo dự án</h2>
          {!charts || charts.costByProject.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">Trống</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={charts.costByProject} layout="vertical">
                <XAxis type="number" fontSize={11} />
                <YAxis type="category" dataKey="name" width={120} fontSize={11} />
                <Tooltip formatter={(v: any) => formatMoney(v, "₫")} />
                <Bar dataKey="totalCost" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h2 className="mb-3 font-semibold">Sử dụng ngân sách</h2>
          {!charts || charts.budgetUsage.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-500">Chưa có dự án nào có ngân sách</p>
          ) : (
            <ul className="space-y-3">
              {charts.budgetUsage.map((p) => (
                <li key={p.id}>
                  <div className="flex items-center justify-between text-sm">
                    <Link to={`/projects/${p.id}`} className="font-medium hover:text-brand-700">{p.name}</Link>
                    <div className="flex items-center gap-2">
                      <Badge className={statusColors[p.status]}>{statusLabels[p.status]}</Badge>
                      <span className={`text-xs ${p.usagePct > 90 ? "text-rose-600 font-bold" : p.usagePct > 70 ? "text-amber-600" : "text-slate-500"}`}>
                        {p.usagePct}%
                      </span>
                    </div>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full ${p.usagePct > 100 ? "bg-rose-500" : p.usagePct > 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${Math.min(p.usagePct, 100)}%` }}
                    />
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatMoney(p.totalCost, "₫")} / {formatMoney(p.budget, "₫")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="card">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
