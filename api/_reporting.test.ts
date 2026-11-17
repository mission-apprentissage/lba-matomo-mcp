import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as r from "./_reporting";
import { mockMatomo, CONTAINER } from "./_testing";

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.MATOMO_TOKEN = "tok_test";
});

afterEach(() => {
  delete process.env.MATOMO_TOKEN;
});

// mockMatomo route sur le nom après « TagManager. » : les autres modules gardent leur nom complet.
const LIVE_CONTAINER = { ...CONTAINER, releases: [{ environment: "dev", idcontainerversion: 72 }, { environment: "live", idcontainerversion: 842 }] };

describe("liste blanche des rapports", () => {
  it.each([
    "Live.getLastVisitsDetails",
    "Live.getVisitorProfile",
    "UserCountry.getLocationFromIP",
    "API.getBulkRequest",
    "API.getProcessedReport",
    "Goals.addGoal",
    "Goals.deleteGoal",
    "TagManager.deleteContainerTrigger",
    "TagManager.publishContainerVersion",
    "UsersManager.getUsers",
    // near-miss
    "events.getCategory",
    "Events.getCategory ",
    "Events.getCategory.x",
    "Events.getcategory",
    "VisitsSummary",
  ])("refuse %j sans appel réseau", async (method) => {
    const calls = mockMatomo({});
    await expect(r.getReport(method, { period: "day", date: "yesterday" })).rejects.toThrow(/Rapport non autorisé/);
    expect(calls).toHaveLength(0);
  });

  it("accepte chaque méthode de la liste, envoyée telle quelle sur le site configuré", async () => {
    for (const method of r.REPORT_METHODS) {
      const calls = mockMatomo({ [method]: [] });
      await r.getReport(method, { period: "day", date: "yesterday" });
      expect(calls[0].body.get("method")).toBe(method);
      expect(calls[0].body.get("idSite")).toBe("7");
      expect(calls[0].body.has("idContainer")).toBe(false);
    }
  });

  it("aucune méthode de la liste n'appartient à Live, TagManager ou API", () => {
    expect(r.REPORT_METHODS.filter((m) => /^(Live|TagManager|API|UsersManager|SitesManager)\./.test(m))).toEqual([]);
    expect(r.REPORT_METHODS.every((m) => /^[A-Z][A-Za-z]+\.get[A-Za-z]*$/.test(m))).toBe(true);
  });
});

describe("période et date", () => {
  it.each(["today", "yesterday", "last30", "previous7", "last365", "2026-11-01", "2026-11-01,2026-11-17", "2026-11-01,today", "2026-11-01,yesterday"])(
    "accepte %j", async (date) => {
      mockMatomo({ "VisitsSummary.get": {} });
      await expect(r.getReport("VisitsSummary.get", { period: "range", date })).resolves.toEqual({});
    },
  );

  it.each(["last1000", "lastweek", "2026-11-01,", "2026-11-1", "last30;x", "yesterday,today", "1=1", "", "2026-11-01,2026-11-17,2026-11-18"])(
    "refuse %j sans appel réseau", async (date) => {
      const calls = mockMatomo({});
      await expect(r.getReport("VisitsSummary.get", { period: "day", date })).rejects.toThrow(/Date invalide/);
      expect(calls).toHaveLength(0);
    },
  );

  it("refuse une période inconnue", async () => {
    const calls = mockMatomo({});
    await expect(r.getReport("VisitsSummary.get", { period: "hour" as r.Period, date: "today" })).rejects.toThrow(/Période invalide/);
    expect(calls).toHaveLength(0);
  });
});

describe("paramètres transmis", () => {
  it("transmet les paramètres connus, limite à 50 par défaut", async () => {
    const calls = mockMatomo({ "Events.getCategory": [] });
    await r.getReport("Events.getCategory", {
      period: "month", date: "2026-10-01", segment: "deviceType==smartphone", flat: true, idSubtable: 3,
      filterPattern: "^search", sortColumn: "nb_events", sortOrder: "desc",
    });
    expect(Object.fromEntries(calls[0].body)).toMatchObject({
      module: "API", format: "json", method: "Events.getCategory", idSite: "7",
      period: "month", date: "2026-10-01", segment: "deviceType==smartphone", flat: "1", idSubtable: "3",
      filter_limit: "50", filter_pattern: "^search", filter_sort_column: "nb_events", filter_sort_order: "desc",
    });
  });

  it("une erreur Matomo en HTTP 200 remonte avec le nom complet de la méthode", async () => {
    mockMatomo({ "Goals.get": { result: "error", message: "idGoal inconnu" } });
    await expect(r.getReport("Goals.get", { period: "day", date: "yesterday", idGoal: 99 })).rejects.toThrow(/Matomo Goals\.get : idGoal inconnu/);
  });
});

