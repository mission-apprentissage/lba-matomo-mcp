import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as m from "./_matomo";
import * as pl from "./_plugins";
import { REPORT_METHODS } from "./_reporting";
import { mockMatomo } from "./_testing";

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.MATOMO_TOKEN = "tok_test";
});

afterEach(() => {
  delete process.env.MATOMO_TOKEN;
});

const itWrite = (name: string, fn: () => Promise<unknown>) => it(name, () => m.withAccess("write", fn));
const body = (calls: ReturnType<typeof mockMatomo>, method: string) => calls.find((c) => c.method === method)!.body;

// ─── garde générale du client ────────────────────────────────────────────────

describe("garde du client sur tous les modules", () => {
  it.each([
    "Annotations.delete",
    "Annotations.deleteAll",
    "Annotations.save",
    "HeatmapSessionRecording.deleteHeatmap",
    "HeatmapSessionRecording.deleteRecordedSession",
    "HeatmapSessionRecording.addSessionRecording",
    "Funnels.deleteNonGoalFunnel",
    "Funnels.setGoalFunnel",
    "CustomReports.deleteCustomReport",
    "FormAnalytics.addForm",
    "Goals.addGoal",
    "API.getBulkRequest ",
    "Events.getCategory;x",
  ])("refuse %j même en accès écriture, sans appel réseau", async (method) => {
    const calls = mockMatomo({});
    await expect(m.withAccess("write", () => m.request(method, {}, "site"))).rejects.toThrow(/ni lecture ni écriture répertoriée/);
    expect(calls).toHaveLength(0);
  });

  it.each(["Annotations.getAll", "TagManager.exportContainerVersion", "Funnels.testUrlMatchesSteps", "VisitsSummary.get"])(
    "near-miss : laisse passer la lecture %j", async (method) => {
      mockMatomo({ [method.replace(/^TagManager\./, "")]: [] });
      await expect(m.request(method, {}, "site")).resolves.toEqual([]);
    },
  );

  it.each([...m.WRITE_METHODS])("%s est refusé en accès lecture, sans appel réseau", async (method) => {
    const calls = mockMatomo({});
    await expect(m.request(method, {}, "site")).rejects.toBeInstanceOf(m.ReadOnlyError);
    expect(calls).toHaveLength(0);
  });

  it("aucune suppression ni enregistrement de session parmi les écritures et les rapports", () => {
    const action = (method: string) => method.split(".")[1];
    expect([...m.WRITE_METHODS].filter((w) => !w.startsWith("TagManager.") && /^delete|SessionRecording|RecordedSession/.test(action(w)))).toEqual([]);
    expect(REPORT_METHODS.filter((r) => r.startsWith("Live.") || /SessionRecording|RecordedSession/.test(action(r)))).toEqual([]);
  });
});

// ─── configuration ───────────────────────────────────────────────────────────

describe("getSetup", () => {
  it.each([
    ["funnels", undefined, "Funnels.getAllActivatedFunnelsForSite", {}],
    ["funnels", 3, "Funnels.getFunnel", { idFunnel: "3" }],
    ["heatmaps", undefined, "HeatmapSessionRecording.getHeatmaps", { includePageTreeMirror: "0" }],
    ["heatmaps", 4, "HeatmapSessionRecording.getHeatmap", { idSiteHsr: "4" }],
    ["forms", undefined, "FormAnalytics.getForms", {}],
    ["forms", 5, "FormAnalytics.getForm", { idForm: "5" }],
    ["custom_reports", undefined, "CustomReports.getConfiguredReports", { skipCategoryMetadata: "1" }],
    ["custom_reports", 6, "CustomReports.getConfiguredReport", { idCustomReport: "6" }],
  ] as const)("%s %s → %s sur le site", async (kind, id, method, params) => {
    const calls = mockMatomo({ [method]: [] });
    await pl.getSetup(kind, id);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({ method, idSite: "7", ...params });
  });

  it("référentiels sans idSite, options de rapport sur le site", async () => {
    const calls = mockMatomo({
      "Funnels.getAvailablePatternMatches": [],
      "HeatmapSessionRecording.getAvailableTargetPageRules": [],
      "CustomReports.getAvailableReportTypes": [], "CustomReports.getAvailableCategories": [],
      "CustomReports.getAvailableDimensions": [], "CustomReports.getAvailableMetrics": [],
    });
    await pl.getSetup("funnel_pattern_types");
    await pl.getSetup("heatmap_page_rules");
    const opts = await pl.getSetup("custom_report_options");
    expect(opts).toEqual({ reportTypes: [], categories: [], dimensions: [], metrics: [] });
    expect(body(calls, "Funnels.getAvailablePatternMatches").has("idSite")).toBe(false);
    expect(body(calls, "CustomReports.getAvailableReportTypes").has("idSite")).toBe(false);
    expect(body(calls, "CustomReports.getAvailableMetrics").get("idSite")).toBe("7");
  });
});

