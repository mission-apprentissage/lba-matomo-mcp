import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as m from "./_matomo";
import { mockMatomo, CONTAINER, DRAFT } from "./_testing";

const TOKEN = "tok_0123456789abcdef";

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.MATOMO_TOKEN = TOKEN;
  delete process.env.MATOMO_URL;
  delete process.env.MATOMO_ID_SITE;
  delete process.env.MATOMO_ID_CONTAINER;
});

afterEach(() => {
  delete process.env.MATOMO_TOKEN;
});

const entries = (p: URLSearchParams) => [...p.entries()];

/** Test exécuté avec le droit d'écriture, comme un outil appelé avec MCP_WRITE_SECRET. */
const itWrite = (name: string, fn: () => Promise<unknown>) => it(name, () => m.withAccess("write", fn));

// ─── encodage ────────────────────────────────────────────────────────────────

describe("encodeParams (syntaxe PHP)", () => {
  it("encode un tableau associatif en clé[sous-clé]", () => {
    expect(entries(m.encodeParams({ parameters: { eventName: "filter_type_offer_applied", matomoConfig: "{{Matomo Configuration}}" } }))).toEqual([
      ["parameters[eventName]", "filter_type_offer_applied"],
      ["parameters[matomoConfig]", "{{Matomo Configuration}}"],
    ]);
  });

  it("encode une liste de scalaires en clé[] répétée", () => {
    expect(entries(m.encodeParams({ fireTriggerIds: [123, "456"] }))).toEqual([
      ["fireTriggerIds[]", "123"],
      ["fireTriggerIds[]", "456"],
    ]);
  });

  it("encode une liste d'objets en clé[i][champ]", () => {
    expect(entries(m.encodeParams({ conditions: [{ actual: "dlv__x", comparison: "equals", expected: "y" }, { actual: "PageUrl", comparison: "contains", expected: "/recherche" }] }))).toEqual([
      ["conditions[0][actual]", "dlv__x"],
      ["conditions[0][comparison]", "equals"],
      ["conditions[0][expected]", "y"],
      ["conditions[1][actual]", "PageUrl"],
      ["conditions[1][comparison]", "contains"],
      ["conditions[1][expected]", "/recherche"],
    ]);
  });

  it("omet tableaux vides, objets vides, null et undefined", () => {
    expect(entries(m.encodeParams({ a: [], b: {}, c: null, d: undefined, e: "" }))).toEqual([["e", ""]]);
  });

  it("sérialise le nom en crochets percent-encodés et encode la valeur", () => {
    // URLSearchParams encode les crochets : PHP les décode avant de parser, la forme reste équivalente.
    const s = m.encodeParams({ parameters: { eventName: "a&b=c" } }).toString();
    expect(decodeURIComponent(s.split("=")[0])).toBe("parameters[eventName]");
    expect(s).toContain("a%26b%3Dc");
  });
});

// ─── appel bas niveau ────────────────────────────────────────────────────────

