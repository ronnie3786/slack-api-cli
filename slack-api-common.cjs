const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const APP_NAME = "slack-api-cli";
const CONFIG_DIR = process.env.SLACK_API_CONFIG_DIR
  || (process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, APP_NAME)
    : path.join(os.homedir(), ".config", APP_NAME));
const DATA_DIR = process.env.SLACK_API_DATA_DIR
  || (process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, APP_NAME)
    : path.join(os.homedir(), ".local", "share", APP_NAME));
const DEFAULT_CONFIG_PATH = process.env.SLACK_API_CONFIG
  || path.join(CONFIG_DIR, "config.json");
const DEFAULT_PROFILE = path.join(DATA_DIR, "browser-profile");
const DEFAULT_AUTH_CACHE = path.join(DATA_DIR, "auth.json");
const DEFAULT_SESSION_DIR = process.env.SLACK_API_SESSION_DIR
  || path.join(DATA_DIR, "sessions");
const DEFAULT_CONVERSATION_TYPES = "public_channel,private_channel,im,mpim";
const DEFAULT_SLACK_REQUEST_TIMEOUT_MS = 30_000;

function normalizeWorkspaceUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid Slack workspace URL: ${value}`);
  }
  if (!url.hostname) throw new Error(`Invalid Slack workspace URL: ${value}`);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(configPath, "utf8"));
    return {
      workspace: normalizeWorkspaceUrl(parsed.workspace),
      teamId: String(parsed.teamId || "").trim(),
      profile: parsed.profile ? path.resolve(parsed.profile) : "",
      authCache: parsed.authCache ? path.resolve(parsed.authCache) : "",
      configPath,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { configPath };
    throw new Error(`Could not read Slack CLI config at ${configPath}: ${error.message}`);
  }
}

async function saveConfig(config, configPath = DEFAULT_CONFIG_PATH) {
  const serialized = {
    workspace: normalizeWorkspaceUrl(config.workspace),
    teamId: String(config.teamId || "").trim(),
    profile: path.resolve(config.profile || DEFAULT_PROFILE),
    authCache: path.resolve(config.authCache || DEFAULT_AUTH_CACHE),
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(serialized, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return serialized;
}

const DEFAULT_CONFIG = loadConfig();
const DEFAULT_WORKSPACE = process.env.SLACK_WORKSPACE_URL
  ? normalizeWorkspaceUrl(process.env.SLACK_WORKSPACE_URL)
  : (DEFAULT_CONFIG.workspace || "");
const DEFAULT_TEAM_ID = process.env.SLACK_TEAM_ID || DEFAULT_CONFIG.teamId || "";

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    // Fall through to explicit local install candidates.
  }

  const candidates = [
    path.join(__dirname, "node_modules"),
    path.join(process.cwd(), "node_modules"),
  ];

  for (const nodeModulesPath of candidates) {
    try {
      const requireFromCandidate = createRequire(path.join(nodeModulesPath, "playwright-loader.cjs"));
      return requireFromCandidate("playwright");
    } catch {
      // Try the next known local install.
    }
  }

  throw new Error("Playwright is not available. Run `npm install` in this directory, then retry.");
}

function loadPlaywrightVersion() {
  try {
    return require("playwright/package.json").version;
  } catch {
    // Fall through to explicit local install candidates.
  }

  const candidates = [
    path.join(__dirname, "node_modules"),
    path.join(process.cwd(), "node_modules"),
  ];

  for (const nodeModulesPath of candidates) {
    try {
      const requireFromCandidate = createRequire(path.join(nodeModulesPath, "playwright-loader.cjs"));
      return requireFromCandidate("playwright/package.json").version;
    } catch {
      // Try the next known local install.
    }
  }

  return "";
}

function playwrightInstallCommand() {
  const version = loadPlaywrightVersion();
  return version ? `npx playwright@${version} install chromium` : "npx playwright install chromium";
}

function playwrightBrowserInstallError(check = {}) {
  const lines = [
    "Playwright's Chromium browser is not installed for this CLI.",
  ];

  if (check.executablePath) {
    lines.push("", "Expected browser executable:", `  ${check.executablePath}`);
  }

  lines.push(
    "",
    "Install the matching Playwright browser runtime:",
    "",
    `  ${check.installCommand || playwrightInstallCommand()}`,
    "",
    "Then rerun your slack-api command.",
  );

  return lines.join("\n");
}

function checkPlaywrightBrowser() {
  const { chromium } = loadPlaywright();
  const executablePath = typeof chromium.executablePath === "function"
    ? chromium.executablePath()
    : "";

  return {
    ok: !executablePath || fsSync.existsSync(executablePath),
    executablePath,
    installCommand: playwrightInstallCommand(),
  };
}

function ensurePlaywrightBrowserInstalled() {
  const check = checkPlaywrightBrowser();
  if (!check.ok) {
    throw new Error(playwrightBrowserInstallError(check));
  }
  return check;
}

async function ensurePrivateDirectory(directory, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(directory, 0o700);
  return directory;
}

function parseCommonArgs(argv, defaults = {}) {
  let configPath = DEFAULT_CONFIG_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      configPath = path.resolve(argv[index + 1]);
      break;
    }
  }

  const config = loadConfig(configPath);
  const args = {
    workspace: process.env.SLACK_WORKSPACE_URL
      ? normalizeWorkspaceUrl(process.env.SLACK_WORKSPACE_URL)
      : (config.workspace || DEFAULT_WORKSPACE),
    profile: process.env.SLACK_BROWSER_PROFILE || config.profile || DEFAULT_PROFILE,
    authCache: process.env.SLACK_API_AUTH_CACHE || config.authCache || DEFAULT_AUTH_CACHE,
    configPath: config.configPath || configPath,
    teamId: process.env.SLACK_TEAM_ID || config.teamId || DEFAULT_TEAM_ID,
    refreshAuth: false,
    headless: process.env.SLACK_HEADLESS !== "0",
    timeoutMs: 30_000,
    ...defaults,
  };

  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === "--workspace") args.workspace = normalizeWorkspaceUrl(next());
    else if (arg === "--profile") args.profile = path.resolve(next());
    else if (arg === "--auth-cache") args.authCache = path.resolve(next());
    else if (arg === "--config") args.configPath = path.resolve(next());
    else if (arg === "--refresh-auth") args.refreshAuth = true;
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--headed") args.headless = false;
    else remaining.push(arg);
  }

  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be at least 1000");
  }

  return { args, remaining };
}

function workspaceOrigin(workspace) {
  if (!workspace) {
    throw new Error("No Slack workspace URL configured. Run `slack-api setup` or pass --workspace https://your-workspace.slack.com.");
  }
  return new URL(workspace).origin;
}

function enterpriseOrigin(workspace) {
  const url = new URL(workspace);
  const team = url.hostname.replace(/\.slack\.com$/i, "");
  return `https://${team}.enterprise.slack.com`;
}

