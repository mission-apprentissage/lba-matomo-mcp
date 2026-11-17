import { AsyncLocalStorage } from "async_hooks";

// Client de l'API HTTP Matomo, module TagManager (Matomo 5.14.1 sur stats.beta.gouv.fr).
// Toutes les écritures visent le brouillon du conteneur, résolu via getContainer → draft.idcontainerversion.

export type Params = Record<string, unknown>;

export interface MatomoConfig {
  endpoint: string;
  token: string;
  idSite: string;
  idContainer: string;
}

export function getConfig(): MatomoConfig {
  const baseUrl = (process.env.MATOMO_URL || "https://stats.beta.gouv.fr").replace(/\/+$/, "");
  return {
    endpoint: `${baseUrl}/index.php`,
    token: process.env.MATOMO_TOKEN ?? "",
    idSite: process.env.MATOMO_ID_SITE || "7",
    idContainer: process.env.MATOMO_ID_CONTAINER || "s4n03ZE1",
  };
}

// ─── droit d'écriture par requête ────────────────────────────────────────────

export type Access = "read" | "write";

const accessStore = new AsyncLocalStorage<Access>();

/** Exécute fn avec le droit donné par le secret de la requête MCP (cf. authenticate dans mcp.ts). */
export function withAccess<T>(access: Access, fn: () => T): T {
  return accessStore.run(access, fn);
}

export function currentAccess(): Access {
  return accessStore.getStore() ?? "read";
}

export class MatomoApiError extends Error {
  constructor(message: string, readonly method: string) {
    super(`Matomo TagManager.${method} : ${message}`);
    this.name = "MatomoApiError";
  }
}

export class ReadOnlyError extends Error {
  constructor(method: string) {
    super(`Accès en lecture seule : TagManager.${method} refusé (écriture réservée au secret MCP_WRITE_SECRET)`);
    this.name = "ReadOnlyError";
  }
}

// ─── encodage ────────────────────────────────────────────────────────────────

/**
 * Encode en application/x-www-form-urlencoded avec la syntaxe de tableaux PHP,
 * seule forme que l'API de reporting Matomo comprend (pas de JSON dans le corps) :
 * `parameters[eventName]=x`, `fireTriggerIds[]=1`, `conditions[0][actual]=y`.
 * Tableaux et objets vides, null et undefined sont omis : Matomo applique alors la valeur par défaut de la signature.
 * URLSearchParams encode les crochets (%5B%5D) : PHP les décode avant de lire le tableau (vérifié sur
 * stats.beta.gouv.fr avec API.getBulkRequest et `urls%5B0%5D`).
 */
export function encodeParams(params: Params): URLSearchParams {
  const out = new URLSearchParams();
  const append = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      const scalars = value.every((v) => v === null || typeof v !== "object");
      value.forEach((v, i) => append(scalars ? `${key}[]` : `${key}[${i}]`, v));
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) append(`${key}[${k}]`, v);
      return;
    }
    if (typeof value === "boolean") {
      out.append(key, value ? "1" : "0");
      return;
    }
    out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(params)) append(k, v);
  return out;
}

// ─── masquage des sorties ────────────────────────────────────────────────────

// release_login / created_by contiennent l'identifiant Matomo, une adresse e-mail.
const REDACTED_KEYS = new Set(["release_login", "created_by", "updated_by", "login", "email", "token_auth"]);
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const EMAIL_MASK = "[e-mail masqué]";