// ─── validateurs ─────────────────────────────────────────────────────────────

describe("validateurs", () => {
  const steps = [{ position: 1, name: "Recherche", pattern_type: "path_starts_with", pattern: "/recherche", required: true }];
  const rules = [{ attribute: "path", type: "starts_with", value: "/recherche", inverted: false }];

  it("test_funnel_steps encode les étapes en tableau PHP, en lecture", async () => {
    const calls = mockMatomo({ "Funnels.testUrlMatchesSteps": [] });
    await pl.testFunnelSteps("https://lba.example.test/recherche", steps);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({
      url: "https://lba.example.test/recherche",
      "steps[0][position]": "1", "steps[0][name]": "Recherche", "steps[0][pattern_type]": "path_starts_with",
      "steps[0][pattern]": "/recherche", "steps[0][required]": "1",
    });
  });

  it("test_heatmap_page_rules encode les règles", async () => {
    const calls = mockMatomo({ "HeatmapSessionRecording.testUrlMatchPages": [] });
    await pl.testHeatmapPageRules("https://lba.example.test/", rules);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({
      "matchPageRules[0][attribute]": "path", "matchPageRules[0][type]": "starts_with",
      "matchPageRules[0][value]": "/recherche", "matchPageRules[0][inverted]": "0",
    });
  });
});

// ─── écritures ───────────────────────────────────────────────────────────────

describe("entonnoirs", () => {
  const steps = [
    { position: 1, name: "Recherche", pattern_type: "path_starts_with", pattern: "/recherche" },
    { position: 2, name: "Candidature", pattern_type: "path_contains", pattern: "/candidature" },
  ];

  itWrite("création : idFunnel=0, nom et étapes", async () => {
    const calls = mockMatomo({ "Funnels.saveNonGoalFunnel": { value: 9 } });
    await expect(pl.saveFunnel({ name: "Recherche → candidature", steps })).resolves.toBe(9);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({
      idSite: "7", idFunnel: "0", funnelName: "Recherche → candidature",
      "steps[1][position]": "2", "steps[1][pattern_type]": "path_contains", "steps[1][pattern]": "/candidature",
    });
  });

  itWrite("remplacement : idFunnel transmis", async () => {
    const calls = mockMatomo({ "Funnels.saveNonGoalFunnel": { value: 9 } });
    await pl.saveFunnel({ id: 9, name: "x", steps });
    expect(calls[0].body.get("idFunnel")).toBe("9");
  });

  itWrite("refuse un entonnoir sans étape, sans appel réseau", async () => {
    const calls = mockMatomo({});
    await expect(pl.saveFunnel({ name: "x", steps: [] })).rejects.toThrow(/au moins une étape/);
    expect(calls).toHaveLength(0);
  });

  it("refusé en accès lecture", async () => {
    const calls = mockMatomo({});
    await expect(pl.saveFunnel({ name: "x", steps })).rejects.toBeInstanceOf(m.ReadOnlyError);
    expect(calls).toHaveLength(0);
  });
});

describe("heatmaps", () => {
  const rules = [{ attribute: "url", type: "equals_simple", value: "https://lba.example.test/" }];
  const CURRENT = {
    idsitehsr: 4, name: "Accueil", match_page_rules: rules, sample_limit: 2000, sample_rate: 10,
    excluded_elements: ".chat", screenshot_url: "https://lba.example.test/shot", breakpoint_mobile: 600, breakpoint_tablet: null,
  };

  itWrite("création : champs en camelCase, règles encodées", async () => {
    const calls = mockMatomo({ "HeatmapSessionRecording.addHeatmap": { value: 12 } });
    await expect(pl.addHeatmap({ name: "Accueil", matchPageRules: rules, sampleRate: 5 })).resolves.toBe(12);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({
      idSite: "7", name: "Accueil", sampleRate: "5",
      "matchPageRules[0][attribute]": "url", "matchPageRules[0][type]": "equals_simple", "matchPageRules[0][value]": "https://lba.example.test/",
    });
  });

  itWrite("modification : part de la heatmap actuelle, le patch l'emporte", async () => {
    const calls = mockMatomo({ "HeatmapSessionRecording.getHeatmap": CURRENT, "HeatmapSessionRecording.updateHeatmap": { result: "success" } });
    await pl.updateHeatmap(4, { sampleRate: 50 });
    const up = Object.fromEntries(body(calls, "HeatmapSessionRecording.updateHeatmap"));
    expect(up).toMatchObject({
      idSiteHsr: "4", name: "Accueil", sampleRate: "50", sampleLimit: "2000", excludedElements: ".chat",
      screenshotUrl: "https://lba.example.test/shot", breakpointMobile: "600", "matchPageRules[0][value]": "https://lba.example.test/",
    });
    expect(up).not.toHaveProperty("breakpointTablet");
  });

  itWrite("modification refusée si getHeatmap ne renvoie pas une clé attendue, sans écrire", async () => {
    const { sample_limit: _drop, ...partial } = CURRENT;
    const calls = mockMatomo({ "HeatmapSessionRecording.getHeatmap": partial, "HeatmapSessionRecording.updateHeatmap": { result: "success" } });
    await expect(pl.updateHeatmap(4, { name: "x" })).rejects.toThrow(/sample_limit/);
    expect(calls.map((c) => c.method)).not.toContain("HeatmapSessionRecording.updateHeatmap");
  });

  itWrite("near-miss : une clé absente mais fournie dans le patch n'est pas bloquante", async () => {
    const { sample_limit: _drop, ...partial } = CURRENT;
    const calls = mockMatomo({ "HeatmapSessionRecording.getHeatmap": partial, "HeatmapSessionRecording.updateHeatmap": { result: "success" } });
    await pl.updateHeatmap(4, { sampleLimit: 500 });
    expect(body(calls, "HeatmapSessionRecording.updateHeatmap").get("sampleLimit")).toBe("500");
  });

  it.each([["pause", "pauseHeatmap"], ["resume", "resumeHeatmap"], ["end", "endHeatmap"]] as const)("statut %s → %s", async (action, method) => {
    const calls = mockMatomo({ [`HeatmapSessionRecording.${method}`]: { result: "success" } });
    await m.withAccess("write", () => pl.setHeatmapStatus(4, action));
    expect(Object.fromEntries(calls[0].body)).toMatchObject({ method: `HeatmapSessionRecording.${method}`, idSiteHsr: "4" });
  });
});