describe("call", () => {
  it("POST form-encoded avec jeton en Bearer, jamais dans le corps ni l'URL", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER });
    await m.getContainer();
    const [c] = calls;
    expect(c.url).toBe("https://stats.beta.gouv.fr/index.php");
    expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(c.body.toString()).not.toContain(TOKEN);
    expect(c.url).not.toContain(TOKEN);
    expect(Object.fromEntries(c.body)).toMatchObject({ module: "API", format: "json", method: "TagManager.getContainer", idSite: "7", idContainer: "s4n03ZE1" });
  });

  it("lit MATOMO_URL, MATOMO_ID_SITE et MATOMO_ID_CONTAINER", async () => {
    process.env.MATOMO_URL = "https://matomo.example.test/";
    process.env.MATOMO_ID_SITE = "12";
    process.env.MATOMO_ID_CONTAINER = "abc";
    const calls = mockMatomo({ getContainer: CONTAINER });
    await m.getContainer();
    expect(calls[0].url).toBe("https://matomo.example.test/index.php");
    expect(calls[0].body.get("idSite")).toBe("12");
    expect(calls[0].body.get("idContainer")).toBe("abc");
  });

  it("lève une erreur sur {result:'error'} reçu en HTTP 200", async () => {
    mockMatomo({ getContainer: { result: "error", message: "Vous devez avoir l'accès 'view' pour le site id = 7." } });
    await expect(m.getContainer()).rejects.toThrow(/TagManager\.getContainer : Vous devez avoir l'accès 'view'/);
  });

  it("ne confond pas une liste ou un objet légitime avec une erreur", async () => {
    // near-miss : un objet qui a un champ result mais pas "error"
    mockMatomo({ getContainer: { result: "success", draft: { idcontainerversion: 3 } }, getAvailableEnvironments: [{ id: "live" }] });
    await expect(m.getContainer()).resolves.toMatchObject({ result: "success" });
    await expect(m.getAvailableEnvironments()).resolves.toEqual([{ id: "live" }]);
  });

  it("lève une erreur sur un code HTTP non 2xx et masque le jeton s'il est renvoyé", async () => {
    mockMatomo({ getContainer: { status: 502, body: `Bad gateway token=${TOKEN}` } });
    const err = await m.getContainer().catch((e: Error) => e);
    expect(err).toBeInstanceOf(m.MatomoApiError);
    expect((err as Error).message).toContain("HTTP 502");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("masque le jeton dans un message d'erreur Matomo", async () => {
    mockMatomo({ getContainer: { result: "error", message: `token ${TOKEN} invalide` } });
    const err = (await m.getContainer().catch((e: Error) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("***");
  });

  it("lève une erreur sur une réponse non JSON", async () => {
    mockMatomo({ getContainer: "<html>maintenance</html>" });
    await expect(m.getContainer()).rejects.toThrow(/non JSON/);
  });

  it("refuse sans MATOMO_TOKEN, sans appel réseau", async () => {
    delete process.env.MATOMO_TOKEN;
    const calls = mockMatomo({ getContainer: CONTAINER });
    await expect(m.getContainer()).rejects.toThrow(/MATOMO_TOKEN/);
    expect(calls).toHaveLength(0);
  });

  it("site, conteneur, méthode et format viennent de la configuration, pas des paramètres", async () => {
    const calls = mockMatomo({ getContainerTriggers: [] });
    await m.call("getContainerTriggers", { idContainerVersion: 1, idSite: 99, idContainer: "other", method: "TagManager.deleteContainer", module: "X", format: "xml" });
    const b = calls[0].body;
    expect(Object.fromEntries(b)).toMatchObject({ idSite: "7", idContainer: "s4n03ZE1", method: "TagManager.getContainerTriggers", module: "API", format: "json", idContainerVersion: "1" });
    for (const k of ["idSite", "idContainer", "method", "module", "format"]) expect(b.getAll(k)).toHaveLength(1);
  });

  it("un référentiel n'envoie pas d'idSite, même passé en paramètre", async () => {
    const calls = mockMatomo({ getAvailableComparisons: [] });
    await m.call("getAvailableComparisons", { idSite: 99, idContainer: "other" }, "global");
    expect(calls[0].body.has("idSite")).toBe(false);
    expect(calls[0].body.has("idContainer")).toBe(false);
  });

  it("les référentiels n'envoient ni idSite ni idContainer", async () => {
    const calls = mockMatomo({ getAvailableComparisons: [] });
    await m.getAvailableComparisons();
    expect(calls[0].body.has("idSite")).toBe(false);
    expect(calls[0].body.has("idContainer")).toBe(false);
  });
});

// ─── lecture seule ───────────────────────────────────────────────────────────

describe("garde lecture seule du client", () => {
  const WRITES: [string, () => Promise<unknown>][] = [
    ["addTrigger", () => m.addTrigger({ type: "CustomEvent", name: "x" })],
    ["updateTrigger", () => m.updateTrigger(1, { name: "x" })],
    ["deleteTrigger", () => m.deleteTrigger(1)],
    ["addTag", () => m.addTag({ type: "Matomo", name: "x", fireTriggerIds: [1] })],
    ["updateTag", () => m.updateTag(1, { name: "x" })],
    ["deleteTag", () => m.deleteTag(1)],
    ["pauseTag", () => m.pauseTag(1)],
    ["resumeTag", () => m.resumeTag(1)],
    ["addVariable", () => m.addVariable({ type: "DataLayer", name: "x" })],
    ["updateVariable", () => m.updateVariable(1, { name: "x" })],
    ["deleteVariable", () => m.deleteVariable(1)],
    ["createVersion", () => m.createVersion("v")],
    ["publishVersion", () => m.publishVersion(900, "dev")],
  ];
  const READS = {
    getContainer: CONTAINER,
    getContainerTrigger: { idtrigger: 1, type: "CustomEvent", name: "x", parameters: {}, conditions: [] },
    getContainerTag: { idtag: 1, type: "Matomo", name: "x", parameters: {}, fire_trigger_ids: [1] },
    getContainerVariable: { idvariable: 1, type: "DataLayer", name: "x", parameters: {} },
  };

  it.each(WRITES)("%s est refusé hors accès en écriture, sans appel d'écriture", async (_, write) => {
    const calls = mockMatomo(READS);
    await expect(write()).rejects.toBeInstanceOf(m.ReadOnlyError);
    expect(calls.every((c) => c.method.startsWith("get"))).toBe(true);
  });

  it("un module chargé à neuf est en lecture seule hors withAccess", async () => {
    vi.resetModules();
    const fresh = await import("./_matomo.js");
    expect(fresh.currentAccess()).toBe("read");
    const calls = mockMatomo(READS);
    await expect(fresh.deleteTrigger(1)).rejects.toBeInstanceOf(fresh.ReadOnlyError);
    expect(calls.map((c) => c.method)).not.toContain("deleteContainerTrigger");
  });

  it("withAccess('read') refuse l'écriture", async () => {
    const calls = mockMatomo(READS);
    await expect(m.withAccess("read", () => m.deleteTrigger(1))).rejects.toBeInstanceOf(m.ReadOnlyError);
    expect(calls.map((c) => c.method)).not.toContain("deleteContainerTrigger");
  });

  it("withAccess('write') autorise l'écriture, et le droit ne fuit pas après l'appel", async () => {
    mockMatomo({ ...READS, deleteContainerTrigger: { result: "success" } });
    await expect(m.withAccess("write", () => m.deleteTrigger(1))).resolves.toBeUndefined();
    expect(m.currentAccess()).toBe("read");
    await expect(m.deleteTrigger(1)).rejects.toBeInstanceOf(m.ReadOnlyError);
  });

  it("deux requêtes concurrentes gardent chacune leur droit", async () => {
    mockMatomo({ ...READS, deleteContainerTrigger: { result: "success" } });
    const [w, r] = await Promise.allSettled([
      m.withAccess("write", () => m.deleteTrigger(1)),
      m.withAccess("read", () => m.deleteTrigger(2)),
    ]);
    expect(w.status).toBe("fulfilled");
    expect(r.status).toBe("rejected");
  });

  it("laisse passer les lectures", async () => {
    mockMatomo({ getContainer: CONTAINER });
    await expect(m.getDraftVersionId()).resolves.toBe(DRAFT);
  });
});

// ─── texte masqué ────────────────────────────────────────────────────────────

describe("écriture d'un texte masqué par redact", () => {
  const masked = { actual: "PageUrl", comparison: "contains", expected: `mailto:${m.EMAIL_MASK}` };

  itWrite("refuse d'envoyer « [e-mail masqué] », sans appel d'écriture", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, addContainerTrigger: { value: 1 } });
    await expect(m.addTrigger({ type: "CustomEvent", name: "x", conditions: [masked] })).rejects.toThrow(/e-mail masqué/);
    expect(calls.map((c) => c.method)).not.toContain("addContainerTrigger");
  });

  itWrite("refuse aussi dans un patch d'update_*", async () => {
    const calls = mockMatomo({
      getContainer: CONTAINER,
      getContainerTag: { idtag: 1, type: "Matomo", name: "t", parameters: {}, fire_trigger_ids: [1] },
      updateContainerTag: { result: "success" },
    });
    await expect(m.updateTag(1, { description: `contact ${m.EMAIL_MASK}` })).rejects.toThrow(/e-mail masqué/);
    expect(calls.map((c) => c.method)).not.toContain("updateContainerTag");
  });

  itWrite("near-miss : une vraie adresse part intacte", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, addContainerTrigger: { value: 1 } });
    await m.addTrigger({ type: "CustomEvent", name: "x", conditions: [{ ...masked, expected: "mailto:contact@example.org" }] });
    expect(calls.find((c) => c.method === "addContainerTrigger")!.body.get("conditions[0][expected]")).toBe("mailto:contact@example.org");
  });

  itWrite("update_* renvoie l'adresse d'origine d'un champ non modifié : le masquage ne touche que les sorties MCP", async () => {
    const calls = mockMatomo({
      getContainer: CONTAINER,
      getContainerTrigger: { idtrigger: 1, type: "CustomEvent", name: "old", parameters: { eventName: "e" }, conditions: [{ ...masked, expected: "mailto:contact@example.org" }] },
      updateContainerTrigger: { result: "success" },
    });
    await m.updateTrigger(1, { name: "new" });
    expect(calls.find((c) => c.method === "updateContainerTrigger")!.body.get("conditions[0][expected]")).toBe("mailto:contact@example.org");
  });

  it("near-miss : une lecture qui contient le texte masqué n'est pas bloquée", async () => {
    mockMatomo({ getContainerTriggers: [] });
    await expect(m.call("getContainerTriggers", { idContainerVersion: 1, note: m.EMAIL_MASK })).resolves.toEqual([]);
  });
});