/** Retire les identifiants de personnes et masque toute adresse e-mail avant de renvoyer une donnée à un agent. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k)) continue;
      out[k] = redact(v);
    }
    return out as T;
  }
  if (typeof value === "string") return value.replace(EMAIL_RE, EMAIL_MASK) as T;
  return value;
}

function scrubToken(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

// ─── appel bas niveau ────────────────────────────────────────────────────────

type Scope = "global" | "site" | "container";

const WRITE_METHODS = new Set([
  "addContainerTrigger", "updateContainerTrigger", "deleteContainerTrigger",
  "addContainerTag", "updateContainerTag", "deleteContainerTag", "pauseContainerTag", "resumeContainerTag",
  "addContainerVariable", "updateContainerVariable", "deleteContainerVariable",
  "createContainerVersion", "publishContainerVersion",
]);

export async function call<T = unknown>(method: string, params: Params = {}, scope: Scope = "container"): Promise<T> {
  const cfg = getConfig();
  if (WRITE_METHODS.has(method) && currentAccess() !== "write") throw new ReadOnlyError(method);
  if (!cfg.token) throw new MatomoApiError("MATOMO_TOKEN non configuré", method);

  // Site, conteneur et méthode viennent toujours de la configuration, jamais des paramètres d'un outil.
  const fields: Params = { ...params, module: "API", format: "json", method: `TagManager.${method}` };
  delete fields.idSite;
  delete fields.idContainer;
  if (scope !== "global") fields.idSite = cfg.idSite;
  if (scope === "container") fields.idContainer = cfg.idContainer;
  const body = encodeParams(fields);

  // Une valeur relue via le MCP a ses e-mails masqués (cf. redact) : la réécrire remplacerait l'adresse d'origine.
  if (WRITE_METHODS.has(method) && [...body.values()].some((v) => v.includes(EMAIL_MASK))) {
    throw new MatomoApiError(`un paramètre contient « ${EMAIL_MASK} », texte masqué par une lecture : renvoyer la valeur d'origine ou omettre le champ`, method);
  }

  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MatomoApiError(`HTTP ${res.status} — ${scrubToken(text.slice(0, 300), cfg.token)}`, method);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MatomoApiError(`réponse non JSON — ${scrubToken(text.slice(0, 300), cfg.token)}`, method);
  }

  // Matomo renvoie ses erreurs (droits, validation) en HTTP 200 avec ce corps.
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { result?: unknown }).result === "error") {
    const message = String((data as { message?: unknown }).message ?? "erreur sans message");
    throw new MatomoApiError(scrubToken(message, cfg.token), method);
  }
  return data as T;
}

// ─── types renvoyés (snake_case en sortie) ───────────────────────────────────

type Id = number | string;

export interface Condition { actual: string; comparison: string; expected: string }

export interface Trigger {
  idtrigger: Id;
  type: string;
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | unknown[];
  conditions?: Condition[];
}

export interface Tag {
  idtag: Id;
  type: string;
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | unknown[];
  fire_trigger_ids?: Id[];
  block_trigger_ids?: Id[];
  fire_limit?: string;
  fire_delay?: number;
  priority?: number;
  start_date?: string | null;
  end_date?: string | null;
  status?: string;
}

export interface Variable {
  idvariable: Id;
  type: string;
  name: string;
  description?: string;
  parameters?: Record<string, unknown> | unknown[];
  default_value?: unknown;
  lookup_table?: unknown[];
}

export interface Container {
  idcontainer: string;
  name?: string;
  draft?: { idcontainerversion?: Id };
  [k: string]: unknown;
}

interface ValueResponse { value: unknown }

function valueOf(r: unknown): unknown {
  return r && typeof r === "object" && "value" in r ? (r as ValueResponse).value : r;
}

// L'API renvoie `[]` pour un dictionnaire vide.
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ─── lecture ─────────────────────────────────────────────────────────────────

export const getContainer = () => call<Container>("getContainer");
export const getContainerVersions = () => call<unknown[]>("getContainerVersions");
export const getContainerVersion = (idContainerVersion: Id) => call("getContainerVersion", { idContainerVersion });

/** Id de la version brouillon : la seule dans laquelle ce serveur écrit. */
export async function getDraftVersionId(): Promise<number> {
  const container = await getContainer();
  const id = Number(container?.draft?.idcontainerversion);
  if (!Number.isInteger(id) || id <= 0) {
    throw new MatomoApiError("brouillon introuvable (draft.idcontainerversion absent)", "getContainer");
  }
  return id;
}

