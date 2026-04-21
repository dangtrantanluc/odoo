import axios, { AxiosError } from "axios";
import { useAuth } from "@/features/auth/store";

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE ?? "/api/v1",
  headers: { "content-type": "application/json" },
});

apiClient.interceptors.request.use((config) => {
  const token = useAuth.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let refreshing: Promise<string | null> | null = null;

apiClient.interceptors.response.use(
  (r) => r,
  async (err: AxiosError) => {
    const original = err.config as any;
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true;
      refreshing =
        refreshing ??
        (async () => {
          const rt = useAuth.getState().refreshToken;
          if (!rt) return null;
          try {
            const { data } = await axios.post(
              `${apiClient.defaults.baseURL}/auth/refresh`,
              { refreshToken: rt },
            );
            useAuth.getState().setTokens(data.data.accessToken, data.data.refreshToken);
            return data.data.accessToken as string;
          } catch {
            useAuth.getState().clear();
            return null;
          } finally {
            refreshing = null;
          }
        })();
      const newToken = await refreshing;
      if (newToken) {
        original.headers.Authorization = `Bearer ${newToken}`;
        return apiClient(original);
      }
    }
    return Promise.reject(err);
  },
);
