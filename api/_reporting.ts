// Statistiques agrégées via l'API de reporting Matomo (lecture seule, site MATOMO_ID_SITE).
import { request, getContainer, listTags, type Params, type Tag } from "./_matomo";

/**
 * Liste blanche explicite (signatures lues dans Matomo 5.14.1). Exclus volontairement :
 * Live.* (visites individuelles, identifiants de visiteurs), UserCountry.getLocationFromIP,
 * API.getBulkRequest (enchaînerait n'importe quelle méthode) et toute méthode d'écriture.
 */
export const REPORT_METHODS = [
  "VisitsSummary.get",
  "VisitFrequency.get",
  "Actions.get",
  "Actions.getPageUrls",
  "Actions.getPageTitles",
  "Actions.getEntryPageUrls",
  "Actions.getExitPageUrls",
  "Actions.getOutlinks",
  "Actions.getDownloads",
  "Actions.getSiteSearchKeywords",
  "Actions.getSiteSearchNoResultKeywords",
  "Events.getCategory",
  "Events.getAction",
  "Events.getName",
  "Events.getActionFromCategoryId",
  "Events.getNameFromCategoryId",
  "Events.getNameFromActionId",
  "Referrers.get",
  "Referrers.getReferrerType",
  "Referrers.getAll",
  "Referrers.getWebsites",
  "Referrers.getSearchEngines",
  "Referrers.getSocials",
  "Referrers.getCampaigns",
  "Referrers.getAIAssistants",
  "Goals.get",
  "CustomDimensions.getCustomDimension",
  "DevicesDetection.getType",
  "DevicesDetection.getOsFamilies",
  "DevicesDetection.getBrowsers",
  "UserCountry.getCountry",
  "UserCountry.getRegion",
  "VisitTime.getVisitInformationPerLocalTime",
  "VisitTime.getByDayOfWeek",
  "Contents.getContentNames",
  "Contents.getContentPieces",
] as const;

export type ReportMethod = (typeof REPORT_METHODS)[number];

export const PERIODS = ["day", "week", "month", "year", "range"] as const;
export type Period = (typeof PERIODS)[number];

// today, yesterday, lastN, previousN, AAAA-MM-JJ, ou intervalle AAAA-MM-JJ,(AAAA-MM-JJ|today|yesterday).
export const DATE_RE = /^(today|yesterday|(last|previous)\d{1,3}|\d{4}-\d{2}-\d{2}(,(\d{4}-\d{2}-\d{2}|today|yesterday))?)$/;

export function isReportMethod(m: string): m is ReportMethod {
  return (REPORT_METHODS as readonly string[]).includes(m);
}

export interface ReportQuery {
  period: Period;
  date: string;
  segment?: string;
  flat?: boolean;
  expanded?: boolean;
  idSubtable?: number;
  idGoal?: number;
  idDimension?: number;
  /** filter_limit : 50 par défaut. */
  limit?: number;
  filterPattern?: string;
  sortColumn?: string;
  sortOrder?: "asc" | "desc";
}

function checkPeriod(period: string, date: string): void {
  if (!(PERIODS as readonly string[]).includes(period)) throw new Error(`Période invalide : ${period}`);
  if (!DATE_RE.test(date)) throw new Error(`Date invalide : ${date} (today, yesterday, last30, previous7, 2026-11-01 ou 2026-11-01,2026-11-17)`);
}

/** Appelle un rapport de la liste blanche. Seuls les paramètres connus sont transmis. */
export async function getReport<T = unknown>(method: string, q: ReportQuery): Promise<T> {
  if (!isReportMethod(method)) throw new Error(`Rapport non autorisé : ${method}`);
  checkPeriod(q.period, q.date);
  const params: Params = {
    period: q.period,
    date: q.date,
    segment: q.segment,
    flat: q.flat,
    expanded: q.expanded,
    idSubtable: q.idSubtable,
    idGoal: q.idGoal,
    idDimension: q.idDimension,
    filter_limit: q.limit ?? 50,
    filter_pattern: q.filterPattern,
    filter_sort_column: q.sortColumn,
    filter_sort_order: q.sortOrder,
  };
  return request<T>(method, params, "site");
}

// ─── catalogue ───────────────────────────────────────────────────────────────

interface ReportMetadata {
  category?: string;
  subcategory?: string;
  name?: string;
  module?: string;
  action?: string;
  dimension?: string;
  metrics?: Record<string, string>;
  parameters?: Record<string, unknown>;
  documentation?: string;
}

/**
 * Rapports disponibles sur le site, limités à la liste blanche. Les entrées Goals.get et
 * CustomDimensions.getCustomDimension portent leurs paramètres (idGoal, idDimension).
 */