// ─── brouillon ───────────────────────────────────────────────────────────────

describe("résolution du brouillon", () => {
  it("lit draft.idcontainerversion et l'utilise pour les lectures sans version", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTriggers: [] });
    await m.listTriggers();
    expect(calls.map((c) => c.method)).toEqual(["getContainer", "getContainerTriggers"]);
    expect(calls[1].body.get("idContainerVersion")).toBe(String(DRAFT));
  });

  it("respecte une version explicite en lecture, sans appeler getContainer", async () => {
    const calls = mockMatomo({ getContainerTriggers: [] });
    await m.listTriggers(842);
    expect(calls.map((c) => c.method)).toEqual(["getContainerTriggers"]);
    expect(calls[0].body.get("idContainerVersion")).toBe("842");
  });

  it("accepte un id renvoyé en chaîne", async () => {
    mockMatomo({ getContainer: { ...CONTAINER, draft: { idcontainerversion: "17" } } });
    await expect(m.getDraftVersionId()).resolves.toBe(17);
  });

  it.each([
    ["sans draft", { idcontainer: "s4n03ZE1" }],
    ["draft vide", { idcontainer: "s4n03ZE1", draft: {} }],
    ["id nul", { idcontainer: "s4n03ZE1", draft: { idcontainerversion: 0 } }],
    ["id non numérique", { idcontainer: "s4n03ZE1", draft: { idcontainerversion: "abc" } }],
  ])("lève une erreur %s", async (_, container) => {
    mockMatomo({ getContainer: container });
    await expect(m.getDraftVersionId()).rejects.toThrow(/brouillon introuvable/);
  });

  itWrite("écrit toujours dans le brouillon", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, addContainerTrigger: { value: 3300 } });
    await expect(m.addTrigger({ type: "CustomEvent", name: "dl__x", parameters: { eventName: "x" } })).resolves.toBe(3300);
    const add = calls.find((c) => c.method === "addContainerTrigger")!;
    expect(add.body.get("idContainerVersion")).toBe(String(DRAFT));
    expect(add.body.get("parameters[eventName]")).toBe("x");
  });

  itWrite("refuse de publier le brouillon", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, publishContainerVersion: { result: "success" } });
    await expect(m.publishVersion(DRAFT, "dev")).rejects.toThrow(/brouillon/);
    expect(calls.map((c) => c.method)).not.toContain("publishContainerVersion");
  });

  itWrite("publie une version figée sur l'environnement demandé", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, publishContainerVersion: { result: "success", message: "ok" } });
    await m.publishVersion(900, "dev");
    const pub = calls.find((c) => c.method === "publishContainerVersion")!;
    expect(pub.body.get("idContainerVersion")).toBe("900");
    expect(pub.body.get("environment")).toBe("dev");
  });

  itWrite("createVersion n'envoie pas d'idContainerVersion (brouillon par défaut côté Matomo)", async () => {
    const calls = mockMatomo({ createContainerVersion: { value: 901 } });
    await expect(m.createVersion("v15 ménage")).resolves.toBe(901);
    expect(calls[0].body.has("idContainerVersion")).toBe(false);
  });

  itWrite("createVersion refuse un nom de plus de 50 caractères", async () => {
    await expect(m.createVersion("x".repeat(51))).rejects.toThrow(/1 à 50/);
  });
});