async function versionOrDraft(idContainerVersion?: Id): Promise<number> {
  return idContainerVersion !== undefined ? Number(idContainerVersion) : getDraftVersionId();
}

export async function listTriggers(v?: Id) {
  return call<Trigger[]>("getContainerTriggers", { idContainerVersion: await versionOrDraft(v) });
}
export async function getTrigger(idTrigger: Id, v?: Id) {
  return call<Trigger>("getContainerTrigger", { idContainerVersion: await versionOrDraft(v), idTrigger });
}
export async function listTags(v?: Id) {
  return call<Tag[]>("getContainerTags", { idContainerVersion: await versionOrDraft(v) });
}
export async function getTag(idTag: Id, v?: Id) {
  return call<Tag>("getContainerTag", { idContainerVersion: await versionOrDraft(v), idTag });
}
export async function listVariables(v?: Id) {
  return call<Variable[]>("getContainerVariables", { idContainerVersion: await versionOrDraft(v) });
}
export async function listAvailableVariables(v?: Id) {
  return call<unknown[]>("getAvailableContainerVariables", { idContainerVersion: await versionOrDraft(v) });
}
export async function getVariable(idVariable: Id, v?: Id) {
  return call<Variable>("getContainerVariable", { idContainerVersion: await versionOrDraft(v), idVariable });
}
export async function getTriggerReferences(idTrigger: Id, v?: Id) {
  return call<unknown[]>("getContainerTriggerReferences", { idContainerVersion: await versionOrDraft(v), idTrigger });
}
export async function getVariableReferences(idVariable: Id, v?: Id) {
  return call<unknown[]>("getContainerVariableReferences", { idContainerVersion: await versionOrDraft(v), idVariable });
}
export async function exportVersion(v?: Id) {
  return call("exportContainerVersion", { idContainerVersion: await versionOrDraft(v) });
}

export interface OrphanReport {
  idContainerVersion: number;
  tags: number;
  triggers: number;
  orphans: Trigger[];
  /** Déclencheurs référencés uniquement par des balises en pause. */
  pausedOnly: Trigger[];
}

/**
 * Un déclencheur est orphelin si aucune balise ne le cite, ni en déclenchement
 * (fire_trigger_ids) ni en blocage (block_trigger_ids). Calcul local sur deux
 * lectures plutôt qu'un getContainerTriggerReferences par déclencheur.
 */
export async function findOrphanTriggers(v?: Id): Promise<OrphanReport> {
  const idContainerVersion = await versionOrDraft(v);
  const [tags, triggers] = await Promise.all([listTags(idContainerVersion), listTriggers(idContainerVersion)]);
  const refs = (tag: Tag) => [...(tag.fire_trigger_ids ?? []), ...(tag.block_trigger_ids ?? [])].map(String);
  const all = new Set(tags.flatMap(refs));
  const active = new Set(tags.filter((t) => t.status !== "paused").flatMap(refs));
  return {
    idContainerVersion,
    tags: tags.length,
    triggers: triggers.length,
    orphans: triggers.filter((t) => !all.has(String(t.idtrigger))),
    pausedOnly: triggers.filter((t) => all.has(String(t.idtrigger)) && !active.has(String(t.idtrigger))),
  };
}

// Référentiels : pas d'idSite, accessibles avec un simple accès view.
export const getAvailableContexts = () => call("getAvailableContexts", {}, "global");
export const getAvailableEnvironments = () => call("getAvailableEnvironments", {}, "global");
export const getAvailableEnvironmentsWithPublishCapability = () => call("getAvailableEnvironmentsWithPublishCapability", {}, "site");
export const getAvailableTagFireLimits = () => call("getAvailableTagFireLimits", {}, "global");
export const getAvailableComparisons = () => call("getAvailableComparisons", {}, "global");
export const getAvailableTagTypes = (idContext = "web") => call("getAvailableTagTypesInContext", { idContext }, "global");
export const getAvailableTriggerTypes = (idContext = "web") => call("getAvailableTriggerTypesInContext", { idContext }, "global");
export const getAvailableVariableTypes = (idContext = "web") => call("getAvailableVariableTypesInContext", { idContext }, "global");

