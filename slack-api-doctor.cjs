#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = __dirname;
const APP_NAME = "slack-api-cli";
const MINIMUM_NODE_MAJOR = 20;
const DEFAULT_DEEP_CONVERSATION_LIMIT = 100;
const API_CHECK_IDS = [
  "api.auth",
  "api.enterprise",
  "api.current_user",
  "api.unread_counts",
  "api.notification_preferences",
  "api.conversations",
  "api.unread_coverage",
];
const REQUIRED_COMMAND_SCRIPTS = [
  "slack-api-setup.cjs",
  "slack-api-auth.cjs",
  "slack-api-me.cjs",
  "slack-api-search.cjs",
  "slack-api-bookmark.cjs",
  "slack-api-read.cjs",
  "slack-api-channel.cjs",
  "slack-api-dm.cjs",
  "slack-api-user.cjs",
  "slack-api-file.cjs",
  "slack-api-send.cjs",
  "slack-api-draft.cjs",
  "slack-api-emoji.cjs",
  "slack-api-reply.cjs",
  "slack-api-react.cjs",
  "slack-api-mark-read.cjs",
  "slack-api-session.cjs",
  "slack-api-doctor.cjs",
];

function defaultPaths(env = process.env, homeDirectory = os.homedir()) {
  const configDirectory = env.SLACK_API_CONFIG_DIR
    || (env.XDG_CONFIG_HOME
      ? path.join(env.XDG_CONFIG_HOME, APP_NAME)
      : path.join(homeDirectory, ".config", APP_NAME));
  const dataDirectory = env.SLACK_API_DATA_DIR
    || (env.XDG_DATA_HOME
      ? path.join(env.XDG_DATA_HOME, APP_NAME)
      : path.join(homeDirectory, ".local", "share", APP_NAME));
  return {
    config: env.SLACK_API_CONFIG || path.join(configDirectory, "config.json"),
    profile: path.join(dataDirectory, "browser-profile"),
    authCache: path.join(dataDirectory, "auth.json"),
    sessions: env.SLACK_API_SESSION_DIR || path.join(dataDirectory, "sessions"),
  };
}