// ─── orphelins ───────────────────────────────────────────────────────────────

describe("findOrphanTriggers", () => {
  const trig = (idtrigger: number | string, name = `t${idtrigger}`) => ({ idtrigger, type: "CustomEvent", name, parameters: { eventName: name }, conditions: [] });

  it("détecte un déclencheur qu'aucune balise ne cite", async () => {
    mockMatomo({
      getContainer: CONTAINER,
      getContainerTags: [{ idtag: 1, name: "a", type: "Matomo", fire_trigger_ids: [10], block_trigger_ids: [], status: "active" }],
      getContainerTriggers: [trig(10), trig(11)],
    });
    const r = await m.findOrphanTriggers();
    expect(r.orphans.map((t) => t.idtrigger)).toEqual([11]);
    expect(r).toMatchObject({ idContainerVersion: DRAFT, tags: 1, triggers: 2 });
  });

  it("faux positif : un déclencheur référencé uniquement en block_trigger_ids n'est pas orphelin", async () => {
    mockMatomo({
      getContainer: CONTAINER,
      getContainerTags: [{ idtag: 1, name: "a", type: "Matomo", fire_trigger_ids: [10], block_trigger_ids: [12], status: "active" }],
      getContainerTriggers: [trig(10), trig(12)],
    });
    expect((await m.findOrphanTriggers()).orphans).toEqual([]);
  });

  it("faux positif : ids en chaîne d'un côté et en nombre de l'autre", async () => {
    mockMatomo({
      getContainer: CONTAINER,
      getContainerTags: [{ idtag: 1, name: "a", type: "Matomo", fire_trigger_ids: ["10"], block_trigger_ids: ["12"], status: "active" }],
      getContainerTriggers: [trig(10), trig(12)],
    });
    expect((await m.findOrphanTriggers()).orphans).toEqual([]);
  });

  it("near-miss : un nom de balise qui contient le nom du déclencheur ne compte pas comme usage", async () => {
    mockMatomo({
      getContainer: CONTAINER,
      getContainerTags: [{ idtag: 1, name: "dl__t11", type: "Matomo", parameters: { eventAction: "t11" }, fire_trigger_ids: [10], block_trigger_ids: [], status: "active" }],
      getContainerTriggers: [trig(10), trig(11)],
    });
    expect((await m.findOrphanTriggers()).orphans.map((t) => t.idtrigger)).toEqual([11]);
  });

  it("near-miss : un id de balise égal à l'id du déclencheur ne compte pas comme usage", async () => {
    mockMatomo({
      getContainer: CONTAINER,
      getContainerTags: [{ idtag: 11, name: "a", type: "Matomo", fire_trigger_ids: [10], status: "active" }],
      getContainerTriggers: [trig(10), trig(11)],
    });
    expect((await m.findOrphanTriggers()).orphans.map((t) => t.idtrigger)).toEqual([11]);
  });

  it("isole les déclencheurs utilisés seulement par des balises en pause, sans les dire orphelins", async () => {
    mockMatomo({
      getContainer: CONTAINER,
      getContainerTags: [
        { idtag: 1, name: "a", type: "Matomo", fire_trigger_ids: [10], status: "active" },
        { idtag: 2, name: "b", type: "Matomo", fire_trigger_ids: [11, 10], status: "paused" },
      ],
      getContainerTriggers: [trig(10), trig(11)],
    });
    const r = await m.findOrphanTriggers();
    expect(r.orphans).toEqual([]);
    expect(r.pausedOnly.map((t) => t.idtrigger)).toEqual([11]);
  });

  it("lit une version explicite sans passer par le brouillon", async () => {
    const calls = mockMatomo({ getContainerTags: [], getContainerTriggers: [trig(1)] });
    const r = await m.findOrphanTriggers(842);
    expect(r.idContainerVersion).toBe(842);
    expect(calls.every((c) => c.body.get("idContainerVersion") === "842")).toBe(true);
  });
});

