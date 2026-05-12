import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AuthUser = {
  id: number;
  email: string;
  fullName: string;
  role: "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";
  companyId: number;
  isSuperAdmin: boolean;
  avatarUrl?: string | null;
  lang?: string;
};

type State = {
  accessToken: string | null;
  refreshToken: string | null;
  user: AuthUser | null;
  setTokens: (access: string, refresh: string) => void;
  setUser: (u: AuthUser) => void;
  clear: () => void;
};

export const useAuth = create<State>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setUser: (user) => set({ user }),
      clear: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    { name: "bb-pm-auth" },
  ),
);