function parseArgs(argv, options = {}) {
  const env = options.env || process.env;
  const defaults = defaultPaths(env, options.homeDirectory || os.homedir());
  const args = {
    configPath: path.resolve(defaults.config),
    workspace: "",
    profile: "",
    authCache: "",
    timeoutMs: 30_000,
    json: false,
    offline: false,
    strict: false,
    sessions: true,
    verbose: false,
    deep: false,
    maxDeepConversations: DEFAULT_DEEP_CONVERSATION_LIMIT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--config") args.configPath = path.resolve(next());
    else if (arg === "--workspace") args.workspace = next();
    else if (arg === "--profile") args.profile = path.resolve(next());
    else if (arg === "--auth-cache") args.authCache = path.resolve(next());
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--json") args.json = true;
    else if (arg === "--offline") args.offline = true;
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--deep") args.deep = true;
    else if (arg === "--max-deep-conversations") args.maxDeepConversations = Number(next());
    else if (arg === "--no-session") args.sessions = false;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--refresh" || arg === "--refresh-auth" || arg === "--headed") {
      throw new Error("doctor is read-only and never refreshes browser auth; use `slack-api auth --refresh --headed` explicitly");
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  if (!Number.isInteger(args.maxDeepConversations) || args.maxDeepConversations < 1) {
    throw new Error("--max-deep-conversations must be a positive integer");
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  slack-api doctor
  slack-api doctor --json
  slack-api doctor --offline
  slack-api doctor --strict --verbose
  slack-api doctor --deep --strict

Options:
  --json             Print the stable machine-readable report for AI agents
  --offline          Skip all Slack network probes
  --strict           Exit nonzero when the report contains warnings
  --deep             Resolve unread conversation metadata for coverage gaps
  --max-deep-conversations N
                     Maximum unread conversations resolved by --deep. Default: ${DEFAULT_DEEP_CONVERSATION_LIMIT}
  --no-session       Skip session storage and provider checks
  --verbose          Include check details in human-readable output
  --config FILE      Config file override
  --workspace URL    Workspace URL override
  --profile DIR      Browser profile override
  --auth-cache FILE  Auth cache override
  --timeout-ms N     Per-request Slack timeout. Default: 30000

Safety:
  doctor never refreshes credentials, launches a browser, reads message content,
  changes local configuration, or mutates Slack. Its network probes call only
  auth.test, users.info, users.counts, users.prefs.get, conversations.list,
  and, with --deep, conversations.info for unread conversation metadata.
`);
}

function parseJsonFile(file, fileSystem = fs) {
  try {
    return { ok: true, value: JSON.parse(fileSystem.readFileSync(file, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT") return { ok: false, missing: true, error: "file_not_found" };
    return { ok: false, missing: false, error: error.message || String(error) };
  }
}

function fileMode(file, fileSystem = fs) {
  return fileSystem.statSync(file).mode & 0o777;
}

function modeText(mode) {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function isOwnerOnly(mode) {
  return (mode & 0o077) === 0;
}

function normalizeWorkspace(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error("workspace must be an HTTPS URL");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

function resolveExecutable(name, env = process.env, fileSystem = fs) {
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      fileSystem.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function pushCheck(checks, id, category, status, summary, options = {}) {
  checks.push({
    id,
    category,
    status,
    summary,
    ...(options.details ? { details: options.details } : {}),
    ...(options.remediation ? { remediation: options.remediation } : {}),
    ...(options.diagnostic ? { diagnostic: options.diagnostic } : {}),
  });
}

function resolveConfiguredPaths(args, config, env, defaults) {
  return {
    workspace: args.workspace || env.SLACK_WORKSPACE_URL || config.workspace || "",
    teamId: env.SLACK_TEAM_ID || config.teamId || "",
    profile: args.profile || env.SLACK_BROWSER_PROFILE || config.profile || defaults.profile,
    authCache: args.authCache || env.SLACK_API_AUTH_CACHE || config.authCache || defaults.authCache,
    sessions: defaults.sessions,
  };
}

function auditSessionFiles(checks, sessionDirectory, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  if (!fileSystem.existsSync(sessionDirectory)) {
    pushCheck(checks, "session.storage", "session", "pass", "Session storage has not been created yet", {
      details: { path: sessionDirectory, configured: false },
    });
    return;
  }

  const issues = [];
  const details = { path: sessionDirectory, configured: true };
  try {
    const directoryMode = fileMode(sessionDirectory, fileSystem);
    details.directoryMode = modeText(directoryMode);
    if (!isOwnerOnly(directoryMode)) issues.push(`session directory permissions are ${modeText(directoryMode)}, expected 0700`);
  } catch (error) {
    issues.push(`could not inspect session directory: ${error.message || error}`);
  }

  for (const [label, filename, validator] of [
    ["defaults", "defaults.json", (value) => value?.version === 1 && value.defaults && typeof value.defaults === "object"],
    ["state", "state.json", (value) => value?.version === 1 && Array.isArray(value.sessions)],
  ]) {
    const file = path.join(sessionDirectory, filename);
    if (!fileSystem.existsSync(file)) continue;
    const parsed = parseJsonFile(file, fileSystem);
    details[label] = { path: file };
    if (!parsed.ok || !validator(parsed.value)) {
      issues.push(`${filename} is invalid or uses an unsupported schema`);
      details[label].valid = false;
      continue;
    }
    details[label].valid = true;
    const mode = fileMode(file, fileSystem);
    details[label].mode = modeText(mode);
    if (!isOwnerOnly(mode)) issues.push(`${filename} permissions are ${modeText(mode)}, expected 0600`);
  }

  pushCheck(
    checks,
    "session.storage",
    "session",
    issues.length ? "fail" : "pass",
    issues.length ? issues.join("; ") : "Session storage schemas and permissions are valid",
    {
      details,
      remediation: issues.length ? "Repair the reported files or recreate session state with owner-only permissions." : null,
    },
  );
}

function summarizeChecks(checks) {
  const summary = { passed: 0, warnings: 0, failed: 0, skipped: 0 };
  for (const check of checks) {
    if (check.status === "pass") summary.passed += 1;
    else if (check.status === "warn") summary.warnings += 1;
    else if (check.status === "fail") summary.failed += 1;
    else if (check.status === "skip") summary.skipped += 1;
  }
  return summary;
}

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) || null;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : null;
}

function responseDiagnostics(result) {
  const warnings = [
    ...(Array.isArray(result?.json?.response_metadata?.warnings)
      ? result.json.response_metadata.warnings
      : []),
    ...String(result?.json?.warning || "").split(","),
  ].map((warning) => warning.trim()).filter(Boolean);
  return {
    status: result?.response?.status ?? null,
    warnings: [...new Set(warnings)],
    requestId: headerValue(result?.response, "x-slack-req-id"),
    retryAfterSeconds: Number(headerValue(result?.response, "retry-after")) || null,
    grantedScopes: headerValue(result?.response, "x-oauth-scopes"),
    acceptedScopes: headerValue(result?.response, "x-accepted-oauth-scopes"),
  };
}

function slackApiError(result, fallbackCode, options = {}) {
  const code = result?.json?.error || fallbackCode;
  const error = new Error(code);
  error.slackError = code;
  error.result = result;
  error.privateEndpoint = Boolean(options.privateEndpoint);
  return error;
}

function classifySlackFailure(error) {
  const rawError = String(error?.slackError || error?.code || error?.message || error || "unknown_error");
  const normalized = rawError.toLowerCase();
  let classification = "unknown";
  let retryable = false;
  let requiresAdmin = false;
  let action = "inspect_error";
  let remediation = "Inspect the reported Slack error and rerun doctor after addressing it.";

  if (/invalid_auth|not_authed|token_expired|token_revoked|account_inactive|cookie/.test(normalized)) {
    classification = "authentication";
    action = "refresh_auth";
    remediation = "Run `slack-api auth --refresh --headed`, then rerun doctor.";
  } else if (/missing_scope|no_permission|team_access_not_granted|not_allowed_token_type/.test(normalized)) {
    classification = "authorization";
    requiresAdmin = /team_access_not_granted/.test(normalized);
    action = requiresAdmin ? "contact_workspace_admin" : "reauthorize_with_required_access";
    remediation = requiresAdmin
      ? "Ask a Slack administrator to grant this session access to the selected workspace."
      : "Refresh authorization for an account allowed to use this capability.";
  } else if (/enterprise_is_restricted|team_is_restricted|ekm_access_denied|access_denied|restricted_action/.test(normalized)) {
    classification = "enterprise_policy";
    requiresAdmin = true;
    action = "contact_workspace_admin";
    remediation = "Ask a Slack administrator whether enterprise policy allows this capability for your account.";
  } else if (/org_login_required|team_added_to_org/.test(normalized)) {
    classification = "enterprise_transition";
    retryable = true;
    requiresAdmin = true;
    action = "retry_after_enterprise_migration";
    remediation = "The workspace is migrating to an Enterprise organization. Retry later or contact a Slack administrator.";
  } else if (/ratelimited|rate.?limit|too_many_requests/.test(normalized)) {
    classification = "rate_limit";
    retryable = true;
    action = "retry_after_delay";
    remediation = "Wait for the reported Retry-After interval, then rerun doctor.";
  } else if (/accesslimited|enotfound|eai_again|econnreset|econnrefused|fetch failed|network|timed out|timeout|tls|certificate|proxy/.test(normalized)) {
    classification = "network_policy";
    retryable = true;
    action = "inspect_network_path";
    remediation = "Check DNS, proxy, TLS inspection, firewall, and Slack domain allowlisting, then rerun doctor.";
  } else if (/invalid_.*_response|pagination_unsupported|deprecated_endpoint|schema|unexpected token|json/.test(normalized) || error?.privateEndpoint) {
    classification = "compatibility";
    action = "update_cli_or_report_schema_change";
    remediation = error?.privateEndpoint
      ? "Update the CLI or report that Slack changed or disabled this private browser endpoint."
      : "Update the CLI or report the unexpected Slack response schema.";
  } else if (/channel_not_found|user_not_found|team_not_found/.test(normalized)) {
    classification = "resource_visibility";
    action = "verify_workspace_and_access";
    remediation = "Verify the workspace, conversation state, and the authenticated user's access.";
  } else if (/service_unavailable|fatal_error|internal_error/.test(normalized)) {
    classification = "slack_service";
    retryable = true;
    action = "retry_later";
    remediation = "Slack reported a temporary service failure. Retry later.";
  }

  return {
    classification,
    retryable,
    requiresAdmin,
    action,
    rawError,
    remediation,
  };
}

async function runApiProbe(checks, id, operation, options = {}) {
  try {
    const outcome = await operation();
    const response = responseDiagnostics(outcome.result);
    const status = outcome.status || (response.warnings.length ? "warn" : "pass");
    pushCheck(checks, id, "slack-api", status, outcome.summary, {
      details: { ...response, ...(outcome.details || {}) },
      remediation: outcome.remediation || (response.warnings.length
        ? "Inspect Slack's response warning before relying on this capability."
        : null),
      diagnostic: outcome.diagnostic,
    });
    return { ok: status !== "fail", value: outcome.value, result: outcome.result };
  } catch (error) {
    const diagnostic = classifySlackFailure(error);
    pushCheck(checks, id, "slack-api", "fail", `Slack API probe failed: ${diagnostic.rawError}`, {
      details: responseDiagnostics(error.result),
      remediation: diagnostic.remediation,
      diagnostic: {
        classification: diagnostic.classification,
        retryable: diagnostic.retryable,
        requiresAdmin: diagnostic.requiresAdmin,
        action: diagnostic.action,
        rawError: diagnostic.rawError,
      },
    });
    return { ok: false, error, diagnostic };
  }
}

function buildCapabilities(checks) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const availability = (checkId) => {
    const status = byId.get(checkId)?.status || "skip";
    if (status === "pass") return "available";
    if (status === "warn") return "degraded";
    if (status === "fail") return "unavailable";
    return "untested";
  };
  return [
    { id: "authentication", status: availability("api.auth"), checkId: "api.auth" },
    { id: "enterprise_routing", status: availability("api.enterprise"), checkId: "api.enterprise" },
    { id: "current_user_context", status: availability("api.current_user"), checkId: "api.current_user" },
    { id: "unread_selection", status: availability("api.unread_counts"), checkId: "api.unread_counts" },
    { id: "mute_filtering", status: availability("api.notification_preferences"), checkId: "api.notification_preferences" },
    { id: "conversation_resolution", status: availability("api.conversations"), checkId: "api.conversations" },
    { id: "unread_coverage", status: availability("api.unread_coverage"), checkId: "api.unread_coverage" },
    {
      id: "slack_mutations",
      status: "unknown_not_safely_testable",
      reason: "Posting, reactions, uploads, drafts, and mark-read operations are not probed by a read-only doctor.",
    },
  ];
}

async function runDoctor(args, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const env = dependencies.env || process.env;
  const homeDirectory = dependencies.homeDirectory || os.homedir();
  const defaults = defaultPaths(env, homeDirectory);
  const checks = [];
  const nodeVersion = dependencies.nodeVersion || process.versions.node;
  const nodeMajor = Number(String(nodeVersion).split(".")[0]);
  pushCheck(
    checks,
    "runtime.node",
    "runtime",
    Number.isInteger(nodeMajor) && nodeMajor >= MINIMUM_NODE_MAJOR ? "pass" : "fail",
    `Node.js ${nodeVersion} ${nodeMajor >= MINIMUM_NODE_MAJOR ? "meets" : "does not meet"} the >=${MINIMUM_NODE_MAJOR} requirement`,
    { remediation: nodeMajor >= MINIMUM_NODE_MAJOR ? null : `Install Node.js ${MINIMUM_NODE_MAJOR} or newer.` },
  );

  const manifestPath = path.join(ROOT, "package.json");
  const manifest = parseJsonFile(manifestPath, fileSystem);
  const manifestValid = manifest.ok
    && manifest.value?.bin?.["slack-api"] === "slack-api.cjs";
  pushCheck(
    checks,
    "installation.package",
    "installation",
    manifestValid ? "pass" : "fail",
    manifestValid
      ? `Package ${manifest.value.name}@${manifest.value.version} has the expected CLI entrypoint`
      : "package.json is missing, invalid, or has an unexpected slack-api entrypoint",
    { details: { path: manifestPath }, remediation: manifestValid ? null : "Reinstall the CLI from a complete repository checkout." },
  );

  const missingScripts = REQUIRED_COMMAND_SCRIPTS.filter((file) => !fileSystem.existsSync(path.join(ROOT, file)));
  pushCheck(
    checks,
    "installation.commands",
    "installation",
    missingScripts.length ? "fail" : "pass",
    missingScripts.length ? `Missing command scripts: ${missingScripts.join(", ")}` : `All ${REQUIRED_COMMAND_SCRIPTS.length} command scripts are present`,
    { details: { root: ROOT, missingScripts }, remediation: missingScripts.length ? "Reinstall or synchronize the CLI repository." : null },
  );

  const installedCommand = resolveExecutable("slack-api", env, fileSystem);
  let entrypointStatus = "warn";
  let entrypointSummary = "slack-api is not available on PATH";
  const entrypointDetails = { command: installedCommand, expected: path.join(ROOT, "slack-api.cjs") };
  if (installedCommand) {
    try {
      const installedRealPath = fileSystem.realpathSync(installedCommand);
      const expectedRealPath = fileSystem.realpathSync(path.join(ROOT, "slack-api.cjs"));
      entrypointDetails.resolved = installedRealPath;
      entrypointStatus = installedRealPath === expectedRealPath ? "pass" : "warn";
      entrypointSummary = installedRealPath === expectedRealPath
        ? "The slack-api command resolves to this checkout"
        : "The slack-api command resolves to a different checkout or installation";
    } catch (error) {
      entrypointSummary = `Could not resolve the installed slack-api command: ${error.message || error}`;
    }
  }
  pushCheck(checks, "installation.entrypoint", "installation", entrypointStatus, entrypointSummary, {
    details: entrypointDetails,
    remediation: entrypointStatus === "pass" ? null : "Run `npm link` from the intended CLI checkout or correct PATH.",
  });

  const configResult = parseJsonFile(args.configPath, fileSystem);
  let config = {};
  let configUsable = false;
  if (!configResult.ok) {
    pushCheck(checks, "config.file", "configuration", "fail", configResult.missing
      ? `Config file not found at ${args.configPath}`
      : `Config file is not valid JSON: ${configResult.error}`, {
      remediation: "Run `slack-api setup` to create a valid configuration.",
    });
    pushCheck(checks, "config.permissions", "security", "skip", "Skipped because the config file is unavailable or invalid");
  } else {
    config = configResult.value && typeof configResult.value === "object" && !Array.isArray(configResult.value)
      ? configResult.value
      : {};
    let currentApiCheckId = "api.auth";
    try {
      const normalizedWorkspace = normalizeWorkspace(args.workspace || env.SLACK_WORKSPACE_URL || config.workspace);
      configUsable = Boolean(normalizedWorkspace);
      pushCheck(checks, "config.file", "configuration", configUsable ? "pass" : "fail", configUsable
        ? `Configuration selects ${new URL(normalizedWorkspace).hostname}`
        : "Configuration does not select a Slack workspace", {
        details: { path: args.configPath, workspace: normalizedWorkspace || null, teamIdConfigured: Boolean(env.SLACK_TEAM_ID || config.teamId) },
        remediation: configUsable ? null : "Run `slack-api setup --workspace https://your-workspace.slack.com`.",
      });
    } catch (error) {
      pushCheck(checks, "config.file", "configuration", "fail", `Configured workspace is invalid: ${error.message || error}`, {
        remediation: "Run `slack-api setup` with the correct HTTPS Slack workspace URL.",
      });
    }
    const mode = fileMode(args.configPath, fileSystem);
    pushCheck(checks, "config.permissions", "security", isOwnerOnly(mode) ? "pass" : "fail", isOwnerOnly(mode)
      ? `Config permissions are owner-only (${modeText(mode)})`
      : `Config permissions are too broad (${modeText(mode)})`, {
      details: { path: args.configPath, mode: modeText(mode) },
      remediation: isOwnerOnly(mode) ? null : `Run: chmod 600 ${args.configPath}`,
    });
  }

  const configured = resolveConfiguredPaths(args, config, env, defaults);
  configured.workspace = configUsable ? normalizeWorkspace(configured.workspace) : "";
  const profileExists = fileSystem.existsSync(configured.profile) && fileSystem.statSync(configured.profile).isDirectory();
  pushCheck(checks, "browser.profile", "browser", profileExists ? "pass" : "warn", profileExists
    ? "Browser profile directory is available for future auth refreshes"
    : "Browser profile directory is missing; cached auth may work but refresh cannot", {
    details: { path: configured.profile },
    remediation: profileExists ? null : "Run `slack-api setup` before the next credential refresh.",
  });
  if (profileExists) {
    const mode = fileMode(configured.profile, fileSystem);
    pushCheck(checks, "browser.profile_permissions", "security", isOwnerOnly(mode) ? "pass" : "fail", isOwnerOnly(mode)
      ? `Browser profile permissions are owner-only (${modeText(mode)})`
      : `Browser profile permissions are too broad (${modeText(mode)})`, {
      details: { path: configured.profile, mode: modeText(mode) },
      remediation: isOwnerOnly(mode) ? null : `Run: chmod 700 ${configured.profile}`,
    });
  } else {
    pushCheck(checks, "browser.profile_permissions", "security", "skip", "Skipped because the browser profile directory does not exist");
  }

  let common = dependencies.common || null;
  try {
    common = common || require("./slack-api-common.cjs");
    const playwright = (dependencies.loadPlaywright || common.loadPlaywright)();
    const executable = playwright.chromium?.executablePath?.() || "";
    const browserReady = !executable || fileSystem.existsSync(executable);
    pushCheck(checks, "browser.runtime", "browser", browserReady ? "pass" : "warn", browserReady
      ? "Playwright and its Chromium runtime are available"
      : "Playwright is installed but its Chromium runtime is missing", {
      details: { executable: executable || null },
      remediation: browserReady ? null : "Run the Playwright install command shown by `slack-api setup`.",
    });
  } catch (error) {
    pushCheck(checks, "browser.runtime", "browser", "warn", `Browser refresh dependency is unavailable: ${error.message || error}`, {
      remediation: "Run `npm install`, then install the matching Playwright Chromium runtime.",
    });
  }

  const authResult = parseJsonFile(configured.authCache, fileSystem);
  let authCacheUsable = false;
  if (!authResult.ok) {
    pushCheck(checks, "auth.cache", "authentication", "fail", authResult.missing
      ? `Auth cache not found at ${configured.authCache}`
      : `Auth cache is not valid JSON: ${authResult.error}`, {
      remediation: "Run `slack-api auth --refresh --headed` from a trusted terminal.",
    });
    pushCheck(checks, "auth.permissions", "security", "skip", "Skipped because the auth cache is unavailable or invalid");
  } else {
    const cached = authResult.value && typeof authResult.value === "object" && !Array.isArray(authResult.value)
      ? authResult.value
      : {};
    authCacheUsable = Boolean(cached.token && cached.cookieHeader);
    let cachedWorkspaceMatches = true;
    try {
      cachedWorkspaceMatches = !cached.workspace || !configured.workspace
        || normalizeWorkspace(cached.workspace) === configured.workspace;
    } catch {
      cachedWorkspaceMatches = false;
    }
    if (!cachedWorkspaceMatches) authCacheUsable = false;
    pushCheck(checks, "auth.cache", "authentication", authCacheUsable ? "pass" : "fail", authCacheUsable
      ? "Cached browser credentials have the required fields and match the workspace"
      : "Cached browser credentials are incomplete or belong to another workspace", {
      details: { path: configured.authCache, cachedAt: cached.cachedAt || null, workspaceMatches: cachedWorkspaceMatches },
      remediation: authCacheUsable ? null : "Run `slack-api auth --refresh --headed` for the configured workspace.",
    });
    const mode = fileMode(configured.authCache, fileSystem);
    pushCheck(checks, "auth.permissions", "security", isOwnerOnly(mode) ? "pass" : "fail", isOwnerOnly(mode)
      ? `Auth cache permissions are owner-only (${modeText(mode)})`
      : `Auth cache permissions are too broad (${modeText(mode)})`, {
      details: { path: configured.authCache, mode: modeText(mode) },
      remediation: isOwnerOnly(mode) ? null : `Run: chmod 600 ${configured.authCache}`,
    });
  }

  if (args.sessions) {
    auditSessionFiles(checks, configured.sessions, dependencies);
    try {
      const inspectProviders = dependencies.inspectProviders
        || require("./slack-api-session-provider.cjs").inspectProviders;
      const inspection = inspectProviders(env);
      const anyInstalled = Object.values(inspection.installed).some(Boolean);
      const sessionStatus = !anyInstalled || inspection.detachedListener.ready === false ? "warn" : "pass";
      const sessionSummary = !anyInstalled
        ? "No supported terminal provider executable was found"
        : inspection.detachedListener.ready === false
          ? inspection.detachedListener.issue
          : `Session providers are available${inspection.detected ? `; detected ${inspection.detected}` : ""}`;
      pushCheck(checks, "session.providers", "session", sessionStatus, sessionSummary, {
        details: {
          installed: inspection.installed,
          contexts: inspection.contexts,
          detected: inspection.detected,
          ...(args.verbose ? { executables: inspection.executables } : {}),
        },
        remediation: !anyInstalled
          ? "Install or run inside tmux, cmux, or Herdr before starting an agent session."
          : inspection.detachedListener.remediation,
      });
    } catch (error) {
      pushCheck(checks, "session.providers", "session", "warn", `Could not inspect session providers: ${error.message || error}`, {
        remediation: "Run `slack-api session doctor` for focused provider diagnostics.",
      });
    }
  }

  if (args.offline) {
    for (const id of API_CHECK_IDS) {
      pushCheck(checks, id, "slack-api", "skip", "Skipped by --offline");
    }
  } else if (!configUsable || !authCacheUsable || !common) {
    for (const id of API_CHECK_IDS) {
      pushCheck(checks, id, "slack-api", "skip", "Skipped because configuration or cached auth is not usable");
    }
  } else {
    const apiArgs = {
      workspace: configured.workspace,
      teamId: configured.teamId,
      profile: configured.profile,
      authCache: configured.authCache,
      configPath: args.configPath,
      refreshAuth: false,
      headless: true,
      timeoutMs: args.timeoutMs,
    };
    const authProbe = await runApiProbe(checks, "api.auth", async () => {
      const loadAuth = dependencies.loadAuth || common.loadAuth;
      apiArgs.auth = await loadAuth(apiArgs);
      const callSlackApi = dependencies.slackApiCall || common.slackApiCall;
      const authTest = await callSlackApi(apiArgs, "auth.test", {});
      if (!authTest.json?.ok) throw slackApiError(authTest, "auth_test_failed");
      const teamMatches = !configured.teamId || configured.teamId === authTest.json.team_id;
      return {
        result: authTest,
        status: teamMatches ? null : "fail",
        summary: teamMatches
          ? `Slack authenticated as ${authTest.json.user || authTest.json.user_id || "the configured user"}`
          : "Authenticated Slack team does not match the configured team ID",
        details: {
          userId: authTest.json.user_id || null,
          teamId: authTest.json.team_id || null,
          authSource: apiArgs.auth.source || null,
        },
        remediation: teamMatches ? null : "Run setup again for the intended workspace and team.",
        diagnostic: teamMatches ? null : {
          classification: "workspace_mismatch",
          retryable: false,
          requiresAdmin: false,
          action: "rerun_setup_for_intended_workspace",
          rawError: "team_id_mismatch",
        },
        value: { authJson: authTest.json, callSlackApi },
      };
    });

    if (!authProbe.value) {
      for (const id of API_CHECK_IDS.filter((id) => id !== "api.auth")) {
        pushCheck(checks, id, "slack-api", "skip", "Skipped because Slack authentication failed");
      }
    } else {
      const { authJson, callSlackApi } = authProbe.value;
      const enterpriseDetected = Boolean(authJson.enterprise_id || authJson.is_enterprise_install);
      const enterpriseRoutingMissing = Boolean(authJson.is_enterprise_install && !configured.teamId);
      const enterpriseStatus = enterpriseRoutingMissing ? "warn" : "pass";
      pushCheck(checks, "api.enterprise", "slack-api", enterpriseStatus, enterpriseDetected
        ? enterpriseRoutingMissing
          ? "Enterprise installation detected but no team ID is configured for workspace routing"
          : "Enterprise identity and workspace routing are coherent"
        : "Workspace is not reported as an Enterprise installation", {
        details: {
          detected: enterpriseDetected,
          enterpriseId: authJson.enterprise_id || null,
          isEnterpriseInstall: Boolean(authJson.is_enterprise_install),
          authenticatedTeamId: authJson.team_id || null,
          configuredTeamId: configured.teamId || null,
          teamRoutingConfigured: Boolean(configured.teamId),
        },
        remediation: enterpriseRoutingMissing
          ? `Persist the workspace team ID with \`slack-api setup --workspace ${configured.workspace} --team-id ${authJson.team_id || "TEAM_ID"}\`.`
          : null,
        diagnostic: enterpriseRoutingMissing ? {
          classification: "enterprise_routing",
          retryable: false,
          requiresAdmin: false,
          action: "configure_team_id",
          rawError: "enterprise_team_id_not_configured",
        } : null,
      });

      await runApiProbe(checks, "api.current_user", async () => {
        const userInfo = await callSlackApi(apiArgs, "users.info", {
          user: authJson.user_id,
          include_locale: true,
        });
        if (!userInfo.json?.ok) throw slackApiError(userInfo, "users_info_failed");
        if (!userInfo.json.user || typeof userInfo.json.user !== "object") {
          throw slackApiError(userInfo, "invalid_users_info_response");
        }
        const user = userInfo.json.user;
        const restricted = Boolean(user.is_restricted || user.is_ultra_restricted || user.deleted);
        return {
          result: userInfo,
          status: restricted ? "warn" : null,
          summary: user.deleted
            ? "Authenticated Slack account is deactivated"
            : user.is_ultra_restricted
              ? "Authenticated Slack account is a single-channel guest"
              : user.is_restricted
                ? "Authenticated Slack account is a restricted guest"
                : "Authenticated Slack account is an unrestricted member",
          details: {
            userId: user.id || authJson.user_id || null,
            teamId: user.team_id || null,
            isAdmin: Boolean(user.is_admin),
            isOwner: Boolean(user.is_owner),
            isPrimaryOwner: Boolean(user.is_primary_owner),
            isRestricted: Boolean(user.is_restricted),
            isUltraRestricted: Boolean(user.is_ultra_restricted),
            isDeleted: Boolean(user.deleted),
          },
          remediation: restricted
            ? "Expect reduced channel visibility and ask a Slack administrator if broader access is required."
            : null,
          diagnostic: restricted ? {
            classification: "account_restriction",
            retryable: false,
            requiresAdmin: true,
            action: "review_account_role",
            rawError: user.deleted ? "account_inactive" : user.is_ultra_restricted ? "ultra_restricted_user" : "restricted_user",
          } : null,
        };
      });

      let unreadConversations = null;
      const unreadProbe = await runApiProbe(checks, "api.unread_counts", async () => {
        const counts = await callSlackApi(apiArgs, "users.counts", {});
        if (!counts.json?.ok) throw slackApiError(counts, "users_counts_failed", { privateEndpoint: true });
        const countGroups = ["channels", "ims", "mpims"];
        if (!countGroups.some((key) => Object.prototype.hasOwnProperty.call(counts.json, key))) {
          throw slackApiError(counts, "invalid_users_counts_response", { privateEndpoint: true });
        }
        if (counts.json.response_metadata?.next_cursor) {
          throw slackApiError(counts, "users_counts_pagination_unsupported", { privateEndpoint: true });
        }
        const extractUnread = dependencies.extractUnreadConversationCounts
          || require("./slack-api-mark-read.cjs").extractUnreadConversationCounts;
        unreadConversations = extractUnread(counts.json, { types: "public_channel,private_channel,im,mpim" });
        return {
          result: counts,
          summary: "users.counts returned a compatible unread selection response",
          details: {
            positiveUnreadConversations: unreadConversations.length,
            responseGroups: countGroups.filter((key) => Object.prototype.hasOwnProperty.call(counts.json, key)),
            endpointContract: "private_browser_api",
          },
          value: unreadConversations,
        };
      });

      let mutedConversationIds = null;
      await runApiProbe(checks, "api.notification_preferences", async () => {
        const prefs = await callSlackApi(apiArgs, "users.prefs.get", {});
        if (!prefs.json?.ok) throw slackApiError(prefs, "users_prefs_get_failed", { privateEndpoint: true });
        if (!prefs.json.prefs || typeof prefs.json.prefs !== "object") {
          throw slackApiError(prefs, "invalid_users_prefs_response", { privateEndpoint: true });
        }
        const extractMuted = dependencies.extractMutedConversationIds
          || require("./slack-api-mark-read.cjs").extractMutedConversationIds;
        const muted = extractMuted(prefs.json.prefs);
        mutedConversationIds = muted.mutedConversationIds;
        const missingSource = muted.sources.length === 0;
        return {
          result: prefs,
          status: missingSource ? "warn" : null,
          summary: missingSource
            ? "Notification preferences are readable but contain no recognized mute-data source"
            : "Notification preferences are readable and mute data is parseable",
          details: {
            mutedConversations: muted.mutedConversationIds.size,
            sources: muted.sources,
            endpointContract: "private_browser_api",
          },
          remediation: missingSource
            ? "Do not rely on mute filtering until the CLI recognizes this workspace's preference schema."
            : null,
          diagnostic: missingSource ? {
            classification: "compatibility",
            retryable: false,
            requiresAdmin: false,
            action: "update_cli_or_report_schema_change",
            rawError: "mute_preference_source_missing",
          } : null,
          value: muted,
        };
      });

      await runApiProbe(checks, "api.conversations", async () => {
        const conversations = await callSlackApi(apiArgs, "conversations.list", {
          types: "public_channel,private_channel,im,mpim",
          exclude_archived: true,
          limit: 1,
          team_id: configured.teamId,
        });
        if (!conversations.json?.ok) throw slackApiError(conversations, "conversations_list_failed");
        if (!Array.isArray(conversations.json.channels)) {
          throw slackApiError(conversations, "invalid_conversations_list_response");
        }
        return {
          result: conversations,
          summary: "conversations.list is available for channel resolution",
          details: { sampleSize: conversations.json.channels.length },
        };
      });

      if (!args.deep) {
        pushCheck(checks, "api.unread_coverage", "slack-api", "skip", "Skipped unless --deep is requested");
      } else if (!unreadProbe.ok || !Array.isArray(unreadConversations)) {
        pushCheck(checks, "api.unread_coverage", "slack-api", "skip", "Skipped because unread selection is unavailable");
      } else {
        const selected = unreadConversations.slice(0, args.maxDeepConversations);
        const unresolved = [];
        let resolved = 0;
        let archived = 0;
        let externallyShared = 0;
        let muted = 0;
        const warnings = [];
        for (const conversation of selected) {
          try {
            const info = await callSlackApi(apiArgs, "conversations.info", {
              channel: conversation.id,
              include_num_members: false,
            });
            warnings.push(...responseDiagnostics(info).warnings);
            if (!info.json?.ok) throw slackApiError(info, "conversations_info_failed");
            if (!info.json.channel || typeof info.json.channel !== "object") {
              throw slackApiError(info, "invalid_conversations_info_response");
            }
            resolved += 1;
            if (info.json.channel.is_archived) archived += 1;
            if (info.json.channel.is_ext_shared || info.json.channel.is_org_shared) externallyShared += 1;
            if (mutedConversationIds?.has(conversation.id)) muted += 1;
          } catch (error) {
            const diagnostic = classifySlackFailure(error);
            unresolved.push({
              channelId: conversation.id,
              rawError: diagnostic.rawError,
              classification: diagnostic.classification,
              retryable: diagnostic.retryable,
              requiresAdmin: diagnostic.requiresAdmin,
            });
          }
        }
        const truncated = unreadConversations.length > selected.length;
        const degraded = unresolved.length > 0 || truncated || warnings.length > 0;
        const primary = unresolved[0] || null;
        pushCheck(checks, "api.unread_coverage", "slack-api", degraded ? "warn" : "pass", degraded
          ? `Deep unread coverage found ${unresolved.length} unresolved conversation(s)${truncated ? " and reached its safety cap" : ""}`
          : `Deep unread coverage resolved all ${resolved} positive unread conversation(s)`, {
          details: {
            positiveUnreadConversations: unreadConversations.length,
            examinedConversations: selected.length,
            resolvedConversations: resolved,
            unresolvedConversations: unresolved,
            archivedConversations: archived,
            externallySharedConversations: externallyShared,
            mutedConversations: mutedConversationIds ? muted : null,
            truncated,
            limit: args.maxDeepConversations,
            warnings: [...new Set(warnings)],
          },
          remediation: unresolved.length
            ? "Inspect unresolved conversation IDs for stale unread state, archival, workspace mismatch, or enterprise visibility restrictions."
            : truncated
              ? "Increase --max-deep-conversations to audit every unread conversation."
              : warnings.length
                ? "Inspect Slack's response warnings before relying on complete unread coverage."
                : null,
          diagnostic: primary ? {
            classification: primary.classification,
            retryable: primary.retryable,
            requiresAdmin: primary.requiresAdmin,
            action: primary.requiresAdmin ? "contact_workspace_admin" : "inspect_unresolved_conversation",
            rawError: primary.rawError,
          } : truncated ? {
            classification: "coverage_limit",
            retryable: true,
            requiresAdmin: false,
            action: "increase_deep_conversation_limit",
            rawError: "deep_conversation_limit_reached",
          } : null,
        });
      }
    }
  }

  pushCheck(checks, "capabilities.slack_mutations", "safety", "skip", "Slack mutation capabilities are intentionally not tested", {
    details: {
      status: "unknown_not_safely_testable",
      operations: ["send", "reply", "react", "upload", "draft", "mark-read"],
      reason: "Testing these capabilities would change Slack state.",
    },
  });

  const summary = summarizeChecks(checks);
  const status = summary.failed > 0 ? "unhealthy" : summary.warnings > 0 ? "degraded" : "healthy";
  const strictSatisfied = summary.failed === 0 && (!args.strict || summary.warnings === 0);
  return {
    schemaVersion: 1,
    ok: summary.failed === 0,
    strictSatisfied,
    exitCode: strictSatisfied ? 0 : 1,
    status,
    strict: args.strict,
    offline: args.offline,
    deep: args.deep,
    generatedAt: new Date(dependencies.now ? dependencies.now() : Date.now()).toISOString(),
    safety: {
      localMutation: false,
      slackMutation: false,
      browserLaunched: false,
      messageContentRead: false,
    },
    environment: {
      nodeVersion,
      platform: dependencies.platform || process.platform,
      arch: dependencies.arch || process.arch,
      packageVersion: manifestValid ? manifest.value.version : null,
    },
    capabilities: buildCapabilities(checks),
    summary,
    checks,
  };
}