function isSlackClientPath(href) {
  try {
    const url = new URL(href);
    return /^\/client\/[A-Z0-9]+(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

function isTransientBrowserNetworkError(errorOrMessage) {
  const message = String(errorOrMessage?.message || errorOrMessage || "");
  return /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED/i.test(message);
}

function isChromeNetworkErrorPage(state) {
  const text = `${state.title || ""}\n${state.text || ""}`;
  return /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED|Your connection was interrupted|This site can.t be reached/i.test(text);
}

async function gotoWithTransientRetry(page, url, options) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await page.goto(url, options);
      return;
    } catch (error) {
      if (!isTransientBrowserNetworkError(error) || attempt === maxAttempts) {
        throw error;
      }
      await page.waitForTimeout(1_000 * attempt);
    }
  }
}

async function reloadWithTransientRetry(page, fallbackUrl, options) {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await page.reload(options);
      return;
    } catch (error) {
      if (!isTransientBrowserNetworkError(error) || attempt === maxAttempts) {
        await gotoWithTransientRetry(page, fallbackUrl, options);
        return;
      }
      await page.waitForTimeout(1_000 * attempt);
    }
  }
}

async function browserAuthFromContext(args, context, page, token, state = {}) {
  const cookies = await context.cookies([workspaceOrigin(args.workspace), "https://app.slack.com"]);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return {
    token,
    cookieHeader,
    cookieCount: cookies.length,
    tokenLength: token.length,
    pageUrl: page.url(),
    source: "browser",
    enterpriseToken: state.enterpriseToken || null,
    enterpriseId: state.enterpriseId || null,
  };
}

