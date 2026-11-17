import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import handler, { buildMcpServer, authenticate } from "./mcp";
import type { Access } from "./_matomo";
import { mockMatomo, CONTAINER, DRAFT } from "./_testing";

const TOKEN = "tok_0123456789abcdef";

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.MATOMO_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.MATOMO_TOKEN;
  delete process.env.MCP_SECRET;
  delete process.env.MCP_WRITE_SECRET;
});

async function connectedClient(access?: Access) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), buildMcpServer(access).connect(serverTransport)]);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content)[0].text;

const WRITE_TOOLS = [
  "add_trigger", "update_trigger", "delete_trigger",
  "add_tag", "update_tag", "delete_tag", "pause_tag", "resume_tag",
  "add_variable", "update_variable", "delete_variable",
  "create_version", "publish_version",
];

// ─── outils exposés ──────────────────────────────────────────────────────────

describe("outils exposés", () => {
  it("accès en lecture (par défaut) : aucun outil d'écriture ni de publication", async () => {
    const { tools } = await (await connectedClient()).listTools();
    const names = tools.map((t) => t.name);
    for (const w of WRITE_TOOLS) expect(names).not.toContain(w);
    expect(names).toEqual(expect.arrayContaining(["get_container", "list_triggers", "find_orphan_triggers", "export_version", "list_reference_data", "track_custom_event"]));
    expect(tools.find((t) => t.name === "track_custom_event")!.description).toContain("LECTURE SEULE");
  });

  it("accès en écriture : expose les outils d'écriture", async () => {
    const names = (await (await connectedClient("write")).listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });

  it("publish_version se présente comme une mise en production", async () => {
    const { tools } = await (await connectedClient("write")).listTools();
    expect(tools.find((t) => t.name === "publish_version")!.description).toMatch(/^MISE EN PRODUCTION/);
  });
});

// ─── appels via le protocole MCP ─────────────────────────────────────────────

describe("appels d'outils", () => {
  it("get_container ne renvoie ni e-mail ni jeton", async () => {
    mockMatomo({ getContainer: CONTAINER });
    const r = await (await connectedClient()).callTool({ name: "get_container", arguments: {} });
    const t = textOf(r);
    expect(t).toContain(`brouillon ${DRAFT}`);
    expect(t).toContain("accès en lecture seule");
    expect(t).not.toMatch(/@/);
    expect(t).not.toContain("release_login");
    expect(t).not.toContain(TOKEN);
  });

  it("une erreur Matomo en HTTP 200 remonte en isError", async () => {
    mockMatomo({ getContainer: { result: "error", message: "accès 'view' requis" } });
    const r = await (await connectedClient()).callTool({ name: "get_container", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("accès 'view' requis");
  });

  it("find_orphan_triggers ne compte pas un déclencheur de blocage comme orphelin", async () => {
    mockMatomo({
      getContainer: CONTAINER,
      getContainerTags: [{ idtag: 1, name: "a", type: "Matomo", fire_trigger_ids: [10], block_trigger_ids: [12], status: "active" }],
      getContainerTriggers: [
        { idtrigger: 10, type: "CustomEvent", name: "dl__a", parameters: { eventName: "a" }, conditions: [] },
        { idtrigger: 12, type: "CustomEvent", name: "dl__b", parameters: { eventName: "b" }, conditions: [] },
        { idtrigger: 13, type: "CustomEvent", name: "dl__c", parameters: { eventName: "c" }, conditions: [] },
      ],
    });
    const t = textOf(await (await connectedClient()).callTool({ name: "find_orphan_triggers", arguments: {} }));
    expect(t).toContain("1 orphelin(s)");
    expect(t).toContain("dl__c");
    expect(t).not.toContain("dl__b");
  });

  it("track_custom_event en lecture seule simule sans écrire, même avec dry_run=false", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTags: [], getContainerTriggers: [], getContainerVariables: [] });
    const r = await (await connectedClient()).callTool({ name: "track_custom_event", arguments: { event: "x", category: "c", dry_run: false } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("Simulation");
    expect(calls.every((c) => c.method.startsWith("get"))).toBe(true);
  });

  it("track_custom_event écrit dans le brouillon en accès écriture", async () => {
    const calls = mockMatomo({
      getContainer: CONTAINER, getContainerTags: [], getContainerTriggers: [], getContainerVariables: [],
      addContainerTrigger: { value: 5000 }, addContainerTag: { value: 6000 },
    });
    const r = await (await connectedClient("write")).callTool({ name: "track_custom_event", arguments: { event: "x", category: "c" } });
    expect(textOf(r)).toContain(`Créé dans le brouillon ${DRAFT}`);
    expect(calls.map((c) => c.method)).toEqual(expect.arrayContaining(["addContainerTrigger", "addContainerTag"]));
  });

  it("publish_version en live sans confirm_live est refusé sans appel réseau", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, publishContainerVersion: { result: "success" } });
    const r = await (await connectedClient("write")).callTool({ name: "publish_version", arguments: { id_container_version: 900, environment: "live" } });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("publish_version publie sur dev par défaut", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, publishContainerVersion: { result: "success" } });
    const r = await (await connectedClient("write")).callTool({ name: "publish_version", arguments: { id_container_version: 900 } });
    expect(textOf(r)).toContain("publiée sur dev");
    expect(calls.find((c) => c.method === "publishContainerVersion")!.body.get("environment")).toBe("dev");
  });
});

