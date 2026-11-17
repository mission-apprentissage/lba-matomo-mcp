import { createHash, timingSafeEqual } from "crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as m from "./_matomo";
import * as r from "./_reporting";
import * as pl from "./_plugins";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }] };
}

function json(title: string, data: unknown): ToolResult {
  return text(`${title}\n\n\`\`\`json\n${JSON.stringify(m.redact(data), null, 2)}\n\`\`\``);
}

/**
 * Exécute l'outil avec le droit de la requête (garde du client, en plus du filtrage des outils exposés).
 * Toute erreur devient un résultat isError lisible par l'agent, sans e-mail ni jeton.
 */
function runner(access: m.Access) {
  return <A>(fn: (args: A) => Promise<ToolResult>) => async (args: A): Promise<ToolResult> => {
    try {
      return await m.withAccess(access, () => fn(args));
    } catch (e) {
      return { ...text(`Erreur : ${m.redact(e instanceof Error ? e.message : String(e))}`), isError: true };
    }
  };
}

const version = z.number().int().positive().optional()
  .describe("Id de version (idcontainerversion). Par défaut : le brouillon.");
const id = (what: string) => z.number().int().positive().describe(`Id ${what} dans le brouillon (relire les ids : ils changent à chaque version)`);
const parameters = z.record(z.string(), z.unknown());
const condition = z.object({
  actual: z.string().describe("Nom de variable sans accolades (ex. dlv__search_source, PageUrl)"),
  comparison: z.string().describe("Valeur de list_reference_data kind=comparisons (ex. equals, contains)"),
  expected: z.string().min(1),
});

const DRAFT_ONLY = "Écrit dans le brouillon du conteneur, jamais dans une version publiée. Rien n'est visible des internautes avant create_version puis publish_version.";

