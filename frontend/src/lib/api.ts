import { useMockUserStore } from "./mockUser";

const API_BASE = import.meta.env.VITE_API_URL ?? "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const mockId = useMockUserStore.getState().mockUserId;
  if (mockId) headers.set("x-mock-user-id", mockId);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (body && typeof body === "object" && "error" in body ? String((body as any).error) : res.statusText) ?? "request failed";
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}