// ─── outils d'écriture : chaque champ à sa place ─────────────────────────────

describe("outils d'écriture : snake_case de l'outil vers camelCase de Matomo", () => {
  const sent = (calls: ReturnType<typeof mockMatomo>, method: string) => calls.find((c) => c.method === method)!.body;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await (await connectedClient("write")).callTool({ name, arguments: args });
    expect(r.isError, textOf(r)).toBeFalsy();
  };

  const CUR_TAG = {
    idtag: 1, type: "Matomo", name: "cur", description: "cur-desc", parameters: { p: "cur" },
    fire_trigger_ids: [100], block_trigger_ids: [101], fire_limit: "once_lifetime", fire_delay: 9, priority: 99,
    start_date: "2020-01-01", end_date: "2020-12-31", status: "active",
  };
  const CUR_TRIGGER = { idtrigger: 1, type: "CustomEvent", name: "cur", description: "cur-desc", parameters: { eventName: "cur" }, conditions: [{ actual: "dlv__cur", comparison: "equals", expected: "cur" }] };
  const CUR_VARIABLE = { idvariable: 1, type: "DataLayer", name: "cur", description: "cur-desc", parameters: { dataLayerName: "cur" }, default_value: "cur-default", lookup_table: [{ matchValue: "a", comparison: "equals", outValue: "b" }] };

  it("add_trigger", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, addContainerTrigger: { value: 1 } });
    await call("add_trigger", { type: "CustomEvent", name: "n", parameters: { eventName: "e" }, conditions: [{ actual: "a", comparison: "equals", expected: "x" }], description: "d" });
    expect(Object.fromEntries(sent(calls, "addContainerTrigger"))).toEqual({
      module: "API", format: "json", method: "TagManager.addContainerTrigger", idSite: "7", idContainer: "s4n03ZE1", idContainerVersion: String(DRAFT),
      type: "CustomEvent", name: "n", "parameters[eventName]": "e",
      "conditions[0][actual]": "a", "conditions[0][comparison]": "equals", "conditions[0][expected]": "x", description: "d",
    });
  });

  it("update_trigger, tous les champs", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTrigger: CUR_TRIGGER, updateContainerTrigger: { result: "success" } });
    await call("update_trigger", { id_trigger: 1, name: "n", parameters: { eventName: "e" }, conditions: [{ actual: "a", comparison: "contains", expected: "x" }], description: "d" });
    expect(Object.fromEntries(sent(calls, "updateContainerTrigger"))).toMatchObject({
      idTrigger: "1", name: "n", "parameters[eventName]": "e",
      "conditions[0][actual]": "a", "conditions[0][comparison]": "contains", "conditions[0][expected]": "x", description: "d",
    });
  });

  it("add_tag", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, addContainerTag: { value: 1 } });
    await call("add_tag", {
      type: "Matomo", name: "n", parameters: { p: "v" }, fire_trigger_ids: [1], block_trigger_ids: [2],
      fire_limit: "once_page", fire_delay: 3, priority: 4, start_date: "2026-01-01", end_date: "2026-12-31", description: "d", status: "paused",
    });
    const b = sent(calls, "addContainerTag");
    expect(b.getAll("fireTriggerIds[]")).toEqual(["1"]);
    expect(b.getAll("blockTriggerIds[]")).toEqual(["2"]);
    expect(Object.fromEntries(b)).toMatchObject({
      type: "Matomo", name: "n", "parameters[p]": "v", fireLimit: "once_page", fireDelay: "3", priority: "4",
      startDate: "2026-01-01", endDate: "2026-12-31", description: "d", status: "paused",
    });
  });

  it("update_tag, tous les champs", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTag: CUR_TAG, updateContainerTag: { result: "success" } });
    await call("update_tag", {
      id_tag: 1, name: "n", parameters: { p: "v" }, fire_trigger_ids: [1], block_trigger_ids: [2],
      fire_limit: "once_page", fire_delay: 3, priority: 4, start_date: "2026-01-01", end_date: "2026-12-31", description: "d",
    });
    const b = sent(calls, "updateContainerTag");
    expect(b.getAll("fireTriggerIds[]")).toEqual(["1"]);
    expect(b.getAll("blockTriggerIds[]")).toEqual(["2"]);
    expect(Object.fromEntries(b)).toMatchObject({
      idTag: "1", name: "n", "parameters[p]": "v", fireLimit: "once_page", fireDelay: "3", priority: "4",
      startDate: "2026-01-01", endDate: "2026-12-31", description: "d",
    });
  });

  it("update_tag sans champ : renvoie la balise actuelle telle quelle", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTag: CUR_TAG, updateContainerTag: { result: "success" } });
    await call("update_tag", { id_tag: 1 });
    const b = sent(calls, "updateContainerTag");
    expect(b.getAll("fireTriggerIds[]")).toEqual(["100"]);
    expect(b.getAll("blockTriggerIds[]")).toEqual(["101"]);
    expect(Object.fromEntries(b)).toMatchObject({
      name: "cur", "parameters[p]": "cur", fireLimit: "once_lifetime", fireDelay: "9", priority: "99",
      startDate: "2020-01-01", endDate: "2020-12-31", description: "cur-desc",
    });
  });

  it("update_tag : end_date=null efface la date sans toucher start_date", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTag: CUR_TAG, updateContainerTag: { result: "success" } });
    await call("update_tag", { id_tag: 1, end_date: null });
    const up = Object.fromEntries(sent(calls, "updateContainerTag"));
    expect(up.startDate).toBe("2020-01-01");
    expect(up).not.toHaveProperty("endDate");
  });

  it("add_variable", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, addContainerVariable: { value: 1 } });
    await call("add_variable", {
      type: "DataLayer", name: "n", parameters: { dataLayerName: "f" }, default_value: "dv",
      lookup_table: [{ matchValue: "m", comparison: "equals", outValue: "o" }], description: "d",
    });
    expect(Object.fromEntries(sent(calls, "addContainerVariable"))).toMatchObject({
      type: "DataLayer", name: "n", "parameters[dataLayerName]": "f", defaultValue: "dv",
      "lookupTable[0][matchValue]": "m", "lookupTable[0][comparison]": "equals", "lookupTable[0][outValue]": "o", description: "d",
    });
  });

  it("update_variable, tous les champs", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerVariable: CUR_VARIABLE, updateContainerVariable: { result: "success" } });
    await call("update_variable", {
      id_variable: 1, name: "n", parameters: { dataLayerName: "f" }, default_value: "dv",
      lookup_table: [{ matchValue: "m", comparison: "equals", outValue: "o" }], description: "d",
    });
    expect(Object.fromEntries(sent(calls, "updateContainerVariable"))).toMatchObject({
      idVariable: "1", name: "n", "parameters[dataLayerName]": "f", defaultValue: "dv",
      "lookupTable[0][matchValue]": "m", "lookupTable[0][outValue]": "o", description: "d",
    });
  });

  it("update_variable sans champ : renvoie la variable actuelle telle quelle", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerVariable: CUR_VARIABLE, updateContainerVariable: { result: "success" } });
    await call("update_variable", { id_variable: 1 });
    expect(Object.fromEntries(sent(calls, "updateContainerVariable"))).toMatchObject({
      name: "cur", "parameters[dataLayerName]": "cur", defaultValue: "cur-default",
      "lookupTable[0][matchValue]": "a", "lookupTable[0][outValue]": "b", description: "cur-desc",
    });
  });
});

