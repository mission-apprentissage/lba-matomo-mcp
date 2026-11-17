import { vi } from "vitest";

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
  method: string;
}

type Route = (body: URLSearchParams) => { status?: number; body: unknown } | unknown;

/**
 * Remplace fetch par un routeur sur `method=TagManager.<X>` du corps POST.
 * Une valeur `{ status, body }` simule un code HTTP ; sinon la valeur est le corps JSON en HTTP 200.
 */
export function mockMatomo(routes: Record<string, Route | unknown>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    const method = (body.get("method") ?? "").replace(/^TagManager\./, "");
    calls.push({ url, headers: init.headers as Record<string, string>, body, method });
    if (!(method in routes)) throw new Error(`route non simulée : ${method}`);
    const route = routes[method];
    const out = typeof route === "function" ? (route as Route)(body) : route;
    const isWrapped = !!out && typeof out === "object" && "body" in out && "status" in out;
    const status = isWrapped ? (out as { status: number }).status : 200;
    const payload = isWrapped ? (out as { body: unknown }).body : out;
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    return { ok: status < 400, status, text: async () => raw, json: async () => JSON.parse(raw) };
  }));
  return calls;
}

export const DRAFT = 17;
export const CONTAINER = {
  idcontainer: "s4n03ZE1",
  name: "LBA_PRODUCTION",
  draft: { idcontainerversion: DRAFT, name: "", release_login: "x@example.org" },
  releases: [{ environment: "live", idcontainerversion: 842, release_login: "someone@example.org", release_date: "2026-11-17" }],
};