/** access vient du secret présenté : "read" pour MCP_SECRET, "write" pour MCP_WRITE_SECRET. */
export function buildMcpServer(access: m.Access = "read"): McpServer {
  const cfg = m.getConfig();
  const readOnly = access !== "write";
  const run = runner(access);
  const server = new McpServer({ name: "lba-matomo-mcp", version: "1.0.0" });
  const where = `conteneur ${cfg.idContainer} du site Matomo ${cfg.idSite}`;

  // ─── lecture ───────────────────────────────────────────────────────────────

  server.registerTool(
    "get_container",
    { description: `Détail du ${where} (La bonne alternance) : brouillon (draft.idcontainerversion), versions et publications par environnement. Indique aussi si le serveur est en lecture seule.` },
    run(async () => {
      const c = await m.getContainer();
      return json(`Conteneur ${cfg.idContainer} — brouillon ${c.draft?.idcontainerversion ?? "?"} — ${readOnly ? "accès en lecture seule" : "accès en écriture"}`, c);
    }),
  );

  server.registerTool(
    "list_versions",
    { description: `Liste les versions du ${where}, avec leurs publications (environnement, date).` },
    run(async () => json("Versions", await m.getContainerVersions())),
  );

  server.registerTool(
    "get_version",
    { description: "Détail d'une version du conteneur.", inputSchema: { id_container_version: z.number().int().positive() } },
    run(async ({ id_container_version }) => json(`Version ${id_container_version}`, await m.getContainerVersion(id_container_version))),
  );

  server.registerTool(
    "list_triggers",
    { description: "Déclencheurs d'une version (brouillon par défaut). Nommage LBA : dl__<event> pour un CustomEvent du dataLayer.", inputSchema: { id_container_version: version } },
    run(async ({ id_container_version }) => {
      const t = await m.listTriggers(id_container_version);
      return json(`${t.length} déclencheur(s)`, t);
    }),
  );

  server.registerTool(
    "get_trigger",
    { description: "Un déclencheur.", inputSchema: { id_trigger: id("du déclencheur"), id_container_version: version } },
    run(async ({ id_trigger, id_container_version }) => json(`Déclencheur ${id_trigger}`, await m.getTrigger(id_trigger, id_container_version))),
  );

  server.registerTool(
    "list_tags",
    { description: "Balises d'une version (brouillon par défaut), avec fire_trigger_ids, block_trigger_ids et status (active/paused). Nommage LBA : <catégorie>__<action>.", inputSchema: { id_container_version: version } },
    run(async ({ id_container_version }) => {
      const t = await m.listTags(id_container_version);
      return json(`${t.length} balise(s)`, t);
    }),
  );

  server.registerTool(
    "get_tag",
    { description: "Une balise.", inputSchema: { id_tag: id("de la balise"), id_container_version: version } },
    run(async ({ id_tag, id_container_version }) => json(`Balise ${id_tag}`, await m.getTag(id_tag, id_container_version))),
  );

  server.registerTool(
    "list_variables",
    {
      description: "Variables d'une version (brouillon par défaut). Nommage LBA : dlv__<champ> pour une variable DataLayer. include_preconfigured ajoute les variables préconfigurées (PageUrl…).",
      inputSchema: { id_container_version: version, include_preconfigured: z.boolean().optional().default(false) },
    },
    run(async ({ id_container_version, include_preconfigured }) => {
      const v = include_preconfigured ? await m.listAvailableVariables(id_container_version) : await m.listVariables(id_container_version);
      return json(`${v.length} ${include_preconfigured ? "catégorie(s) de variables" : "variable(s)"}`, v);
    }),
  );

  server.registerTool(
    "get_variable",
    { description: "Une variable.", inputSchema: { id_variable: id("de la variable"), id_container_version: version } },
    run(async ({ id_variable, id_container_version }) => json(`Variable ${id_variable}`, await m.getVariable(id_variable, id_container_version))),
  );

  server.registerTool(
    "get_references",
    {
      description: "Qui utilise un déclencheur (balises) ou une variable (balises, déclencheurs, variables). Liste vide = rien ne l'utilise.",
      inputSchema: { kind: z.enum(["trigger", "variable"]), id: z.number().int().positive(), id_container_version: version },
    },
    run(async ({ kind, id, id_container_version }) => {
      const refs = kind === "trigger" ? await m.getTriggerReferences(id, id_container_version) : await m.getVariableReferences(id, id_container_version);
      return json(`${refs.length} référence(s) vers ${kind === "trigger" ? "le déclencheur" : "la variable"} ${id}`, refs);
    }),
  );

  server.registerTool(
    "find_orphan_triggers",
    {
      description: "Déclencheurs qu'aucune balise n'utilise, ni pour se déclencher ni pour se bloquer (brouillon par défaut). Signale aussi ceux qui ne servent qu'à des balises en pause. Un événement poussé par le front sans balise n'est pas collecté.",
      inputSchema: { id_container_version: version },
    },
    run(async ({ id_container_version }) => {
      const r = await m.findOrphanTriggers(id_container_version);
      const summary = (t: m.Trigger) => ({
        idtrigger: t.idtrigger,
        name: t.name,
        type: t.type,
        eventName: (t.parameters as Record<string, unknown> | undefined)?.eventName,
        conditions: t.conditions?.length ?? 0,
      });
      return json(
        `Version ${r.idContainerVersion} : ${r.tags} balises, ${r.triggers} déclencheurs, ${r.orphans.length} orphelin(s), ${r.pausedOnly.length} utilisé(s) seulement par des balises en pause`,
        { orphans: r.orphans.map(summary), paused_only: r.pausedOnly.map(summary) },
      );
    }),
  );

  server.registerTool(
    "export_version",
    { description: "Export JSON d'une version (brouillon par défaut), pour relire ou comparer des versions. Les e-mails y sont masqués : ce n'est pas une sauvegarde réimportable.", inputSchema: { id_container_version: version } },
    run(async ({ id_container_version }) => json(`Export de la version ${id_container_version ?? "brouillon"}`, await m.exportVersion(id_container_version))),
  );

  server.registerTool(
    "list_reference_data",
    {
      description: "Référentiels Tag Manager : types de déclencheurs, de balises et de variables (avec leurs paramètres), comparaisons de conditions, fire limits, environnements, environnements où le jeton peut publier.",
      inputSchema: {
        kind: z.enum(["trigger_types", "tag_types", "variable_types", "comparisons", "fire_limits", "environments", "publish_environments", "contexts"]),
        context: z.string().optional().default("web"),
      },
    },
    run(async ({ kind, context }) => {
      const fetchers: Record<typeof kind, () => Promise<unknown>> = {
        trigger_types: () => m.getAvailableTriggerTypes(context),
        tag_types: () => m.getAvailableTagTypes(context),
        variable_types: () => m.getAvailableVariableTypes(context),
        comparisons: m.getAvailableComparisons,
        fire_limits: m.getAvailableTagFireLimits,
        environments: m.getAvailableEnvironments,
        publish_environments: m.getAvailableEnvironmentsWithPublishCapability,
        contexts: m.getAvailableContexts,
      };
      return json(kind, await fetchers[kind]());
    }),
  );

  // ─── statistiques (agrégats uniquement) ────────────────────────────────────

  const period = z.enum(r.PERIODS).describe("day, week, month, year, ou range (date = intervalle ou lastN)");
  const date = z.string().regex(r.DATE_RE).describe("today, yesterday, last30, previous7, 2026-11-01, ou 2026-11-01,2026-11-17. Les chiffres du jour peuvent être incomplets (calcul périodique) : préférer yesterday ou lastN.");
  const limit = z.number().int().min(1).max(500).optional().default(50).describe("Nombre de lignes par période (filter_limit)");
  const segment = z.string().max(500).optional().describe("Segment Matomo, ex. eventCategory==search;deviceType==smartphone. Coûteux à calculer : à utiliser avec parcimonie.");

  server.registerTool(
    "list_reports",
    {
      description: `Catalogue des rapports statistiques du site ${cfg.idSite} accessibles par get_report : méthode, nom, catégorie, dimension, métriques, et paramètres (idGoal pour chaque objectif, idDimension pour chaque dimension personnalisée). Statistiques agrégées uniquement : aucune donnée de visite individuelle.`,
    },
    run(async () => {
      const reports = await r.listReports();
      return json(`${reports.length} rapport(s) disponible(s)`, reports);
    }),
  );

  server.registerTool(
    "list_goals_and_dimensions",
    { description: "Objectifs (goals) et dimensions personnalisées configurés sur le site, avec leurs ids (idGoal, idDimension) à passer à get_report." },
    run(async () => json("Objectifs et dimensions personnalisées", await r.listGoalsAndDimensions())),
  );

  server.registerTool(
    "get_report",
    {
      description: [
        "Statistiques agrégées d'un rapport Matomo sur une période. Méthodes utiles :",
        "- trafic : VisitsSummary.get (visites, visiteurs uniques, rebond, durée), VisitFrequency.get (nouveaux / revenants) ;",
        "- contenu : Actions.getPageUrls, Actions.getEntryPageUrls, Actions.getExitPageUrls, Actions.getOutlinks, Actions.getSiteSearchKeywords ;",
        "- événements : Events.getCategory, Events.getAction, Events.getName (flat=true pour la ventilation) ;",
        "- acquisition : Referrers.getReferrerType, Referrers.getWebsites, Referrers.getSocials, Referrers.getCampaigns, Referrers.getAIAssistants ;",
        "- conversion : Goals.get (id_goal pour un objectif) ; dimensions : CustomDimensions.getCustomDimension (id_dimension) ;",
        "- audience : DevicesDetection.getType, UserCountry.getRegion, VisitTime.getByDayOfWeek ; performance : PagePerformance.get ;",
        "- parcours : Transitions.getTransitionsForPageUrl (page_url), UsersFlow.getUsersFlowPretty (data_source), Cohorts.getCohorts (metric) ;",
        "- entonnoirs : Funnels.getMetrics, Funnels.getFunnelFlow, Funnels.getFunnelEntries / getFunnelExits (step) — id_funnel ;",
        "- formulaires : FormAnalytics.get, getDropOffFields, getFieldTimings, getFieldCorrections… — id_form ;",
        "- heatmaps : HeatmapSessionRecording.getRecordedHeatmapMetadata, getRecordedHeatmap (heatmap_type, device_type) — id_heatmap ;",
        "- rapports personnalisés : CustomReports.getCustomReport — id_custom_report.",
        "Ids d'objectifs et de dimensions : list_goals_and_dimensions. Ids d'entonnoirs, formulaires, heatmaps, rapports : list_analytics_setup. Catalogue : list_reports.",
      ].join("\n"),
      inputSchema: {
        method: z.enum(r.REPORT_METHODS),
        period,
        date,
        segment,
        limit,
        flat: z.boolean().optional().describe("Aplatit les sous-tableaux (ex. catégorie → action pour Events.getCategory)"),
        id_subtable: z.number().int().min(0).optional().describe("Sous-tableau à lire (idsubdatatable d'une ligne)"),
        id_goal: z.number().int().min(0).optional(),
        id_dimension: z.number().int().min(1).optional(),
        id_funnel: z.number().int().min(0).optional(),
        id_form: z.number().int().min(1).optional(),
        id_custom_report: z.number().int().min(1).optional(),
        id_heatmap: z.number().int().min(1).optional(),
        heatmap_type: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("1 mouvement, 2 clic, 3 défilement"),
        device_type: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("1 bureau, 2 tablette, 3 mobile"),
        step: z.number().int().min(1).optional().describe("Étape d'entonnoir"),
        data_source: z.enum(["page_url", "page_title"]).optional(),
        page_url: z.string().url().max(2000).optional().describe("Pour Transitions.getTransitionsForPageUrl"),
        metric: z.string().max(50).optional().describe("Pour Cohorts.getCohorts, ex. nb_visits"),
        filter_pattern: z.string().max(200).optional().describe("Filtre (expression régulière) sur le libellé des lignes"),
        sort_column: z.string().max(50).optional().describe("Ex. nb_visits, nb_events, nb_hits"),
        sort_order: z.enum(["asc", "desc"]).optional(),
      },
    },
    run(async (a) => {
      const data = await r.getReport(a.method, {
        period: a.period,
        date: a.date,
        segment: a.segment,
        limit: a.limit,
        flat: a.flat,
        idSubtable: a.id_subtable,
        idGoal: a.id_goal,
        idDimension: a.id_dimension,
        idFunnel: a.id_funnel,
        idForm: a.id_form,
        idCustomReport: a.id_custom_report,
        idHeatmap: a.id_heatmap,
        heatmapType: a.heatmap_type,
        deviceType: a.device_type,
        step: a.step,
        dataSource: a.data_source,
        pageUrl: a.page_url,
        metric: a.metric,
        filterPattern: a.filter_pattern,
        sortColumn: a.sort_column,
        sortOrder: a.sort_order,
      });
      return json(`${a.method} — ${a.period} ${a.date}${a.segment ? ` — segment ${a.segment}` : ""}`, data);
    }),
  );

  const funnelStep = z.object({
    position: z.number().int().min(1),
    name: z.string().min(1),
    pattern_type: z.string().min(1).describe("Valeur de list_analytics_setup kind=funnel_pattern_types"),
    pattern: z.string().min(1),
    required: z.boolean().optional(),
  });
  const pageRule = z.object({
    attribute: z.string().min(1).describe("Valeur de list_analytics_setup kind=heatmap_page_rules, ex. url ou path"),
    type: z.string().min(1).describe("Ex. equals_simple, contains, starts_with, regexp"),
    value: z.string().min(1),
    inverted: z.boolean().optional(),
  });

  server.registerTool(
    "list_analytics_setup",
    {
      description: "Configuration des plugins Matomo du site : entonnoirs (funnels), heatmaps, formulaires suivis (forms), rapports personnalisés (custom_reports), avec un id pour le détail d'un élément. Référentiels pour écrire : funnel_pattern_types, heatmap_page_rules, custom_report_options (types, catégories, dimensions, métriques). Les enregistrements de session ne sont pas accessibles.",
      inputSchema: { kind: z.enum(pl.SETUP_KINDS), id: z.number().int().min(0).optional() },
    },
    run(async ({ kind, id }) => json(`${kind}${id !== undefined ? ` ${id}` : ""}`, await pl.getSetup(kind, id))),
  );

  server.registerTool(
    "test_funnel_steps",
    {
      description: "Vérifie, sans rien enregistrer, quelles étapes d'entonnoir une URL valide (Funnels.testUrlMatchesSteps). À lancer avant save_funnel.",
      inputSchema: { url: z.string().url(), steps: z.array(funnelStep).min(1) },
    },
    run(async ({ url, steps }) => json(`Test de ${url}`, await pl.testFunnelSteps(url, steps))),
  );

  server.registerTool(
    "test_heatmap_page_rules",
    {
      description: "Vérifie, sans rien enregistrer, si une URL correspond à des règles de page de heatmap (HeatmapSessionRecording.testUrlMatchPages). À lancer avant save_heatmap.",
      inputSchema: { url: z.string().url(), rules: z.array(pageRule).min(1) },
    },
    run(async ({ url, rules }) => json(`Test de ${url}`, await pl.testHeatmapPageRules(url, rules))),
  );

  server.registerTool(
    "list_annotations",
    {
      description: "Annotations Matomo du site (notes datées affichées sur les graphiques, dont les publications du conteneur), sans leur auteur.",
      inputSchema: { period: period.optional().default("range"), date: date.optional().default("last90") },
    },
    run(async ({ period: p, date: d }) => json(`Annotations ${p} ${d}`, await pl.listAnnotations(p, d))),
  );

  server.registerTool(
    "check_tag_activity",
    {
      description: "Croise les balises événement de la version publiée en live avec les événements réellement reçus sur la période : balises qui reçoivent des événements, balises silencieuses (aucun événement : le front ne pousse plus l'événement, ou la balise est mal configurée), balises en pause, balises à catégorie/action dynamique ({{…}}, non vérifiables), et couples catégorie/action reçus sans balise à valeurs fixes (envoyés hors Tag Manager ou par une balise dynamique).",
      inputSchema: { date: date.optional().default("last30").describe("Période analysée (range) : last30 par défaut, ou 2026-11-01,2026-11-17") },
    },
    run(async ({ date: d }) => {
      const a = await r.checkTagActivity(d);
      return json(
        `Version live ${a.idContainerVersion}, période ${a.date} : ${a.withEvents.length} balise(s) avec événements, ${a.silent.length} silencieuse(s), ${a.paused.length} en pause, ${a.dynamic.length} dynamique(s), ${a.untagged.length} couple(s) reçu(s) sans balise fixe`,
        a,
      );
    }),
  );

  // ─── haut niveau (simulation possible en lecture seule) ────────────────────

  server.registerTool(
    "track_custom_event",
    {
      description: `Fait collecter par Matomo un événement poussé dans window._mtm par le front : déclencheur CustomEvent dl__<event> (réutilise un CustomEvent existant sur le même eventName et les mêmes conditions) et balise Matomo de type événement <category>__<action>, avec matomoConfig={{Matomo Configuration}} et eventName/eventValue en {{dlv__<champ>}}. ${DRAFT_ONLY}${readOnly ? " ACCÈS EN LECTURE SEULE : l'outil simule seulement (dry_run forcé)." : " Lancer d'abord avec dry_run=true pour vérifier le plan."}`,
      inputSchema: {
        event: z.string().min(1).describe("Valeur de `event` dans window._mtm (ex. filter_type_offer_applied)"),
        category: z.string().min(1).max(500).describe("eventCategory, aussi préfixe du nom de balise"),
        action: z.string().min(1).max(500).optional().describe("eventAction ; par défaut = event"),
        name_field: z.string().optional().describe("Champ du dataLayer envoyé en eventName via {{dlv__<champ>}}"),
        value_field: z.string().optional().describe("Champ du dataLayer envoyé en eventValue via {{dlv__<champ>}}"),
        conditions: z.array(condition).optional().describe("Conditions du déclencheur"),
        create_missing_variables: z.boolean().optional().default(false).describe("Crée les variables DataLayer dlv__<champ> absentes"),
        dry_run: z.boolean().optional().default(false).describe("Calcule le plan sans rien écrire"),
      },
    },
    run(async (a) => {
      const dryRun = a.dry_run || readOnly;
      const r = await m.trackCustomEvent({
        event: a.event,
        category: a.category,
        action: a.action,
        nameField: a.name_field,
        valueField: a.value_field,
        conditions: a.conditions,
        createMissingVariables: a.create_missing_variables,
        dryRun,
      });
      return json(dryRun ? "Simulation, rien n'a été écrit" : `Créé dans le brouillon ${r.idContainerVersion}`, r);
    }),
  );

  if (readOnly) return server;

  // ─── écriture sur le brouillon ─────────────────────────────────────────────

  server.registerTool(
    "add_trigger",
    {
      description: `Crée un déclencheur. ${DRAFT_ONLY}`,
      inputSchema: {
        type: z.string().describe("Type (list_reference_data kind=trigger_types), ex. CustomEvent"),
        name: z.string().min(1),
        parameters: parameters.optional().describe("Ex. { eventName: 'x' } pour CustomEvent"),
        conditions: z.array(condition).optional(),
        description: z.string().optional(),
      },
    },
    run(async (a) => text(`Déclencheur créé : ${await m.addTrigger(a)}`)),
  );

  server.registerTool(
    "update_trigger",
    {
      description: `Modifie un déclencheur. Les champs omis gardent leur valeur actuelle ; parameters et conditions, s'ils sont fournis, remplacent les existants en entier. ${DRAFT_ONLY}`,
      inputSchema: {
        id_trigger: id("du déclencheur"),
        name: z.string().min(1).optional(),
        parameters: parameters.optional(),
        conditions: z.array(condition).optional(),
        description: z.string().optional(),
      },
    },
    run(async ({ id_trigger, ...patch }) => {
      await m.updateTrigger(id_trigger, patch);
      return json(`Déclencheur ${id_trigger} modifié`, await m.getTrigger(id_trigger));
    }),
  );

  server.registerTool(
    "delete_trigger",
    { description: `Supprime un déclencheur (refusé par Matomo s'il est encore utilisé). ${DRAFT_ONLY}`, inputSchema: { id_trigger: id("du déclencheur") } },
    run(async ({ id_trigger }) => {
      await m.deleteTrigger(id_trigger);
      return text(`Déclencheur ${id_trigger} supprimé du brouillon`);
    }),
  );

  const tagFields = {
    name: z.string().min(1),
    parameters: parameters.describe("Paramètres du type. Variables en {{Nom}}, ex. matomoConfig: '{{Matomo Configuration}}'"),
    fire_trigger_ids: z.array(z.number().int().positive()).min(1),
    block_trigger_ids: z.array(z.number().int().positive()).optional(),
    fire_limit: z.enum(["unlimited", "once_page", "once_24hours", "once_lifetime"]).optional(),
    fire_delay: z.number().int().min(0).optional(),
    priority: z.number().int().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    description: z.string().optional(),
  };

  server.registerTool(
    "add_tag",
    {
      description: `Crée une balise. ${DRAFT_ONLY}`,
      inputSchema: { type: z.string().describe("Type (list_reference_data kind=tag_types), ex. Matomo"), ...tagFields, status: z.enum(["active", "paused"]).optional() },
    },
    run(async (a) => {
      const idTag = await m.addTag({
        type: a.type,
        name: a.name,
        parameters: a.parameters,
        fireTriggerIds: a.fire_trigger_ids,
        blockTriggerIds: a.block_trigger_ids,
        fireLimit: a.fire_limit,
        fireDelay: a.fire_delay,
        priority: a.priority,
        startDate: a.start_date,
        endDate: a.end_date,
        description: a.description,
        status: a.status,
      });
      return text(`Balise créée : ${idTag}`);
    }),
  );

  server.registerTool(
    "update_tag",
    {
      description: `Modifie une balise. Les champs omis gardent leur valeur actuelle ; parameters et les listes de déclencheurs, s'ils sont fournis, remplacent les existants en entier. Pour mettre en pause : pause_tag. ${DRAFT_ONLY}`,
      inputSchema: {
        id_tag: id("de la balise"),
        ...Object.fromEntries(Object.entries(tagFields).map(([k, v]) => [k, v.optional()])) as {
          [K in keyof typeof tagFields]: z.ZodOptional<(typeof tagFields)[K]>;
        },
      },
    },
    run(async (a) => {
      await m.updateTag(a.id_tag, {
        name: a.name,
        parameters: a.parameters,
        fireTriggerIds: a.fire_trigger_ids,
        blockTriggerIds: a.block_trigger_ids,
        fireLimit: a.fire_limit,
        fireDelay: a.fire_delay,
        priority: a.priority,
        startDate: a.start_date,
        endDate: a.end_date,
        description: a.description,
      });
      return json(`Balise ${a.id_tag} modifiée`, await m.getTag(a.id_tag));
    }),
  );

  server.registerTool(
    "delete_tag",
    { description: `Supprime une balise. ${DRAFT_ONLY}`, inputSchema: { id_tag: id("de la balise") } },
    run(async ({ id_tag }) => {
      await m.deleteTag(id_tag);
      return text(`Balise ${id_tag} supprimée du brouillon`);
    }),
  );

  server.registerTool(
    "pause_tag",
    { description: `Met une balise en pause. ${DRAFT_ONLY}`, inputSchema: { id_tag: id("de la balise") } },
    run(async ({ id_tag }) => {
      await m.pauseTag(id_tag);
      return text(`Balise ${id_tag} en pause dans le brouillon`);
    }),
  );

  server.registerTool(
    "resume_tag",
    { description: `Réactive une balise en pause. ${DRAFT_ONLY}`, inputSchema: { id_tag: id("de la balise") } },
    run(async ({ id_tag }) => {
      await m.resumeTag(id_tag);
      return text(`Balise ${id_tag} réactivée dans le brouillon`);
    }),
  );

  server.registerTool(
    "add_variable",
    {
      description: `Crée une variable. Pour un champ du dataLayer : type DataLayer, nom dlv__<champ>, parameters { dataLayerName: '<champ>' }. ${DRAFT_ONLY}`,
      inputSchema: {
        type: z.string().describe("Type (list_reference_data kind=variable_types), ex. DataLayer"),
        name: z.string().min(1),
        parameters: parameters.optional(),
        default_value: z.string().optional(),
        lookup_table: z.array(z.record(z.string(), z.unknown())).optional(),
        description: z.string().optional(),
      },
    },
    run(async (a) => {
      const idVariable = await m.addVariable({
        type: a.type,
        name: a.name,
        parameters: a.parameters,
        defaultValue: a.default_value,
        lookupTable: a.lookup_table,
        description: a.description,
      });
      return text(`Variable créée : ${idVariable}`);
    }),
  );

  server.registerTool(
    "update_variable",
    {
      description: `Modifie une variable. Les champs omis gardent leur valeur actuelle. ${DRAFT_ONLY}`,
      inputSchema: {
        id_variable: id("de la variable"),
        name: z.string().min(1).optional(),
        parameters: parameters.optional(),
        default_value: z.string().optional(),
        lookup_table: z.array(z.record(z.string(), z.unknown())).optional(),
        description: z.string().optional(),
      },
    },
    run(async (a) => {
      await m.updateVariable(a.id_variable, {
        name: a.name,
        parameters: a.parameters,
        defaultValue: a.default_value,
        lookupTable: a.lookup_table,
        description: a.description,
      });
      return json(`Variable ${a.id_variable} modifiée`, await m.getVariable(a.id_variable));
    }),
  );

  server.registerTool(
    "delete_variable",
    { description: `Supprime une variable. ${DRAFT_ONLY}`, inputSchema: { id_variable: id("de la variable") } },
    run(async ({ id_variable }) => {
      await m.deleteVariable(id_variable);
      return text(`Variable ${id_variable} supprimée du brouillon`);
    }),
  );

  const STATS_WRITE = "Modifie la configuration statistique du site (pas le conteneur Tag Manager) : effet immédiat sur la collecte.";

  server.registerTool(
    "save_funnel",
    {
      description: `Crée (sans id_funnel) ou remplace (avec id_funnel) un entonnoir hors objectif. Les étapes fournies remplacent toutes les étapes existantes. Valider d'abord avec test_funnel_steps. ${STATS_WRITE}`,
      inputSchema: { id_funnel: z.number().int().min(1).optional(), name: z.string().min(1).max(150), steps: z.array(funnelStep).min(1) },
    },
    run(async ({ id_funnel, name, steps }) => json(id_funnel ? `Entonnoir ${id_funnel} remplacé` : "Entonnoir créé", await pl.saveFunnel({ id: id_funnel, name, steps }))),
  );

  server.registerTool(
    "save_heatmap",
    {
      description: `Crée (sans id_heatmap : name et match_page_rules obligatoires) ou modifie une heatmap ; en modification, les champs omis gardent leur valeur. Valider les règles avec test_heatmap_page_rules. ${STATS_WRITE}`,
      inputSchema: {
        id_heatmap: z.number().int().min(1).optional(),
        name: z.string().min(1).max(150).optional(),
        match_page_rules: z.array(pageRule).min(1).optional(),
        sample_limit: z.number().int().min(1).optional().describe("Nombre de pages vues à enregistrer (1000 par défaut côté Matomo)"),
        sample_rate: z.number().min(0.1).max(100).optional().describe("Pourcentage de visites échantillonnées"),
        excluded_elements: z.string().max(1000).optional().describe("Sélecteurs CSS exclus, séparés par des virgules"),
        screenshot_url: z.string().url().optional(),
        breakpoint_mobile: z.number().int().min(0).optional(),
        breakpoint_tablet: z.number().int().min(0).optional(),
      },
    },
    run(async (a) => {
      const fields = {
        name: a.name,
        matchPageRules: a.match_page_rules,
        sampleLimit: a.sample_limit,
        sampleRate: a.sample_rate,
        excludedElements: a.excluded_elements,
        screenshotUrl: a.screenshot_url,
        breakpointMobile: a.breakpoint_mobile,
        breakpointTablet: a.breakpoint_tablet,
      };
      if (a.id_heatmap !== undefined) {
        await pl.updateHeatmap(a.id_heatmap, fields);
        return text(`Heatmap ${a.id_heatmap} modifiée`);
      }
      if (!fields.name || !fields.matchPageRules) throw new Error("Création : name et match_page_rules sont obligatoires");
      return text(`Heatmap créée : ${await pl.addHeatmap({ ...fields, name: fields.name, matchPageRules: fields.matchPageRules })}`);
    }),
  );

  server.registerTool(
    "set_heatmap_status",
    {
      description: `Met en pause, reprend ou termine (end, définitif : la collecte s'arrête) une heatmap. ${STATS_WRITE}`,
      inputSchema: { id_heatmap: z.number().int().min(1), action: z.enum(["pause", "resume", "end"]) },
    },
    run(async ({ id_heatmap, action }) => {
      await pl.setHeatmapStatus(id_heatmap, action);
      return text(`Heatmap ${id_heatmap} : ${action}`);
    }),
  );

  server.registerTool(
    "save_custom_report",
    {
      description: `Crée (sans id_custom_report) ou remplace un rapport personnalisé. En remplacement, fournir la définition complète : tous les champs sont remplacés. Valeurs possibles : list_analytics_setup kind=custom_report_options. ${STATS_WRITE}`,
      inputSchema: {
        id_custom_report: z.number().int().min(1).optional(),
        name: z.string().min(1).max(150),
        report_type: z.string().min(1).describe("Ex. table ou evolution"),
        metric_ids: z.array(z.string().min(1)).min(1),
        dimension_ids: z.array(z.string().min(1)).optional(),
        category_id: z.string().optional(),
        subcategory_id: z.string().optional(),
        description: z.string().max(1000).optional(),
        segment_filter: z.string().max(500).optional(),
      },
    },
    run(async (a) => {
      const def = {
        name: a.name,
        reportType: a.report_type,
        metricIds: a.metric_ids,
        dimensionIds: a.dimension_ids,
        categoryId: a.category_id,
        subcategoryId: a.subcategory_id,
        description: a.description,
        segmentFilter: a.segment_filter,
      };
      if (a.id_custom_report !== undefined) {
        await pl.updateCustomReport(a.id_custom_report, def);
        return text(`Rapport personnalisé ${a.id_custom_report} remplacé`);
      }
      return text(`Rapport personnalisé créé : ${await pl.addCustomReport(def)}`);
    }),
  );

  server.registerTool(
    "add_annotation",
    {
      description: "Ajoute une annotation datée sur les graphiques Matomo du site (ex. mise en production, campagne, incident). publish_version en live en ajoute une automatiquement.",
      inputSchema: {
        note: z.string().min(1).max(255),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("AAAA-MM-JJ ; par défaut aujourd'hui (heure de Paris)"),
        starred: z.boolean().optional().default(false),
      },
    },
    run(async ({ note, date: d, starred }) => {
      const day = d ?? pl.todayInParis();
      await pl.addAnnotation(day, note, starred);
      return text(`Annotation ajoutée le ${day}`);
    }),
  );

  server.registerTool(
    "create_version",
    {
      description: "Fige le brouillon dans une nouvelle version, sans la publier. Les entités de la version reçoivent de nouveaux ids ; le brouillon garde les siens. Étape préalable à publish_version.",
      inputSchema: { name: z.string().min(1).max(50), description: z.string().optional() },
    },
    run(async ({ name, description }) => text(`Version créée : ${await m.createVersion(name, description)} (non publiée)`)),
  );

  server.registerTool(
    "publish_version",
    {
      description: "MISE EN PRODUCTION quand environment=live : régénère le conteneur chargé par tous les visiteurs de La bonne alternance. Ne jamais appeler en live sans accord explicite de l'utilisateur pour cette version précise. Par défaut, publie sur dev pour tester. Refuse le brouillon : passer par create_version.",
      inputSchema: {
        id_container_version: z.number().int().positive().describe("Id renvoyé par create_version"),
        environment: z.enum(["dev", "staging", "live"]).optional().default("dev"),
        confirm_live: z.boolean().optional().default(false).describe("Obligatoire à true pour environment=live"),
      },
    },
    run(async ({ id_container_version, environment, confirm_live }) => {
      if (environment === "live" && !confirm_live) {
        return { ...text("Refusé : la publication en live demande confirm_live=true, après accord explicite de l'utilisateur."), isError: true };
      }
      await m.publishVersion(id_container_version, environment);
      const done = `Version ${id_container_version} publiée sur ${environment}`;
      if (environment !== "live") return text(done);
      // La publication a réussi : un échec d'annotation est signalé sans faire échouer l'outil.
      try {
        const day = pl.todayInParis();
        await pl.addAnnotation(day, `Tag Manager : version ${id_container_version} publiée en live`);
        return text(`${done}. Annotation ajoutée le ${day}.`);
      } catch (e) {
        return text(`${done}. ⚠️ Annotation non ajoutée : ${m.redact(e instanceof Error ? e.message : String(e))}`);
      }
    }),
  );

  return server;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function setCorsHeaders(res: VercelResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id, mcp-protocol-version");
}

function safeEqual(a: string, b: string): boolean {
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(a), h(b));
}