// ─── authentification ────────────────────────────────────────────────────────

function fakeRequest(opts: { token?: string; authorization?: string; method?: string } = {}): VercelRequest {
  return {
    method: opts.method ?? "POST",
    query: opts.token !== undefined ? { token: opts.token } : {},
    headers: opts.authorization !== undefined ? { authorization: opts.authorization } : {},
  } as unknown as VercelRequest;
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { res.headers[k] = v; return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; },
    end() { return res; },
    on() { return res; },
  };
  return res;
}

describe("authentification à deux secrets, fail-closed", () => {
  const configure = (read?: string, write?: string) => {
    if (read === undefined) delete process.env.MCP_SECRET; else process.env.MCP_SECRET = read;
    if (write === undefined) delete process.env.MCP_WRITE_SECRET; else process.env.MCP_WRITE_SECRET = write;
  };

  it("refuse tout si MCP_SECRET n'est pas configuré, même sans aucun identifiant", () => {
    configure();
    expect(authenticate(fakeRequest())).toMatchObject({ ok: false, status: 503 });
    expect(authenticate(fakeRequest({ authorization: "Bearer " }))).toMatchObject({ ok: false, status: 503 });
  });

  it("MCP_SECRET vide compte comme non configuré", () => {
    configure("");
    expect(authenticate(fakeRequest({ authorization: "Bearer " }))).toMatchObject({ ok: false, status: 503 });
  });

  it("MCP_WRITE_SECRET seul ne suffit pas à ouvrir le serveur", () => {
    configure(undefined, "w-secret");
    expect(authenticate(fakeRequest({ authorization: "Bearer w-secret" }))).toMatchObject({ ok: false, status: 503 });
  });

  it("ferme le serveur si les deux secrets sont identiques", () => {
    configure("same", "same");
    const r = authenticate(fakeRequest({ authorization: "Bearer same" }));
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(r.ok ? "" : r.error).toContain("identique");
  });

  it("MCP_WRITE_SECRET vide équivaut à pas d'écriture", () => {
    configure("r-secret", "");
    expect(authenticate(fakeRequest({ authorization: "Bearer " }))).toMatchObject({ ok: false, status: 401 });
    expect(authenticate(fakeRequest({ authorization: "Bearer r-secret" }))).toEqual({ ok: true, access: "read" });
  });

  it.each([
    ["Bearer", { authorization: "Bearer r-secret" }],
    ["Basic non encodé (Le Chat)", { authorization: "Basic r-secret" }],
    ["query ?token=", { token: "r-secret" }],
  ])("MCP_SECRET en %s donne la lecture seule", (_, opts) => {
    configure("r-secret", "w-secret");
    expect(authenticate(fakeRequest(opts))).toEqual({ ok: true, access: "read" });
  });

  it.each([
    ["Bearer", { authorization: "Bearer w-secret" }],
    ["Basic non encodé (Le Chat)", { authorization: "Basic w-secret" }],
    ["query ?token=", { token: "w-secret" }],
  ])("MCP_WRITE_SECRET en %s donne l'écriture", (_, opts) => {
    configure("r-secret", "w-secret");
    expect(authenticate(fakeRequest(opts))).toEqual({ ok: true, access: "write" });
  });

  it("le secret de lecture ne donne pas l'écriture quand aucun secret d'écriture n'est configuré", () => {
    configure("r-secret");
    expect(authenticate(fakeRequest({ authorization: "Bearer r-secret" }))).toEqual({ ok: true, access: "read" });
  });

  it.each([
    ["mauvais secret", { authorization: "Bearer wrong" }],
    ["préfixe du secret de lecture", { authorization: "Bearer r-sec" }],
    ["préfixe du secret d'écriture", { authorization: "Bearer w-sec" }],
    ["secret sans schéma", { authorization: "r-secret" }],
    ["schéma seul", { authorization: "Bearer" }],
    ["mauvais token en query", { token: "wrong" }],
    ["rien", {}],
  ])("refuse : %s", (_, opts) => {
    configure("r-secret", "w-secret");
    expect(authenticate(fakeRequest(opts))).toMatchObject({ ok: false, status: 401 });
  });

  it("le handler répond 503 sans MCP_SECRET, avant toute lecture Matomo", async () => {
    configure();
    const calls = mockMatomo({});
    const res = fakeResponse();
    await handler(fakeRequest({ authorization: "Bearer x" }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("le handler répond 401 sur un mauvais secret", async () => {
    configure("r-secret", "w-secret");
    const res = fakeResponse();
    await handler(fakeRequest({ authorization: "Bearer wrong" }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(401);
  });

  it("le handler laisse passer OPTIONS (préflight CORS) sans secret", async () => {
    configure();
    const res = fakeResponse();
    await handler(fakeRequest({ method: "OPTIONS" }), res as unknown as VercelResponse);
    expect(res.statusCode).toBe(204);
  });
});