// ─── écriture (brouillon uniquement) ─────────────────────────────────────────

export interface TriggerInput {
  type: string;
  name: string;
  parameters?: Record<string, unknown>;
  conditions?: Condition[];
  description?: string;
}

export async function addTrigger(input: TriggerInput): Promise<number> {
  const idContainerVersion = await getDraftVersionId();
  return Number(valueOf(await call("addContainerTrigger", { idContainerVersion, ...input })));
}

/** L'API remplace parameters et conditions en entier : on part du déclencheur existant. */
export async function updateTrigger(idTrigger: Id, patch: Partial<Omit<TriggerInput, "type">>): Promise<void> {
  const idContainerVersion = await getDraftVersionId();
  const cur = await getTrigger(idTrigger, idContainerVersion);
  await call("updateContainerTrigger", {
    idContainerVersion,
    idTrigger,
    name: patch.name ?? cur.name,
    parameters: patch.parameters ?? asObject(cur.parameters),
    conditions: patch.conditions ?? cur.conditions ?? [],
    description: patch.description ?? cur.description ?? "",
  });
}

export async function deleteTrigger(idTrigger: Id): Promise<void> {
  await call("deleteContainerTrigger", { idContainerVersion: await getDraftVersionId(), idTrigger });
}

export interface TagInput {
  type: string;
  name: string;
  parameters?: Record<string, unknown>;
  fireTriggerIds: Id[];
  blockTriggerIds?: Id[];
  fireLimit?: string;
  fireDelay?: number;
  priority?: number;
  startDate?: string | null;
  endDate?: string | null;
  description?: string;
  status?: "active" | "paused";
}

export async function addTag(input: TagInput): Promise<number> {
  if (!input.fireTriggerIds.length) throw new Error("Une balise demande au moins un déclencheur (fireTriggerIds)");
  const idContainerVersion = await getDraftVersionId();
  return Number(valueOf(await call("addContainerTag", { idContainerVersion, ...input })));
}

/** L'API remplace tous les champs : les champs omis du patch reprennent la valeur actuelle de la balise. */
export async function updateTag(idTag: Id, patch: Partial<Omit<TagInput, "type" | "status">>): Promise<void> {
  const idContainerVersion = await getDraftVersionId();
  const cur = await getTag(idTag, idContainerVersion);
  const fireTriggerIds = patch.fireTriggerIds ?? cur.fire_trigger_ids ?? [];
  if (!fireTriggerIds.length) throw new Error("Une balise demande au moins un déclencheur (fireTriggerIds)");
  await call("updateContainerTag", {
    idContainerVersion,
    idTag,
    name: patch.name ?? cur.name,
    parameters: patch.parameters ?? asObject(cur.parameters),
    fireTriggerIds,
    blockTriggerIds: patch.blockTriggerIds ?? cur.block_trigger_ids ?? [],
    fireLimit: patch.fireLimit ?? cur.fire_limit,
    fireDelay: patch.fireDelay ?? cur.fire_delay,
    priority: patch.priority ?? cur.priority,
    startDate: patch.startDate !== undefined ? patch.startDate : cur.start_date,
    endDate: patch.endDate !== undefined ? patch.endDate : cur.end_date,
    description: patch.description ?? cur.description ?? "",
  });
}

export async function deleteTag(idTag: Id): Promise<void> {
  await call("deleteContainerTag", { idContainerVersion: await getDraftVersionId(), idTag });
}
export async function pauseTag(idTag: Id): Promise<void> {
  await call("pauseContainerTag", { idContainerVersion: await getDraftVersionId(), idTag });
}
export async function resumeTag(idTag: Id): Promise<void> {
  await call("resumeContainerTag", { idContainerVersion: await getDraftVersionId(), idTag });
}