// ─── update = remplacement complet ───────────────────────────────────────────

describe("update_* part de l'objet existant", () => {
  const TAG = {
    idtag: 2616, type: "Matomo", name: "search__remove_trainings", description: "desc",
    parameters: { matomoConfig: "{{Matomo Configuration}}", trackingType: "event", eventCategory: "search", eventAction: "remove_trainings", eventName: "{{dlv__search_job_name}}" },
    fire_trigger_ids: [2757], block_trigger_ids: [2758], fire_limit: "once_page", fire_delay: 0, priority: 999, start_date: null, end_date: null, status: "active",
  };

  itWrite("updateTag renvoie tous les champs, en camelCase, et ne change que ceux du patch", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTag: TAG, updateContainerTag: { result: "success" } });
    await m.updateTag(2616, { name: "search__remove_trainings_v2" });
    const up = Object.fromEntries(calls.find((c) => c.method === "updateContainerTag")!.body);
    expect(up).toMatchObject({
      idContainerVersion: String(DRAFT),
      idTag: "2616",
      name: "search__remove_trainings_v2",
      "parameters[matomoConfig]": "{{Matomo Configuration}}",
      "parameters[eventName]": "{{dlv__search_job_name}}",
      "fireTriggerIds[]": "2757",
      "blockTriggerIds[]": "2758",
      fireLimit: "once_page",
      fireDelay: "0",
      priority: "999",
      description: "desc",
    });
    expect(up).not.toHaveProperty("startDate");
    expect(up).not.toHaveProperty("status");
  });

  itWrite("updateTag lit la balise dans le brouillon", async () => {
    const calls = mockMatomo({ getContainer: CONTAINER, getContainerTag: TAG, updateContainerTag: { result: "success" } });
    await m.updateTag(2616, { fireLimit: "unlimited" });
    expect(calls.find((c) => c.method === "getContainerTag")!.body.get("idContainerVersion")).toBe(String(DRAFT));
  });

  itWrite("updateTag refuse de vider fire_trigger_ids", async () => {
    mockMatomo({ getContainer: CONTAINER, getContainerTag: { ...TAG, fire_trigger_ids: [] }, updateContainerTag: { result: "success" } });
    await expect(m.updateTag(2616, { name: "x" })).rejects.toThrow(/au moins un déclencheur/);
  });

  itWrite("updateTrigger garde les conditions existantes et traite parameters: [] comme vide", async () => {
    const calls = mockMatomo({
      getContainer: CONTAINER,
      getContainerTrigger: { idtrigger: 3763, type: "CustomEvent", name: "old", parameters: [], conditions: [{ actual: "dlv__a", comparison: "equals", expected: "b" }] },
      updateContainerTrigger: { result: "success" },
    });
    await m.updateTrigger(3763, { name: "new" });
    const up = Object.fromEntries(calls.find((c) => c.method === "updateContainerTrigger")!.body);
    expect(up).toMatchObject({ name: "new", "conditions[0][actual]": "dlv__a", "conditions[0][expected]": "b", description: "" });
    expect(Object.keys(up).some((k) => k.startsWith("parameters"))).toBe(false);
  });

  itWrite("updateVariable omet un default_value absent (false) au lieu d'envoyer \"0\"", async () => {
    const calls = mockMatomo({
      getContainer: CONTAINER,
      getContainerVariable: { idvariable: 5, type: "DataLayer", name: "dlv__x", parameters: { dataLayerName: "x" }, default_value: false, lookup_table: [] },
      updateContainerVariable: { result: "success" },
    });
    await m.updateVariable(5, { description: "d" });
    const up = Object.fromEntries(calls.find((c) => c.method === "updateContainerVariable")!.body);
    expect(up).not.toHaveProperty("defaultValue");
    expect(up["parameters[dataLayerName]"]).toBe("x");
  });
});