export type AuthResult =
  | { ok: true; access: m.Access }
  | { ok: false; status: 401 | 503; error: string };

function presentedSecrets(req: VercelRequest): string[] {
  const out: string[] = [];
  const token = req.query?.["token"];
  if (typeof token === "string") out.push(token);
  const authHeader = req.headers["authorization"];
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^\S+\s+(.+)$/);
    if (match) out.push(match[1]);
  }
  return out;
}

/**
 * Fail-closed : sans MCP_SECRET, tout est refusé (le jeton Matomo a tous les droits du compte).
 * MCP_SECRET donne la lecture seule, MCP_WRITE_SECRET (facultatif) l'écriture et la publication.
 * Secret accepté en header Authorization quel que soit le schéma (Bearer, ou Basic non encodé
 * comme l'envoie Le Chat), ou en query ?token= pour les clients qui ne permettent pas d'en-tête.
 */
export function authenticate(req: VercelRequest): AuthResult {
  const readSecret = process.env.MCP_SECRET;
  const writeSecret = process.env.MCP_WRITE_SECRET;
  if (!readSecret) return { ok: false, status: 503, error: "MCP_SECRET non configuré : serveur fermé" };
  // Secrets identiques : tout lecteur écrirait. On ferme plutôt que de dégrader en silence.
  if (writeSecret && safeEqual(writeSecret, readSecret)) {
    return { ok: false, status: 503, error: "MCP_WRITE_SECRET identique à MCP_SECRET : serveur fermé" };
  }

  const presented = presentedSecrets(req);
  if (writeSecret && presented.some((p) => safeEqual(p, writeSecret))) return { ok: true, access: "write" };
  if (presented.some((p) => safeEqual(p, readSecret))) return { ok: true, access: "read" };
  return { ok: false, status: 401, error: "Non autorisé" };
}

/**
 * Mode sans session (sessionIdGenerator: undefined) : un serveur par requête POST.
 * Le Map de sessions de lba-github-mcp casse dès que Vercel route deux requêtes
 * d'une même session vers deux instances (404 « Session inconnue »).
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).setHeader("Allow", "POST, OPTIONS").json({ error: "Méthode non supportée (serveur sans session)" });
    return;
  }

  const server = buildMcpServer(auth.access);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req as any, res as any, req.body);
}
