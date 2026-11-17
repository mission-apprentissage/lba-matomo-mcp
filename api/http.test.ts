import { createServer, type IncomingMessage, type ServerResponse, type Server } from "http";
import type { AddressInfo } from "net";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import handler from "./mcp";
import { mockMatomo, CONTAINER } from "./_testing";

// Serveur HTTP réel avec les helpers que Vercel ajoute à req/res (query, body, status, json),
// pour exercer le transport Streamable HTTP sans session de bout en bout.
function vercelShim(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = Buffer.concat(chunks).toString();
    const vreq = Object.assign(req, {
      query: Object.fromEntries(url.searchParams),
      body: raw ? JSON.parse(raw) : undefined,
      cookies: {},
    }) as unknown as VercelRequest;
    const vres = Object.assign(res, {
      status(code: number) { res.statusCode = code; return vres; },
      json(body: unknown) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); return vres; },
      send(body: string) { res.end(body); return vres; },
    }) as unknown as VercelResponse;
    handler(vreq, vres).catch((e) => { res.statusCode = 500; res.end(String(e)); });
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(vercelShim);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

// fetch reste réel pour le client MCP ; seules les requêtes vers Matomo sont simulées.
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.MATOMO_TOKEN = "tok_test";
  process.env.MCP_SECRET = "s3cr3t";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MATOMO_TOKEN;
  delete process.env.MCP_SECRET;
  delete process.env.MCP_WRITE_SECRET;
});

function routeMatomo(routes: Record<string, unknown>) {
  mockMatomo(routes);
  const matomo = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) =>
    String(url).startsWith("http://127.0.0.1") ? realFetch(url, init) : matomo(url as string, init));
}

describe("HTTP /mcp (transport sans session)", () => {
  it("initialise, liste les outils et appelle get_container sur deux requêtes indépendantes", async () => {
    routeMatomo({ getContainer: CONTAINER });
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { Authorization: "Bearer s3cr3t" } } }));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("find_orphan_triggers");

    const r = await client.callTool({ name: "get_container", arguments: {} });
    expect((r.content as { text: string }[])[0].text).toContain("brouillon 17");
    await client.close();
  });

  it("le secret présenté fixe l'accès : lecture avec MCP_SECRET, écriture avec MCP_WRITE_SECRET", async () => {
    process.env.MCP_WRITE_SECRET = "w-secret";
    const calls: string[] = [];
    routeMatomo({
      getContainer: CONTAINER, getContainerTags: [], getContainerTriggers: [], getContainerVariables: [],
      addContainerTrigger: () => { calls.push("addContainerTrigger"); return { value: 5000 }; },
      addContainerTag: () => { calls.push("addContainerTag"); return { value: 6000 }; },
    });
    const connect = async (secret: string) => {
      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(base), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
      return client;
    };
    const args = { name: "track_custom_event", arguments: { event: "x", category: "c" } };

    const reader = await connect("s3cr3t");
    expect((await reader.listTools()).tools.map((t) => t.name)).not.toContain("publish_version");
    expect((await reader.callTool(args)).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Simulation") })]);
    expect(calls).toEqual([]);
    await reader.close();

    const writer = await connect("w-secret");
    expect((await writer.listTools()).tools.map((t) => t.name)).toContain("publish_version");
    expect((await writer.callTool(args)).content).toEqual([expect.objectContaining({ text: expect.stringContaining("Créé dans le brouillon 17") })]);
    expect(calls).toEqual(["addContainerTrigger", "addContainerTag"]);
    await writer.close();
  });

  it("répond 503 sans MCP_SECRET et 401 avec un mauvais secret", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } };
    const post = (auth?: string) => realFetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(init),
    });

    expect((await post("Bearer wrong")).status).toBe(401);
    delete process.env.MCP_SECRET;
    expect((await post("Bearer s3cr3t")).status).toBe(503);
  });

  it("refuse GET (pas de flux SSE en mode sans session)", async () => {
    const res = await realFetch(base, { headers: { Authorization: "Bearer s3cr3t", Accept: "text/event-stream" } });
    expect(res.status).toBe(405);
  });
});
