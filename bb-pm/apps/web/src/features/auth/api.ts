import { apiClient } from "@/lib/apiClient";
import type { LoginInput, RegisterInput } from "@bb-pm/shared";
import type { AuthUser } from "./store";

type AuthResponse = {
  data: { user: AuthUser; accessToken: string; refreshToken: string };
};

export async function login(input: LoginInput) {
  const { data } = await apiClient.post<AuthResponse>("/auth/login", input);
  return data.data;
}

export async function register(input: RegisterInput) {
  const { data } = await apiClient.post<AuthResponse>("/auth/register", input);
  return data.data;
}

export async function fetchPublicCompanies() {
  const { data } = await apiClient.get<{ data: { id: number; name: string; code?: string }[] }>(
    "/companies/public",
  );
  return data.data;
}

export async function fetchMe() {
  const { data } = await apiClient.get<{ data: AuthUser }>("/me");
  return data.data;
}
