// Entonnoirs, heatmaps, formulaires, rapports personnalisés et annotations (plugins Matomo de stats.beta.gouv.fr).
// Signatures : listAllAPI de l'instance. Les enregistrements de session ne sont jamais lus ni configurés.
import { request, type Params } from "./_matomo";
import { DATE_RE, PERIODS, type Period } from "./_reporting";

type Id = number;

// ─── configuration (lecture) ─────────────────────────────────────────────────

export const SETUP_KINDS = [
  "funnels",
  "heatmaps",
  "forms",
  "custom_reports",
  "funnel_pattern_types",
  "heatmap_page_rules",
  "custom_report_options",
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

/** Configuration d'un plugin, ou d'un élément si id est fourni (funnels, heatmaps, forms, custom_reports). */
export async function getSetup(kind: SetupKind, id?: Id): Promise<unknown> {
  switch (kind) {
    case "funnels":
      return id !== undefined ? request("Funnels.getFunnel", { idFunnel: id }, "site") : request("Funnels.getAllActivatedFunnelsForSite", {}, "site");
    case "heatmaps":
      // includePageTreeMirror=0 : sans la copie du DOM de la page, volumineuse.
      return id !== undefined
        ? request("HeatmapSessionRecording.getHeatmap", { idSiteHsr: id }, "site")
        : request("HeatmapSessionRecording.getHeatmaps", { includePageTreeMirror: 0 }, "site");
    case "forms":
      return id !== undefined ? request("FormAnalytics.getForm", { idForm: id }, "site") : request("FormAnalytics.getForms", {}, "site");
    case "custom_reports":
      return id !== undefined
        ? request("CustomReports.getConfiguredReport", { idCustomReport: id }, "site")
        : request("CustomReports.getConfiguredReports", { skipCategoryMetadata: 1 }, "site");
    case "funnel_pattern_types":
      return request("Funnels.getAvailablePatternMatches", {}, "global");
    case "heatmap_page_rules":
      return request("HeatmapSessionRecording.getAvailableTargetPageRules", {}, "global");
    case "custom_report_options": {
      const [reportTypes, categories, dimensions, metrics] = await Promise.all([
        request("CustomReports.getAvailableReportTypes", {}, "global"),
        request("CustomReports.getAvailableCategories", {}, "site"),
        request("CustomReports.getAvailableDimensions", {}, "site"),
        request("CustomReports.getAvailableMetrics", {}, "site"),
      ]);
      return { reportTypes, categories, dimensions, metrics };
    }
  }
}

// ─── validateurs Matomo (aucune écriture) ────────────────────────────────────

export interface FunnelStep {
  position: number;
  name: string;
  pattern_type: string;
  pattern: string;
  required?: boolean;
}

export interface PageRule {
  attribute: string;
  type: string;
  value: string;
  inverted?: boolean;
}

export const testFunnelSteps = (url: string, steps: FunnelStep[]) =>
  request("Funnels.testUrlMatchesSteps", { url, steps }, "global");

export const testHeatmapPageRules = (url: string, rules: PageRule[]) =>
  request("HeatmapSessionRecording.testUrlMatchPages", { url, matchPageRules: rules }, "global");

// ─── écriture ────────────────────────────────────────────────────────────────

const valueOf = (r: unknown) => (r && typeof r === "object" && "value" in r ? (r as { value: unknown }).value : r);

/** Crée (id absent : idFunnel=0) ou remplace un entonnoir hors objectif. */
export async function saveFunnel(input: { id?: Id; name: string; steps: FunnelStep[] }): Promise<unknown> {
  if (!input.steps.length) throw new Error("Un entonnoir demande au moins une étape");
  return valueOf(await request("Funnels.saveNonGoalFunnel", { idFunnel: input.id ?? 0, funnelName: input.name, steps: input.steps }, "site"));
}

export interface HeatmapInput {
  name: string;
  matchPageRules: PageRule[];
  sampleLimit?: number;
  sampleRate?: number;
  excludedElements?: string;
  screenshotUrl?: string;
  breakpointMobile?: number;
  breakpointTablet?: number;
}

// Clés lues par getHeatmap pour une mise à jour (cf. updateHeatmap).
const HEATMAP_KEYS: Record<keyof HeatmapInput, string> = {
  name: "name",
  matchPageRules: "match_page_rules",
  sampleLimit: "sample_limit",
  sampleRate: "sample_rate",
  excludedElements: "excluded_elements",
  screenshotUrl: "screenshot_url",
  breakpointMobile: "breakpoint_mobile",
  breakpointTablet: "breakpoint_tablet",
};

export async function addHeatmap(input: HeatmapInput): Promise<number> {
  if (!input.matchPageRules.length) throw new Error("Une heatmap demande au moins une règle de page");
  return Number(valueOf(await request("HeatmapSessionRecording.addHeatmap", { ...input }, "site")));
}

/**
 * updateHeatmap remplace tous les champs : on part de la heatmap actuelle. Si getHeatmap ne
 * renvoie pas une clé attendue, on refuse plutôt que de remettre le champ à sa valeur par défaut.
 */
export async function updateHeatmap(id: Id, patch: Partial<HeatmapInput>): Promise<void> {
  const cur = (await request<Record<string, unknown>>("HeatmapSessionRecording.getHeatmap", { idSiteHsr: id }, "site")) ?? {};
  const merged: Params = { idSiteHsr: id };
  const missing: string[] = [];
  for (const [field, key] of Object.entries(HEATMAP_KEYS) as [keyof HeatmapInput, string][]) {
    if (patch[field] !== undefined) merged[field] = patch[field];
    else if (key in cur) merged[field] = cur[key] ?? undefined;
    else missing.push(key);
  }
  if (missing.length) {
    throw new Error(`getHeatmap ne renvoie pas ${missing.join(", ")} : fournir ces champs explicitement pour ne pas les réinitialiser`);
  }
  await request("HeatmapSessionRecording.updateHeatmap", merged, "site");
}

export type HeatmapStatusAction = "pause" | "resume" | "end";

export async function setHeatmapStatus(id: Id, action: HeatmapStatusAction): Promise<void> {
  const method = { pause: "pauseHeatmap", resume: "resumeHeatmap", end: "endHeatmap" }[action];
  await request(`HeatmapSessionRecording.${method}`, { idSiteHsr: id }, "site");
}

export interface CustomReportInput {
  name: string;
  reportType: string;
  metricIds: string[];
  dimensionIds?: string[];
  categoryId?: string;
  subcategoryId?: string;
  description?: string;
  segmentFilter?: string;
}

export async function addCustomReport(input: CustomReportInput): Promise<number> {
  if (!input.metricIds.length) throw new Error("Un rapport personnalisé demande au moins une métrique");
  return Number(valueOf(await request("CustomReports.addCustomReport", { ...input }, "site")));
}

/**
 * updateCustomReport remplace tous les champs. Le format renvoyé par getConfiguredReport n'étant pas
 * vérifié sur l'instance, la mise à jour exige la définition complète plutôt que de la reconstituer.
 */
export async function updateCustomReport(id: Id, input: CustomReportInput): Promise<void> {
  if (!input.metricIds.length) throw new Error("Un rapport personnalisé demande au moins une métrique");
  await request("CustomReports.updateCustomReport", { idCustomReport: id, ...input }, "site");
}

// ─── annotations ─────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function listAnnotations(period: Period, date: string): Promise<unknown> {
  if (!(PERIODS as readonly string[]).includes(period) || !DATE_RE.test(date)) throw new Error(`Période ou date invalide : ${period} ${date}`);
  return request("Annotations.getAll", { period, date }, "site");
}

export async function addAnnotation(date: string, note: string, starred = false): Promise<unknown> {
  if (!DAY_RE.test(date)) throw new Error(`Date d'annotation invalide : ${date} (AAAA-MM-JJ)`);
  if (!note.trim()) throw new Error("Annotation vide");
  return request("Annotations.add", { date, note, starred }, "site");
}

/** Date du jour à Paris, fuseau du site LBA, au format AAAA-MM-JJ. */
export function todayInParis(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
