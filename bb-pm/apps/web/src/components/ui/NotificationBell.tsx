import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/features/notifications/api";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();

  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => listNotifications(false, 20),
    refetchInterval: 30_000,
  });

  const markOne = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const markAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const unreadCount = q.data?.meta.unreadCount ?? 0;

  const onClick = (n: any) => {
    if (!n.readAt) markOne.mutate(n.id);
    setOpen(false);
    if (n.link) nav(n.link);
  };

  return (
    <div className="relative">
      <button
        className="relative rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800"
        onClick={() => setOpen(!open)}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-80 rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 p-2 dark:border-slate-800">
              <p className="text-sm font-semibold">Thông báo</p>
              {unreadCount > 0 && (
                <button
                  className="text-xs text-brand-600 hover:underline dark:text-brand-400"
                  onClick={() => markAll.mutate()}
                >
                  Đánh dấu tất cả đã đọc
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {q.data?.data.length === 0 && (
                <p className="p-6 text-center text-sm text-slate-500">Trống</p>
              )}
              {q.data?.data.map((n) => (
                <button
                  key={n.id}
                  onClick={() => onClick(n)}
                  className={`flex w-full items-start gap-2 border-b border-slate-100 p-3 text-left hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800 ${
                    n.readAt ? "opacity-60" : ""
                  }`}
                >
                  <div className="flex-1">
                    <p className="text-sm font-medium">{n.title}</p>
                    {n.message && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{n.message}</p>}
                    <p className="mt-1 text-[10px] text-slate-400">
                      {new Date(n.createdAt).toLocaleString("vi-VN")}
                    </p>
                  </div>
                  {n.readAt && <Check className="h-3 w-3 text-slate-300" />}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
