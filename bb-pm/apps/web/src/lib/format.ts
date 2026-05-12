export function formatMoney(value: number | string | null | undefined, symbol = "₫") {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(n)) return "—";
  return `${n.toLocaleString("vi-VN")} ${symbol}`;
}

export function formatDate(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("vi-VN");
}

export function formatHours(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `${v.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}h`;
}

export const statusColors: Record<string, string> = {
  PLANNED: "bg-slate-100 text-slate-700",
  IN_PROGRESS: "bg-blue-100 text-blue-700",
  ON_HOLD: "bg-amber-100 text-amber-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  CANCELLED: "bg-rose-100 text-rose-700",
  TODO: "bg-slate-100 text-slate-700",
  REVIEW: "bg-violet-100 text-violet-700",
  DONE: "bg-emerald-100 text-emerald-700",
  PENDING: "bg-amber-100 text-amber-700",
  APPROVED: "bg-emerald-100 text-emerald-700",
  REJECTED: "bg-rose-100 text-rose-700",
};

export const priorityColors: Record<string, string> = {
  LOW: "bg-slate-100 text-slate-700",
  MEDIUM: "bg-blue-100 text-blue-700",
  HIGH: "bg-orange-100 text-orange-700",
  URGENT: "bg-rose-100 text-rose-700",
};

export const statusLabels: Record<string, string> = {
  PLANNED: "Đã lên kế hoạch",
  IN_PROGRESS: "Đang triển khai",
  ON_HOLD: "Tạm dừng",
  COMPLETED: "Hoàn thành",
  CANCELLED: "Đã hủy",
  TODO: "Cần làm",
  REVIEW: "Đang review",
  DONE: "Xong",
  PENDING: "Chờ duyệt",
  APPROVED: "Đã duyệt",
  REJECTED: "Từ chối",
};