describe("rapports personnalisés", () => {
  const def = { name: "Candidatures par région", reportType: "table", metricIds: ["nb_visits", "nb_events"], dimensionIds: ["UserCountry.Region"], categoryId: "General_Visitors" };

  itWrite("création : listes encodées en []", async () => {
    const calls = mockMatomo({ "CustomReports.addCustomReport": { value: 3 } });
    await expect(pl.addCustomReport(def)).resolves.toBe(3);
    const b = calls[0].body;
    expect(b.getAll("metricIds[]")).toEqual(["nb_visits", "nb_events"]);
    expect(b.getAll("dimensionIds[]")).toEqual(["UserCountry.Region"]);
    expect(Object.fromEntries(b)).toMatchObject({ name: "Candidatures par région", reportType: "table", categoryId: "General_Visitors" });
  });

  itWrite("remplacement : idCustomReport et définition complète", async () => {
    const calls = mockMatomo({ "CustomReports.updateCustomReport": { result: "success" } });
    await pl.updateCustomReport(3, def);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({ idCustomReport: "3", name: "Candidatures par région" });
  });

  itWrite("refuse un rapport sans métrique", async () => {
    const calls = mockMatomo({});
    await expect(pl.addCustomReport({ ...def, metricIds: [] })).rejects.toThrow(/métrique/);
    await expect(pl.updateCustomReport(3, { ...def, metricIds: [] })).rejects.toThrow(/métrique/);
    expect(calls).toHaveLength(0);
  });
});

describe("annotations", () => {
  itWrite("ajoute une annotation datée", async () => {
    const calls = mockMatomo({ "Annotations.add": { idNote: 1 } });
    await pl.addAnnotation("2026-11-17", "Tag Manager : version 843 publiée en live", true);
    expect(Object.fromEntries(calls[0].body)).toMatchObject({ idSite: "7", date: "2026-11-17", note: "Tag Manager : version 843 publiée en live", starred: "1" });
  });

  it.each(["today", "2026-11-1", "17/11/2026", "2026-11-17,2026-11-18"])("refuse la date %j sans appel réseau", async (d) => {
    const calls = mockMatomo({});
    await expect(m.withAccess("write", () => pl.addAnnotation(d, "x"))).rejects.toThrow(/Date d'annotation invalide/);
    expect(calls).toHaveLength(0);
  });

  itWrite("refuse une note vide", async () => {
    await expect(pl.addAnnotation("2026-11-17", "   ")).rejects.toThrow(/vide/);
  });

  it("liste les annotations sur une période valide", async () => {
    const calls = mockMatomo({ "Annotations.getAll": { "7": [] } });
    await pl.listAnnotations("range", "last90");
    expect(Object.fromEntries(calls[0].body)).toMatchObject({ method: "Annotations.getAll", idSite: "7", period: "range", date: "last90" });
    await expect(pl.listAnnotations("range", "last90;x")).rejects.toThrow(/invalide/);
  });

  it.each([
    ["2026-11-17T22:59:00Z", "2026-11-17"], // 23:59 à Paris (UTC+1)
    ["2026-11-17T23:00:00Z", "2026-11-18"], // minuit à Paris
    ["2026-07-01T21:59:00Z", "2026-07-01"], // 23:59 en heure d'été (UTC+2)
    ["2026-07-01T22:00:00Z", "2026-07-02"],
  ])("todayInParis(%s) = %s", (iso, expected) => {
    expect(pl.todayInParis(new Date(iso))).toBe(expected);
  });
});