async function isBrowserAuthValid(args, auth) {
  try {
    const { json } = await slackApiCall({ ...args, auth }, "auth.test");
    return Boolean(json.ok);
  } catch {
    return false;
  }
}

async function loadBrowserAuth(args) {
  const { chromium } = loadPlaywright();
  ensurePlaywrightBrowserInstalled();
  await ensurePrivateDirectory(args.profile);

  const context = await chromium.launchPersistentContext(args.profile, {
    headless: args.headless,
    viewport: { width: 1440, height: 1000 },
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(args.timeoutMs);

  try {
    const clientUrl = `${workspaceOrigin(args.workspace)}/client`;
    const navigationOptions = {
      waitUntil: "domcontentloaded",
      timeout: args.timeoutMs,
    };
    await gotoWithTransientRetry(page, clientUrl, navigationOptions);

    const startedAt = Date.now();
    let auth = null;
    let state = {};
    let lastAuthTestAt = 0;
    while (Date.now() - startedAt < args.timeoutMs) {
      try {
        state = await page.evaluate(() => {
          const text = document.body?.innerText || "";
          const bootData = window.TS?.boot_data || window.boot_data || {};
          const tokenValue = bootData.api_token || "";
          const enterpriseTokenValue = bootData.enterprise_api_token || "";
          const userId = bootData.user_id || bootData.self?.id || "";
          const teamId = bootData.team_id || bootData.team?.id || "";
          const hasLoginText = /sign in|continue|magic code|password|two-factor|2fa|single sign-on|sso/i.test(text);
          return {
            href: location.href,
            title: document.title,
            text,
            hasToken: Boolean(tokenValue),
            token: tokenValue,
            enterpriseToken: enterpriseTokenValue || null,
            enterpriseId: bootData.enterprise_id || bootData.enterprise?.id || null,
            hasLoginText,
            hasUser: Boolean(userId),
            hasTeam: Boolean(teamId),
          };
        });
      } catch (error) {
        const message = String(error?.message || error);
        if (/Execution context was destroyed|Cannot find context|Frame was detached/i.test(message)) {
          await page.waitForTimeout(500);
          continue;
        }
        throw error;
      }

      if (isChromeNetworkErrorPage(state)) {
        await reloadWithTransientRetry(page, clientUrl, navigationOptions);
        continue;
      }

      const appearsSignedIn = state.hasToken
        && (isSlackClientPath(state.href) || (!state.hasLoginText && (state.hasUser || state.hasTeam)));

      if (appearsSignedIn && Date.now() - lastAuthTestAt > 1_000) {
        lastAuthTestAt = Date.now();
        const candidateAuth = await browserAuthFromContext(args, context, page, state.token, state);
        if (await isBrowserAuthValid(args, candidateAuth)) {
          auth = candidateAuth;
          break;
        }
      }
      if (state.hasLoginText && args.headless) {
        throw new Error("Slack is asking for interactive login. Rerun with `--headed`, complete login, then rerun headless.");
      }
      await page.waitForTimeout(500);
    }

    if (!auth) {
      throw new Error(`Could not extract a validated Slack browser session from ${state.href || args.workspace}.`);
    }

    return auth;
  } finally {
    await context.close();
  }
}

async function loadCachedAuth(args) {
  if (!args.authCache) return null;

  let raw;
  try {
    raw = await fs.readFile(args.authCache, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read Slack auth cache at ${args.authCache}: ${error.message}`);
  }

  let cached;
  try {
    cached = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Slack auth cache at ${args.authCache} is not valid JSON. Run \`slack-api auth --refresh\` to rebuild it.`);
  }

  if (!args.workspace && cached.workspace) {
    args.workspace = normalizeWorkspaceUrl(cached.workspace);
  }

  if (cached.workspace && workspaceOrigin(cached.workspace) !== workspaceOrigin(args.workspace)) {
    return null;
  }

  if (!cached.token || !cached.cookieHeader) {
    return null;
  }

  const cachedAtMs = cached.cachedAt ? Date.parse(cached.cachedAt) : NaN;
  const cacheAgeMs = Number.isFinite(cachedAtMs) ? Date.now() - cachedAtMs : null;
  return {
    token: cached.token,
    cookieHeader: cached.cookieHeader,
    workspace: cached.workspace || args.workspace,
    cookieCount: cached.cookieCount || cached.cookieHeader.split(";").filter(Boolean).length,
    tokenLength: String(cached.token).length,
    pageUrl: cached.pageUrl || null,
    source: "cache",
    cachePath: args.authCache,
    cachedAt: cached.cachedAt || null,
    cacheAgeMs,
    enterpriseToken: cached.enterpriseToken || null,
    enterpriseId: cached.enterpriseId || null,
  };
}

async function saveAuthCache(args, auth) {
  if (!args.authCache) return null;

  await fs.mkdir(path.dirname(args.authCache), { recursive: true });
  const cache = {
    workspace: args.workspace,
    profile: args.profile,
    token: auth.token,
    cookieHeader: auth.cookieHeader,
    cookieCount: auth.cookieCount,
    tokenLength: auth.tokenLength,
    pageUrl: auth.pageUrl,
    enterpriseToken: auth.enterpriseToken || null,
    enterpriseId: auth.enterpriseId || null,
    cachedAt: new Date().toISOString(),
  };

  await fs.writeFile(args.authCache, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(args.authCache, 0o600);
  return args.authCache;
}

function noCachedAuthError(args) {
  return [
    `No cached Slack browser auth found at ${args.authCache}.`,
    "Run setup once from a normal terminal:",
    "",
    "  slack-api setup",
    "",
    "Or refresh an already configured workspace:",
    "",
    "  slack-api auth --refresh --headed",
    "",
    "After that, search/read/react/reply use the cache and do not need to launch Chromium.",
  ].join("\n");
}

function browserAuthFailure(error) {
  const message = String(error?.message || error);
  if (/Executable doesn.t exist|Looks like Playwright was just installed or updated|Please run the following command to download new browsers/i.test(message)) {
    return playwrightBrowserInstallError();
  }
  if (/mach_port_rendezvous|Permission denied \(1100\)|Target page, context or browser has been closed|kill EPERM/i.test(message)) {
    return [
      "Could not refresh Slack browser auth because Chromium was blocked by the current sandbox.",
      "Run this once from a normal terminal, or with escalated permissions in Codex:",
      "",
      "  slack-api auth --refresh",
      "",
      "Then retry the Slack command. Cached auth avoids launching Chromium for normal reads/searches/replies/reactions.",
    ].join("\n");
  }
  return message;
}

async function loadAuth(args) {
  if (args.auth) return args.auth;

  if (!args.refreshAuth) {
    const cached = await loadCachedAuth(args);
    if (cached) return cached;
    throw new Error(noCachedAuthError(args));
  }

  let browserAuth;
  try {
    browserAuth = await loadBrowserAuth(args);
  } catch (error) {
    throw new Error(browserAuthFailure(error));
  }

  const cachePath = await saveAuthCache(args, browserAuth);
  return {
    ...browserAuth,
    cachePath,
  };
}

function slackRequestSignal(args = {}) {
  const configuredTimeoutMs = Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? Math.floor(configuredTimeoutMs)
    : DEFAULT_SLACK_REQUEST_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!args.signal) {
    return {
      timeoutMs,
      signal: timeoutSignal,
      cleanup() {},
    };
  }

  const controller = new AbortController();
  const sources = [args.signal, timeoutSignal];
  const abortFrom = (source) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  const listeners = sources.map((source) => {
    const listener = () => abortFrom(source);
    if (source.aborted) {
      abortFrom(source);
    } else {
      source.addEventListener("abort", listener, { once: true });
    }
    return [source, listener];
  });

  return {
    timeoutMs,
    signal: controller.signal,
    cleanup() {
      for (const [source, listener] of listeners) {
        source.removeEventListener("abort", listener);
      }
    },
  };
}

function throwSlackRequestFailure(error, args, request) {
  if (args.signal?.aborted) {
    throw new Error("Slack API request was cancelled");
  }
  if (request.signal.aborted && request.signal.reason?.name === "TimeoutError") {
    throw new Error(`Slack API request timed out after ${request.timeoutMs}ms`);
  }
  throw new Error(slackNetworkFailure(error));
}

async function slackApiCall(args, method, params = {}) {
  const auth = args.auth || await loadAuth(args);
  const workspace = args.workspace || auth.workspace;
  const useEnterprise = Boolean(args.enterprise) && Boolean(auth.enterpriseToken);
  const body = new URLSearchParams({
    token: useEnterprise ? auth.enterpriseToken : auth.token,
    ...cleanParams(params),
  });
  const request = slackRequestSignal(args);
  let response;
  let json;
  try {
    response = await fetch(`${useEnterprise ? enterpriseOrigin(workspace) : workspaceOrigin(workspace)}/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cookie": auth.cookieHeader,
        "origin": "https://app.slack.com",
        "referer": "https://app.slack.com/client",
      },
      body,
      signal: request.signal,
    });
    json = await response.json();
  } catch (error) {
    throwSlackRequestFailure(error, args, request);
  } finally {
    request.cleanup();
  }

  if (!json.ok && auth.source === "cache" && ["invalid_auth", "not_authed", "token_revoked", "account_inactive"].includes(json.error)) {
    json.authHint = "Cached Slack auth was rejected. Run `slack-api auth --refresh` once, then retry.";
  }
  return { response, json, auth };
}

function slackNetworkFailure(error) {
  const message = String(error?.message || error);
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|network/i.test(message)) {
    return [
      "Slack API request failed before Slack responded.",
      "In Codex sandboxed sessions this usually means external network access was blocked.",
      "Rerun the same `slack-api ...` command with escalated permissions and approve the `slack-api` command prefix if prompted.",
      "",
      `Original error: ${message}`,
    ].join("\n");
  }
  return message;
}

function cleanParams(params) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => {
        if (typeof value === "boolean") return [key, String(value)];
        if (typeof value === "object") return [key, JSON.stringify(value)];
        return [key, String(value)];
      }),
  );
}

function parsePermalink(link) {
  const url = new URL(link);
  const match = url.pathname.match(/\/archives\/([^/]+)\/p(\d{10})(\d{6})/);
  if (!match) throw new Error(`Could not parse Slack permalink: ${link}`);

  const channelId = match[1];
  const messageTs = `${match[2]}.${match[3]}`;
  const threadTs = url.searchParams.get("thread_ts") || messageTs;
  const rootTs = String(threadTs).replace(/[^\d.]/g, "");

  return {
    channelId,
    messageTs,
    rootTs,
    isThreadReply: messageTs !== rootTs,
  };
}

function exactPhraseQuery(query) {
  if (/^".*"$/.test(query)) return query;
  return `"${query.replaceAll('"', '\\"')}"`;
}

function looksLikeSlackSearchModifier(query) {
  return /(?:^|\s)(?:from|in|to|has|is|before|after|on|during):\S+/i.test(String(query || ""));
}

function authorFilter(author) {
  const value = String(author || "").trim();
  if (!value || /^(all|any|none)$/i.test(value)) return "";
  if (/^from:/i.test(value)) return value;
  return `from:${value}`;
}

function dateFilter(name, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`--${name} must use YYYY-MM-DD`);
  }
  return `${name}:${normalized}`;
}

function slackSearchQuery(query, author, filters = [], options = {}) {
  const rawQuery = options.rawQuery || looksLikeSlackSearchModifier(query);
  const baseQuery = rawQuery ? String(query || "").trim() : exactPhraseQuery(query);
  return [baseQuery, authorFilter(author), ...filters].filter(Boolean).join(" ");
}

function normalizeEmojiName(value) {
  return String(value || "")
    .trim()
    .replace(/^:+/, "")
    .replace(/:+$/, "")
    .replace(/\s+/g, "_")
    .toLowerCase();
}

async function readMessageText(args) {
  if (args.messageFile) return fs.readFile(args.messageFile, "utf8");
  return args.message;
}

function permalinkFor(workspace, channelId, ts) {
  return `${workspaceOrigin(workspace)}/archives/${channelId}/p${String(ts).replace(".", "")}`;
}

function parseDurationSeconds(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(?:\s*)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) {
    throw new Error("Duration must look like 30s, 5m, 12h, or 2d");
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Duration must be greater than zero");
  }

  const unit = match[2].toLowerCase();
  if (unit.startsWith("s")) return amount;
  if (unit.startsWith("m")) return amount * 60;
  if (unit.startsWith("h")) return amount * 60 * 60;
  if (unit.startsWith("d")) return amount * 24 * 60 * 60;
  throw new Error(`Unsupported duration unit: ${unit}`);
}

function parseTimestampSeconds(value, flagName = "timestamp") {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive Unix or Slack timestamp`);
  }
  return parsed;
}

function buildTimeWindow(args) {
  const nowSeconds = Date.now() / 1000;
  const sinceFromDuration = args.since ? nowSeconds - parseDurationSeconds(args.since) : null;
  const sinceTs = args.sinceTs ? parseTimestampSeconds(args.sinceTs, "--since-ts") : sinceFromDuration;
  const untilTs = args.untilTs ? parseTimestampSeconds(args.untilTs, "--until-ts") : null;

  if (sinceTs !== null && untilTs !== null && sinceTs > untilTs) {
    throw new Error("--since/--since-ts must be before --until-ts");
  }

  return {
    nowTs: nowSeconds,
    sinceTs,
    untilTs,
    since: args.since || null,
  };
}

function isTimestampInWindow(ts, timeWindow) {
  const parsed = Number(ts);
  if (!Number.isFinite(parsed)) return false;
  if (timeWindow.sinceTs !== null && parsed < timeWindow.sinceTs) return false;
  if (timeWindow.untilTs !== null && parsed > timeWindow.untilTs) return false;
  return true;
}

function parsePositiveInt(value, flagName, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${flagName} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function normalizeChannelName(value) {
  return String(value || "").trim().replace(/^#/, "").toLowerCase();
}

function looksLikeChannelId(value) {
  return /^[CDG][A-Z0-9]+$/.test(String(value || "").trim());
}

function summarizeChannel(channel) {
  return {
    id: channel.id || null,
    name: channel.name || channel.name_normalized || null,
    isChannel: Boolean(channel.is_channel),
    isGroup: Boolean(channel.is_group),
    isIm: Boolean(channel.is_im),
    isMpim: Boolean(channel.is_mpim),
    isPrivate: Boolean(channel.is_private),
    isArchived: Boolean(channel.is_archived),
    isMember: Boolean(channel.is_member),
    user: channel.user || null,
    topic: channel.topic?.value || null,
    purpose: channel.purpose?.value || null,
    numMembers: channel.num_members ?? null,
  };
}

function summarizeMessage(args, message, includeText) {
  return {
    user: message.user || null,
    username: message.username || null,
    type: message.type || null,
    subtype: message.subtype || null,
    ts: message.ts || null,
    threadTs: message.thread_ts || null,
    replyCount: message.reply_count || 0,
    replyUsersCount: message.reply_users_count || 0,
    latestReply: message.latest_reply || null,
    permalink: message.ts ? permalinkFor(args.workspace, message.channel || "", message.ts) : null,
    text: includeText ? (message.text || "") : "[redacted; rerun with --include-text to save message text]",
    reactionNames: Array.isArray(message.reactions)
      ? message.reactions.map((reaction) => reaction.name).filter(Boolean)
      : [],
    files: Array.isArray(message.files)
      ? message.files.map((file) => ({
        id: file.id || null,
        name: file.name || null,
        title: file.title || null,
        mimetype: file.mimetype || null,
        filetype: file.filetype || null,
        urlPrivateDownload: file.url_private_download || null,
      }))
      : [],
  };
}

async function paginateSlackApi(args, method, params = {}, itemsKey, options = {}) {
  const limit = options.limit || params.limit || 200;
  const maxPages = options.maxPages || 10;
  const items = [];
  const pages = [];
  let cursor = params.cursor || "";

  for (let page = 0; page < maxPages; page += 1) {
    const { response, json, auth } = await slackApiCall(args, method, {
      ...params,
      limit,
      cursor,
    });
    const pageItems = Array.isArray(json[itemsKey]) ? json[itemsKey] : [];
    items.push(...pageItems);
    pages.push({
      ok: json.ok,
      status: response.status,
      error: json.error,
      itemCount: pageItems.length,
      cursor,
      nextCursor: json.response_metadata?.next_cursor || "",
      authSource: auth.source,
    });

    if (!json.ok) return { ok: false, error: json.error, items, pages, json };
    cursor = json.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }

  return { ok: true, error: null, items, pages, cursor };
}

async function listConversations(args, options = {}) {
  return paginateSlackApi(
    args,
    "conversations.list",
    {
      types: options.types || DEFAULT_CONVERSATION_TYPES,
      exclude_archived: options.excludeArchived !== false,
      team_id: options.teamId || args.teamId || DEFAULT_TEAM_ID,
    },
    "channels",
    {
      limit: options.limit || 1000,
      maxPages: options.maxPages || 20,
    },
  );
}

async function resolveChannel(args, value, options = {}) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("--channel is required");

  if (looksLikeChannelId(raw)) {
    const { response, json, auth } = await slackApiCall(args, "conversations.info", {
      channel: raw,
      include_num_members: true,
    });
    return {
      ok: json.ok,
      error: json.error,
      channelId: raw,
      channel: json.channel ? summarizeChannel(json.channel) : null,
      responseStatus: response.status,
      authSource: auth.source,
      candidates: [],
    };
  }

  const normalized = normalizeChannelName(raw);
  const listed = await listConversations(args, options);
  const exact = listed.items.find((channel) => normalizeChannelName(channel.name || channel.name_normalized) === normalized);
  const candidates = listed.items
    .filter((channel) => normalizeChannelName(channel.name || channel.name_normalized).includes(normalized))
    .slice(0, options.candidateLimit || 10)
    .map(summarizeChannel);

  if (!listed.ok) {
    return {
      ok: false,
      error: listed.error,
      channelId: null,
      channel: null,
      candidates,
      listPages: listed.pages,
    };
  }

  if (!exact) {
    return {
      ok: false,
      error: "channel_not_found",
      channelId: null,
      channel: null,
      candidates,
      listPages: listed.pages,
    };
  }

  return {
    ok: true,
    error: null,
    channelId: exact.id,
    channel: summarizeChannel(exact),
    candidates,
    listPages: listed.pages,
  };
}

function summarizeUser(user) {
  return {
    id: user.id || null,
    teamId: user.team_id || null,
    name: user.name || null,
    realName: user.real_name || null,
    displayName: user.profile?.display_name || null,
    email: user.profile?.email || null,
    title: user.profile?.title || null,
    isBot: Boolean(user.is_bot),
    isDeleted: Boolean(user.deleted),
    isRestricted: Boolean(user.is_restricted),
    isUltraRestricted: Boolean(user.is_ultra_restricted),
    tz: user.tz || null,
  };
}

async function listUsers(args, options = {}) {
  return paginateSlackApi(
    args,
    "users.list",
    {
      team_id: options.teamId || args.teamId || DEFAULT_TEAM_ID,
      include_locale: Boolean(options.includeLocale),
    },
    "members",
    {
      limit: options.limit || 200,
      maxPages: options.maxPages || 20,
    },
  );
}

function userMatchesQuery(user, query) {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return true;
  const profile = user.profile || {};
  return [
    user.id,
    user.name,
    user.real_name,
    profile.real_name,
    profile.display_name,
    profile.email,
    profile.title,
  ].some((value) => String(value || "").toLowerCase().includes(normalized));
}

async function resolveUser(args, value, options = {}) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("--user, --email, or --query is required");

  if (/^U[A-Z0-9]+$/.test(raw)) {
    return { ok: true, error: null, userId: raw, user: null, candidates: [] };
  }

  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
    const { json } = await slackApiCall(args, "users.lookupByEmail", { email: raw });
    if (json.ok && json.user?.id) {
      return { ok: true, error: null, userId: json.user.id, user: summarizeUser(json.user), candidates: [] };
    }
  }

  const listed = await listUsers(args, options);
  const matches = listed.items
    .filter((user) => userMatchesQuery(user, raw))
    .filter((user) => options.includeDeleted || !user.deleted)
    .filter((user) => options.includeBots || !user.is_bot);
  const exact = matches.find((user) => {
    const profile = user.profile || {};
    return [user.name, user.real_name, profile.real_name, profile.display_name, profile.email]
      .some((value) => String(value || "").toLowerCase() === raw.toLowerCase());
  }) || (matches.length === 1 ? matches[0] : null);

  if (!listed.ok) {
    return { ok: false, error: listed.error, userId: null, user: null, candidates: matches.slice(0, 10).map(summarizeUser) };
  }
  if (!exact) {
    return { ok: false, error: "user_not_found_or_ambiguous", userId: null, user: null, candidates: matches.slice(0, 10).map(summarizeUser) };
  }

  return { ok: true, error: null, userId: exact.id, user: summarizeUser(exact), candidates: matches.slice(0, 10).map(summarizeUser) };
}

async function fetchSlackPrivateUrl(args, url) {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const isSlackOwned = hostname === "slack.com"
    || hostname.endsWith(".slack.com")
    || hostname.endsWith(".slack-edge.com")
    || hostname.endsWith(".slack-files.com");
  if (!isSlackOwned) {
    throw new Error(`Refusing to send Slack browser credentials to non-Slack file host: ${hostname}`);
  }

  const auth = args.auth || await loadAuth(args);
  const request = slackRequestSignal(args);
  let response;
  let buffer;
  try {
    response = await fetch(url, {
      headers: {
        "authorization": `Bearer ${auth.token}`,
        "cookie": auth.cookieHeader,
        "referer": "https://app.slack.com/client",
      },
      signal: request.signal,
    });
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throwSlackRequestFailure(error, args, request);
  } finally {
    request.cleanup();
  }

  const contentType = response.headers.get("content-type") || "";
  return { response, contentType, buffer, auth };
}

module.exports = {
  APP_NAME,
  DEFAULT_AUTH_CACHE,
  DEFAULT_CONFIG_PATH,
  DEFAULT_CONVERSATION_TYPES,
  DEFAULT_CONFIG,
  DEFAULT_PROFILE,
  DEFAULT_SESSION_DIR,
  DEFAULT_TEAM_ID,
  DEFAULT_WORKSPACE,
  authorFilter,
  buildTimeWindow,
  dateFilter,
  ensurePlaywrightBrowserInstalled,
  ensurePrivateDirectory,
  fetchSlackPrivateUrl,
  isTimestampInWindow,
  looksLikeSlackSearchModifier,
  loadAuth,
  loadBrowserAuth,
  loadCachedAuth,
  loadConfig,
  loadPlaywright,
  listConversations,
  listUsers,
  looksLikeChannelId,
  normalizeEmojiName,
  normalizeWorkspaceUrl,
  paginateSlackApi,
  parseCommonArgs,
  parseDurationSeconds,
  parsePermalink,
  parsePositiveInt,
  parseTimestampSeconds,
  permalinkFor,
  readMessageText,
  resolveChannel,
  resolveUser,
  saveAuthCache,
  saveConfig,
  slackApiCall,
  slackSearchQuery,
  summarizeChannel,
  summarizeMessage,
  summarizeUser,
  workspaceOrigin,
  enterpriseOrigin,
};