export interface VariableInput {
  type: string;
  name: string;
  parameters?: Record<string, unknown>;
  defaultValue?: string;
  lookupTable?: unknown[];
  description?: string;
}

export async function addVariable(input: VariableInput): Promise<number> {
  const idContainerVersion = await getDraftVersionId();
  return Number(valueOf(await call("addContainerVariable", { idContainerVersion, ...input })));
}

export async function updateVariable(idVariable: Id, patch: Partial<Omit<VariableInput, "type">>): Promise<void> {
  const idContainerVersion = await getDraftVersionId();
  const cur = await getVariable(idVariable, idContainerVersion);
  // default_value vaut false/null quand il n'y en a pas : on omet alors le paramètre.
  const curDefault = typeof cur.default_value === "string" || typeof cur.default_value === "number" ? String(cur.default_value) : undefined;
  await call("updateContainerVariable", {
    idContainerVersion,
    idVariable,
    name: patch.name ?? cur.name,
    parameters: patch.parameters ?? asObject(cur.parameters),
    defaultValue: patch.defaultValue ?? curDefault,
    lookupTable: patch.lookupTable ?? cur.lookup_table ?? [],
    description: patch.description ?? cur.description ?? "",
  });
}

export async function deleteVariable(idVariable: Id): Promise<void> {
  await call("deleteContainerVariable", { idContainerVersion: await getDraftVersionId(), idVariable });
}

/** Fige le brouillon dans une nouvelle version (nouveaux ids pour toutes les entités) et renvoie son id. */
export async function createVersion(name: string, description = ""): Promise<number> {
  if (name.length < 1 || name.length > 50) throw new Error("Le nom de version doit faire 1 à 50 caractères");
  return Number(valueOf(await call("createContainerVersion", { name, description })));
}

export type Environment = "dev" | "staging" | "live";

/** Publie une version figée. Refuse le brouillon : passer d'abord par createVersion. */
export async function publishVersion(idContainerVersion: Id, environment: Environment): Promise<void> {
  const draft = await getDraftVersionId();
  if (Number(idContainerVersion) === draft) {
    throw new Error(`La version ${draft} est le brouillon : créer d'abord une version (create_version) puis publier son id`);
  }
  await call("publishContainerVersion", { idContainerVersion, environment });
}

// ─── haut niveau ─────────────────────────────────────────────────────────────

export interface TrackCustomEventInput {
  /** Valeur de `event` poussée dans window._mtm par le front. */
  event: string;
  category: string;
  /** eventAction ; par défaut, le nom de l'événement. */
  action?: string;
  /** Champ du dataLayer envoyé en eventName (via {{dlv__<champ>}}). */
  nameField?: string;
  /** Champ du dataLayer envoyé en eventValue (via {{dlv__<champ>}}). */
  valueField?: string;
  conditions?: Condition[];
  createMissingVariables?: boolean;
  dryRun?: boolean;
}

export interface TrackCustomEventResult {
  dryRun: boolean;
  idContainerVersion: number;
  trigger: { id?: number; name: string; reused: boolean };
  tag: { id?: number; name: string; parameters: Record<string, string> };
  variablesCreated: string[];
}

export const MATOMO_CONFIG_VARIABLE = "{{Matomo Configuration}}";

const sameConditions = (a: Condition[] = [], b: Condition[] = []) =>
  a.length === b.length && a.every((c, i) => c.actual === b[i].actual && c.comparison === b[i].comparison && c.expected === b[i].expected);

/**
 * Collecte un événement dataLayer : déclencheur CustomEvent `dl__<event>` + balise Matomo
 * événement `<catégorie>__<action>`. Réutilise un déclencheur CustomEvent existant sur le même
 * eventName et les mêmes conditions (cas des déclencheurs orphelins), refuse un nom de balise déjà pris.
 */
