import { apiClient } from "@/lib/apiClient";

export type Notification = {
  id: number;
  userId: number;
  type: string;
  title: string;
  message: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

export async function listNotifications(unread = false, limit = 20) {
  const { data } = await apiClient.get<{
    data: Notification[];
    meta: { total: number; unreadCount: number };
  }>("/notifications", { params: { unread, limit } });
  return data;
}

export async function markNotificationRead(id: number) {
  await apiClient.patch(`/notifications/${id}/read`);
}

export async function markAllNotificationsRead() {
  await apiClient.post("/notifications/read-all");
}