// ─── track_custom_event ──────────────────────────────────────────────────────

describe("trackCustomEvent", () => {
  const base = {
    getContainer: CONTAINER,
    getContainerTags: [],
    getContainerTriggers: [],
    getContainerVariables: [{ idvariable: 1, type: "DataLayer", name: "dlv__search_job_name", parameters: { dataLayerName: "search_job_name" } }],
  };

  itWrite("crée le déclencheur dl__<event> puis la balise <catégorie>__<action> qui le cite", async () => {
    const calls = mockMatomo({ ...base, addContainerTrigger: { value: 5000 }, addContainerTag: { value: 6000 } });
    const r = await m.trackCustomEvent({ event: "filter_type_offer_applied", category: "search", nameField: "search_job_name" });
    expect(r).toMatchObject({ trigger: { id: 5000, name: "dl__filter_type_offer_applied", reused: false }, tag: { id: 6000, name: "search__filter_type_offer_applied" } });

    const trig = Object.fromEntries(calls.find((c) => c.method === "addContainerTrigger")!.body);
    expect(trig).toMatchObject({ type: "CustomEvent", name: "dl__filter_type_offer_applied", "parameters[eventName]": "filter_type_offer_applied", idContainerVersion: String(DRAFT) });

    const tag = calls.find((c) => c.method === "addContainerTag")!.body;
    expect(Object.fromEntries(tag)).toMatchObject({
      type: "Matomo",
      name: "search__filter_type_offer_applied",
      "parameters[matomoConfig]": "{{Matomo Configuration}}",
      "parameters[trackingType]": "event",
      "parameters[eventCategory]": "search",
      "parameters[eventAction]": "filter_type_offer_applied",
      "parameters[eventName]": "{{dlv__search_job_name}}",
      fireLimit: "unlimited",
      idContainerVersion: String(DRAFT),
    });
    expect(tag.getAll("fireTriggerIds[]")).toEqual(["5000"]);
  });

  itWrite("réutilise un CustomEvent orphelin sur le même eventName, même s'il porte un autre nom", async () => {
    const calls = mockMatomo({
      ...base,
      getContainerTriggers: [{ idtrigger: 3216, type: "CustomEvent", name: "dl__filter_type_offer_changed", parameters: { eventName: "filter_type_offer_applied" }, conditions: [] }],
      addContainerTag: { value: 6000 },
    });
    const r = await m.trackCustomEvent({ event: "filter_type_offer_applied", category: "search" });
    expect(r.trigger).toEqual({ id: 3216, name: "dl__filter_type_offer_changed", reused: true });
    expect(calls.map((c) => c.method)).not.toContain("addContainerTrigger");
    expect(calls.find((c) => c.method === "addContainerTag")!.body.getAll("fireTriggerIds[]")).toEqual(["3216"]);
  });

  itWrite("near-miss : ne réutilise pas un déclencheur du même eventName mais avec des conditions", async () => {
    mockMatomo({
      ...base,
      getContainerTriggers: [{ idtrigger: 3763, type: "CustomEvent", name: "dl_results_displayed", parameters: { eventName: "search_results_displayed" }, conditions: [{ actual: "dlv__n", comparison: "equals", expected: "0" }] }],
      addContainerTrigger: { value: 5001 },
      addContainerTag: { value: 6001 },
    });
    const r = await m.trackCustomEvent({ event: "search_results_displayed", category: "search" });
    expect(r.trigger).toMatchObject({ id: 5001, reused: false });
  });

  itWrite("refuse un nom de balise déjà pris, sans écrire", async () => {
    const calls = mockMatomo({ ...base, getContainerTags: [{ idtag: 1, type: "Matomo", name: "search__x", fire_trigger_ids: [1] }] });
    await expect(m.trackCustomEvent({ event: "x", category: "search" })).rejects.toThrow(/existe déjà/);
    expect(calls.some((c) => c.method.startsWith("add"))).toBe(false);
  });

  itWrite("refuse une variable absente, sauf create_missing_variables", async () => {
    mockMatomo(base);
    await expect(m.trackCustomEvent({ event: "x", category: "c", valueField: "count" })).rejects.toThrow(/dlv__count/);

    const calls = mockMatomo({ ...base, addContainerVariable: { value: 7000 }, addContainerTrigger: { value: 5000 }, addContainerTag: { value: 6000 } });
    const r = await m.trackCustomEvent({ event: "x", category: "c", valueField: "count", createMissingVariables: true });
    expect(r.variablesCreated).toEqual(["dlv__count"]);
    expect(Object.fromEntries(calls.find((c) => c.method === "addContainerVariable")!.body)).toMatchObject({ type: "DataLayer", name: "dlv__count", "parameters[dataLayerName]": "count" });
  });

  itWrite("refuse une variable dlv__<champ> qui n'est pas une DataLayer, sans écrire", async () => {
    const calls = mockMatomo({ ...base, getContainerVariables: [{ idvariable: 2, type: "Constant", name: "dlv__count", parameters: { dataLayerName: "count", value: "3" } }] });
    await expect(m.trackCustomEvent({ event: "x", category: "c", valueField: "count" })).rejects.toThrow(/dlv__count existe mais ne lit pas le champ "count"/);
    expect(calls.some((c) => c.method.startsWith("add"))).toBe(false);
  });

  itWrite("near-miss : refuse une DataLayer dlv__<champ> qui lit un autre champ", async () => {
    mockMatomo({ ...base, getContainerVariables: [{ idvariable: 2, type: "DataLayer", name: "dlv__count", parameters: { dataLayerName: "nb_results" } }] });
    await expect(m.trackCustomEvent({ event: "x", category: "c", valueField: "count", createMissingVariables: true })).rejects.toThrow(/nb_results/);
  });

  it("dry_run ne fait que des lectures, y compris en lecture seule", async () => {
    const calls = mockMatomo(base);
    const r = await m.trackCustomEvent({ event: "x", category: "c", nameField: "search_job_name", dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.tag.parameters.eventName).toBe("{{dlv__search_job_name}}");
    expect(calls.every((c) => c.method.startsWith("get"))).toBe(true);
  });

  itWrite("signale ce qui a déjà été créé quand la balise échoue", async () => {
    mockMatomo({ ...base, addContainerTrigger: { value: 5000 }, addContainerTag: { result: "error", message: "eventCategory invalide" } });
    await expect(m.trackCustomEvent({ event: "x", category: "c" })).rejects.toThrow(/eventCategory invalide.*déclencheur dl__x \(5000\)/);
  });
});

// ─── masquage ────────────────────────────────────────────────────────────────

describe("redact", () => {
  it("retire release_login et masque les e-mails, sans toucher aux références {{…}}", () => {
    const out = m.redact(CONTAINER);
    expect(JSON.stringify(out)).not.toMatch(/@/);
    expect(out.releases[0]).toEqual({ environment: "live", idcontainerversion: 842, release_date: "2026-11-17" });
    expect(m.redact({ p: "{{Matomo Configuration}}" })).toEqual({ p: "{{Matomo Configuration}}" });
  });
});