describe("listReports", () => {
  it("ne garde que les rapports de la liste blanche", async () => {
    mockMatomo({
      "API.getReportMetadata": [
        { module: "VisitsSummary", action: "get", name: "Visites", category: "Visiteurs", metrics: { nb_visits: "Visites" } },
        { module: "Goals", action: "get", name: "Objectif candidature", parameters: { idGoal: 2 }, metrics: {} },
        { module: "Live", action: "getLastVisitsDetails", name: "Journal des visites" },
        { module: "UserCountry", action: "getCity", name: "Ville" },
      ],
    });
    const out = await r.listReports();
    expect(out.map((x) => x.method)).toEqual(["VisitsSummary.get", "Goals.get"]);
    expect(out[0].metrics).toEqual(["nb_visits"]);
    expect(out[1].parameters).toEqual({ idGoal: 2 });
  });
});

describe("checkTagActivity", () => {
  const tag = (idtag: number, name: string, category: string, action: string, status = "active", extra: Record<string, unknown> = {}) => ({
    idtag, name, type: "Matomo", status, fire_trigger_ids: [1],
    parameters: { matomoConfig: "{{Matomo Configuration}}", trackingType: "event", eventCategory: category, eventAction: action, ...extra },
  });

  const routes = (tags: unknown[], events: unknown[], extra: Record<string, unknown> = {}) => ({
    getContainer: LIVE_CONTAINER,
    getContainerTags: tags,
    "Events.getCategory": events,
    ...extra,
  });

  it("lit les balises de la version live, pas du brouillon, sur une période range", async () => {
    const calls = mockMatomo(routes([], []));
    const out = await r.checkTagActivity("last30");
    expect(out.idContainerVersion).toBe(842);
    expect(calls.find((c) => c.method === "getContainerTags")!.body.get("idContainerVersion")).toBe("842");
    expect(Object.fromEntries(calls.find((c) => c.method === "Events.getCategory")!.body)).toMatchObject({ period: "range", date: "last30", expanded: "1", filter_limit: "-1" });
  });

  it("classe balises actives, silencieuses, en pause et dynamiques", async () => {
    mockMatomo(routes(
      [
        tag(1, "search__filter_applied", "search", "filter_applied"),
        tag(2, "search__filter_dropdown_opened", "search", "filter_dropdown_opened"),
        tag(3, "search__old", "search", "old", "paused"),
        tag(4, "search__dyn", "search", "{{dlv__action}}"),
        { idtag: 5, name: "pageview", type: "Matomo", status: "active", parameters: { trackingType: "pageview" } },
        { idtag: 6, name: "html", type: "CustomHtml", status: "active", parameters: { customHtml: "<b>x</b>" } },
      ],
      [{ label: "search", nb_events: 130, subtable: [{ label: "filter_applied", nb_events: 120 }, { label: "sort_changed", nb_events: 10 }] }],
    ));
    const out = await r.checkTagActivity();
    expect(out.withEvents).toEqual([{ tag: "search__filter_applied", idtag: 1, category: "search", action: "filter_applied", events: 120 }]);
    expect(out.silent.map((t) => t.tag)).toEqual(["search__filter_dropdown_opened"]);
    expect(out.paused.map((t) => t.tag)).toEqual(["search__old"]);
    expect(out.dynamic.map((t) => t.tag)).toEqual(["search__dyn"]);
    expect(out.untagged).toEqual([{ category: "search", action: "sort_changed", events: 10 }]);
  });

  it("near-miss : même action dans une autre catégorie ne compte pas pour la balise", async () => {
    mockMatomo(routes(
      [tag(1, "search__opened", "search", "opened")],
      [{ label: "recruiter", nb_events: 50, subtable: [{ label: "opened", nb_events: 50 }] }],
    ));
    const out = await r.checkTagActivity();
    expect(out.silent.map((t) => t.tag)).toEqual(["search__opened"]);
    expect(out.untagged).toEqual([{ category: "recruiter", action: "opened", events: 50 }]);
  });

  it("near-miss : une catégorie qui préfixe une autre ne compte pas", async () => {
    mockMatomo(routes(
      [tag(1, "search__x", "search", "x")],
      [{ label: "search_v2", nb_events: 5, subtable: [{ label: "x", nb_events: 5 }] }],
    ));
    expect((await r.checkTagActivity()).silent.map((t) => t.tag)).toEqual(["search__x"]);
  });

  it("lit la sous-table par son id quand expanded ne l'inclut pas", async () => {
    const calls = mockMatomo(routes(
      [tag(1, "search__x", "search", "x")],
      [{ label: "search", nb_events: 7, idsubdatatable: 12 }],
      { "Events.getActionFromCategoryId": [{ label: "x", nb_events: "7" }] },
    ));
    const out = await r.checkTagActivity();
    expect(out.withEvents.map((t) => t.events)).toEqual([7]);
    expect(Object.fromEntries(calls.find((c) => c.method === "Events.getActionFromCategoryId")!.body)).toMatchObject({ idSubtable: "12", period: "range" });
  });

  it("refuse une date invalide sans appel réseau", async () => {
    const calls = mockMatomo({});
    await expect(r.checkTagActivity("last30;x")).rejects.toThrow(/Date invalide/);
    expect(calls).toHaveLength(0);
  });

  it("lève une erreur sans version live", async () => {
    mockMatomo({ getContainer: { ...CONTAINER, releases: [{ environment: "dev", idcontainerversion: 72 }] } });
    await expect(r.checkTagActivity()).rejects.toThrow(/live/);
  });
});