function exitCodeForReport(report, strict = report?.strict) {
  if (!report || report.summary?.failed > 0) return 1;
  if (strict && report.summary?.warnings > 0) return 1;
  return 0;
}

function formatHumanReport(report, options = {}) {
  const labels = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
  const lines = [`Slack API CLI doctor: ${report.status.toUpperCase()}`, ""];
  for (const check of report.checks) {
    lines.push(`[${labels[check.status]}] ${check.id}: ${check.summary}`);
    if (check.remediation && check.status !== "pass") lines.push(`       Fix: ${check.remediation}`);
    if (options.verbose && check.details) {
      for (const line of JSON.stringify(check.details, null, 2).split("\n")) lines.push(`       ${line}`);
    }
  }
  lines.push("", `Summary: ${report.summary.passed} passed, ${report.summary.warnings} warnings, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`);
  lines.push("Safety: read-only, no browser launch, no Slack mutation, no message content read.");
  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv, dependencies);
  if (args.help) {
    printHelp();
    return null;
  }
  const report = await runDoctor(args, dependencies);
  const output = args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatHumanReport(report, { verbose: args.verbose });
  (dependencies.stdout || process.stdout).write(output);
  return report;
}

if (require.main === module) {
  main().then((report) => {
    if (report) process.exitCode = exitCodeForReport(report);
  }).catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  auditSessionFiles,
  buildCapabilities,
  classifySlackFailure,
  defaultPaths,
  exitCodeForReport,
  formatHumanReport,
  main,
  parseArgs,
  runDoctor,
};