export async function listReports() {
  const all = await request<ReportMetadata[]>("API.getReportMetadata", { hideMetricsDoc: true }, "site");
  return all
    .filter((r) => isReportMethod(`${r.module}.${r.action}`))
    .map((r) => ({
      method: `${r.module}.${r.action}`,
      name: r.name,
      category: r.category,
      subcategory: r.subcategory,
      dimension: r.dimension,
      metrics: r.metrics ? Object.keys(r.metrics) : [],
      parameters: r.parameters,
    }));
}

export async function listGoalsAndDimensions() {
  const [goals, dimensions] = await Promise.all([
    request<unknown[]>("Goals.getGoals", {}, "site"),
    request<unknown[]>("CustomDimensions.getConfiguredCustomDimensions", {}, "site"),
  ]);
  return { goals, dimensions };
}

// ─── croisement configuration / données ──────────────────────────────────────

interface EventRow {
  label: string;
  nb_events?: number | string;
  idsubdatatable?: number;
  subtable?: EventRow[];
}

export interface TagActivity {
  tag: string;
  idtag: number;
  category: string;
  action: string;
  events: number;
}

export interface TagActivityReport {
  idContainerVersion: number;
  date: string;
  withEvents: TagActivity[];
  /** Balises actives sans aucun événement reçu sur la période. */
  silent: TagActivity[];
  paused: TagActivity[];
  /** Catégorie ou action alimentée par une variable {{…}} : pas de correspondance statique possible. */
  dynamic: { tag: string; idtag: number; category: string; action: string }[];
  /** Couples catégorie/action reçus qu'aucune balise à valeurs fixes ne déclare. */
  untagged: { category: string; action: string; events: number }[];
}

const isDynamic = (v: string) => v.includes("{{");
const key = (category: string, action: string) => JSON.stringify([category, action]);

/** Version publiée en live : c'est elle que chargent les visiteurs, pas le brouillon. */
export async function getLiveVersionId(): Promise<number> {
  const c = await getContainer();
  const releases = (c.releases ?? []) as { environment?: string; idcontainerversion?: number | string }[];
  const live = releases.find((r) => r.environment === "live");
  const id = Number(live?.idcontainerversion);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Aucune version publiée en live");
  return id;
}

/** Nombre d'événements par couple (catégorie, action) sur la période. */
async function eventCounts(date: string): Promise<Map<string, number>> {
  const rows = await getReport<EventRow[]>("Events.getCategory", { period: "range", date, expanded: true, limit: -1 });
  const counts = new Map<string, number>();
  for (const cat of rows) {
    // expanded=1 inclut les actions dans `subtable` ; sinon on lit la sous-table par son id.
    let actions = cat.subtable;
    if (!actions && cat.idsubdatatable !== undefined) {
      actions = await getReport<EventRow[]>("Events.getActionFromCategoryId", { period: "range", date, idSubtable: cat.idsubdatatable, limit: -1 });
    }
    for (const a of actions ?? []) counts.set(key(cat.label, a.label), Number(a.nb_events ?? 0));
  }
  return counts;
}

/**
 * Compare les balises événement de la version live aux événements réellement reçus :
 * balises silencieuses, en pause, dynamiques, et événements reçus sans balise déclarée.
 */
export async function checkTagActivity(date = "last30"): Promise<TagActivityReport> {
  checkPeriod("range", date);
  const idContainerVersion = await getLiveVersionId();
  const [tags, counts] = await Promise.all([listTags(idContainerVersion), eventCounts(date)]);

  const report: TagActivityReport = { idContainerVersion, date, withEvents: [], silent: [], paused: [], dynamic: [], untagged: [] };
  const declared = new Set<string>();

  const eventTags = tags.filter((t: Tag) => t.type === "Matomo" && (t.parameters as Record<string, unknown> | undefined)?.trackingType === "event");
  for (const t of eventTags) {
    const p = t.parameters as Record<string, unknown>;
    const category = String(p.eventCategory ?? "");
    const action = String(p.eventAction ?? "");
    const idtag = Number(t.idtag);
    if (isDynamic(category) || isDynamic(action)) {
      report.dynamic.push({ tag: t.name, idtag, category, action });
      continue;
    }
    declared.add(key(category, action));
    const activity: TagActivity = { tag: t.name, idtag, category, action, events: counts.get(key(category, action)) ?? 0 };
    if (t.status === "paused") report.paused.push(activity);
    else if (activity.events > 0) report.withEvents.push(activity);
    else report.silent.push(activity);
  }

  for (const [k, events] of counts) {
    if (declared.has(k)) continue;
    const [category, action] = JSON.parse(k) as [string, string];
    report.untagged.push({ category, action, events });
  }
  report.withEvents.sort((a, b) => b.events - a.events);
  report.untagged.sort((a, b) => b.events - a.events);
  return report;
}