export async function trackCustomEvent(input: TrackCustomEventInput): Promise<TrackCustomEventResult> {
  const action = input.action ?? input.event;
  const tagName = `${input.category}__${action}`;
  const triggerName = `dl__${input.event}`;
  const idContainerVersion = await getDraftVersionId();
  const [triggers, tags, variables] = await Promise.all([
    listTriggers(idContainerVersion),
    listTags(idContainerVersion),
    listVariables(idContainerVersion),
  ]);

  if (tags.some((t) => t.name === tagName)) throw new Error(`Une balise "${tagName}" existe déjà dans le brouillon`);

  const existing = triggers.find(
    (t) => t.type === "CustomEvent" && asObject(t.parameters).eventName === input.event && sameConditions(t.conditions, input.conditions),
  );
  if (!existing && triggers.some((t) => t.name === triggerName)) {
    throw new Error(`Un déclencheur "${triggerName}" existe déjà avec un autre eventName ou d'autres conditions`);
  }

  const fields = [...new Set([input.nameField, input.valueField].filter((f): f is string => !!f))];
  const byName = new Map(variables.map((v) => [v.name, v]));
  for (const field of fields) {
    const v = byName.get(`dlv__${field}`);
    const dataLayerName = asObject(v?.parameters).dataLayerName;
    if (v && (v.type !== "DataLayer" || dataLayerName !== field)) {
      throw new Error(`La variable dlv__${field} existe mais ne lit pas le champ "${field}" du dataLayer (type ${v.type}, dataLayerName ${JSON.stringify(dataLayerName ?? null)})`);
    }
  }
  const missing = fields.map((f) => `dlv__${f}`).filter((n) => !byName.has(n));
  if (missing.length && !input.createMissingVariables) {
    throw new Error(`Variables absentes du brouillon : ${missing.join(", ")} (passer create_missing_variables=true pour les créer)`);
  }

  const parameters: Record<string, string> = {
    matomoConfig: MATOMO_CONFIG_VARIABLE,
    trackingType: "event",
    eventCategory: input.category,
    eventAction: action,
  };
  if (input.nameField) parameters.eventName = `{{dlv__${input.nameField}}}`;
  if (input.valueField) parameters.eventValue = `{{dlv__${input.valueField}}}`;

  const result: TrackCustomEventResult = {
    dryRun: !!input.dryRun,
    idContainerVersion,
    trigger: { id: existing ? Number(existing.idtrigger) : undefined, name: existing?.name ?? triggerName, reused: !!existing },
    tag: { name: tagName, parameters },
    variablesCreated: missing,
  };
  if (input.dryRun) return result;

  // Pas de transaction côté Matomo : en cas d'échec, on dit ce qui a déjà été créé dans le brouillon.
  const created: string[] = [];
  try {
    for (const name of missing) {
      const id = valueOf(await call("addContainerVariable", {
        idContainerVersion,
        type: "DataLayer",
        name,
        parameters: { dataLayerName: name.slice("dlv__".length) },
      }));
      created.push(`variable ${name} (${id})`);
    }
    if (!existing) {
      result.trigger.id = Number(valueOf(await call("addContainerTrigger", {
        idContainerVersion,
        type: "CustomEvent",
        name: triggerName,
        parameters: { eventName: input.event },
        conditions: input.conditions ?? [],
      })));
      created.push(`déclencheur ${triggerName} (${result.trigger.id})`);
    }
    result.tag.id = Number(valueOf(await call("addContainerTag", {
      idContainerVersion,
      type: "Matomo",
      name: tagName,
      parameters,
      fireTriggerIds: [result.trigger.id],
      fireLimit: "unlimited",
    })));
  } catch (e) {
    const done = created.length ? ` Déjà créé dans le brouillon ${idContainerVersion} : ${created.join(", ")}.` : "";
    throw new Error(`${e instanceof Error ? e.message : String(e)}.${done}`);
  }
  return result;
}
