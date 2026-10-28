// End-to-end tests for the ledger page (src/ui/ledger.html) in Chromium against a real relay
// started with `wrangler dev` (test/e2e/harness.mjs). Every piece of data is created through the
// relay's own API, and every page action is checked against the relay afterwards.
//
//   NO_PROXY=127.0.0.1,localhost node --test test/e2e/ledger-page.test.mjs
//
// Needs Playwright with Chromium: resolved from the repo, NODE_PATH or the global npm root
// (`npm i -g playwright && npx playwright install chromium`). Without it the whole suite is
// skipped with a message saying so; without a Chromium build every test is skipped with the reason.
// Screenshots (390x844, light and dark) go to $LEDGER_E2E_SHOTS (default: <tmpdir>/agent-relay-ledger-shots).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startRelay } from "./harness.mjs";

const TOKEN_KEY = "agent-relay-token";
const SHOTS_DIR = process.env.LEDGER_E2E_SHOTS || join(tmpdir(), "agent-relay-ledger-shots");
const PHONE = { width: 360, height: 740 };
const SHOT_VIEWPORT = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const REFRESH_BUDGET_MS = 12_500; // the page refreshes every 10 s
const RELAY_VARS = { MAX_ACTIVE_BUILDS: "100", BURST_PER_MINUTE: "1000" };

/** Playwright from the repo (or NODE_PATH), else from the global npm root; never installed by this suite. */
function loadPlaywright() {
  try {
    return { chromium: createRequire(import.meta.url)("playwright").chromium };
  } catch (error) {
    try {
      const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return { chromium: createRequire(join(root, "noop.js"))("playwright").chromium };
    } catch {
      return { error };
    }
  }
}
const pw = loadPlaywright();
const MISSING_PLAYWRIGHT = pw.error
  ? `playwright cannot be resolved (${pw.error.code ?? pw.error.message}); install it with ` +
    `"npm i -g playwright && npx playwright install chromium" (or "npm i --no-save playwright") to run the ledger page e2e suite`
  : false;
if (MISSING_PLAYWRIGHT) console.log(`# SKIP ledger page e2e: ${MISSING_PLAYWRIGHT}`);

// Relays run detached; if this run is interrupted, stop them instead of leaving wrangler behind.
// (node:test's own signal handler may exit before the harness deletes its temp dir; the processes are gone.)
const liveRelays = new Set();
async function launchRelay(options) {
  const relay = await startRelay(options);
  const stop = relay.stop;
  liveRelays.add(relay);
  relay.stop = async () => {
    liveRelays.delete(relay);
    await stop();
  };
  return relay;
}
let stoppingAll = null;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  // The test runner follows SIGINT with SIGTERM: every signal waits for the same shutdown.
  process.once(signal, async () => {
    stoppingAll ??= Promise.allSettled([...liveRelays].map((relay) => relay.stop()));
    await stoppingAll;
    process.exit(code);
  });
}

describe("ledger page against a real relay", { skip: MISSING_PLAYWRIGHT, timeout: 600_000 }, () => {
  /** @type {Awaited<ReturnType<typeof startRelay>>} */
  let relay;
  let browser;
  let launchError = null;

  before(async () => {
    try {
      browser = await pw.chromium.launch();
    } catch (error) {
      launchError = `Chromium could not be launched (${String(error.message).split("\n")[0]}); run "npx playwright install chromium"`;
      console.log(`# SKIP ledger page e2e: ${launchError}`);
      return;
    }
    relay = await launchRelay({ vars: RELAY_VARS });
  });

  after(async () => {
    await browser?.close();
    await relay?.stop();
  });

  /** A test that is skipped (with the reason) when Chromium could not be launched. */
  const pageTest = (name, fn) =>
    test(name, { timeout: 120_000 }, async (t) => {
      if (launchError) return t.skip(launchError);
      await fn(t);
    });

  // ------------------------------------------------------------------ relay helpers

  const mustOn = (r) => async (role, tool, input = {}) => {
    const res = await r.call(role, tool, input);
    if (!res.ok) throw new Error(`${role} ${tool} -> HTTP ${res.status} ${res.error?.code}: ${res.error?.message}`);
    return res.result;
  };
  const must = (role, tool, input) => mustOn(relay)(role, tool, input);

  const getJson = async (r, role, path) => {
    const res = await fetch(r.url + path, { headers: { authorization: `Bearer ${r.tokens[role]}` } });
    return { status: res.status, ...(await res.json()) };
  };
  const postJson = async (r, role, path, body) => {
    const res = await fetch(r.url + path, {
      method: "POST",
      headers: { authorization: `Bearer ${r.tokens[role]}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, ...(await res.json()) };
  };

  function seeder(r) {
    const call = mustOn(r);
    const s = {
      call,
      async build(title, extra = {}) {
        const b = await call("human", "build_create", { title, brief: extra.brief ?? `Brief for ${title}.`, ...extra });
        return b.build_id;
      },
      async task(buildId, { title, assignee = "developer", reviewer = "creative-director", description } = {}) {
        const input = { build_id: buildId, title, assignee };
        if (reviewer) input.reviewer = reviewer;
        if (description) input.description = description;
        return (await call("orchestrator", "ledger_update", input)).task.id;
      },
      async requestPlan(buildId, summary = "Plan: one screen, one task.") {
        return (await call("orchestrator", "gate_request", { build_id: buildId, kind: "plan_approval", summary })).gate.id;
      },
      /** planning build with T1 (developer, reviewed by creative-director) and a pending plan gate. */
      async planned(title, opts = {}) {
        const id = await s.build(title, opts.build);
        const taskId = await s.task(id, { title: opts.taskTitle ?? "Build the home screen", description: opts.taskDescription });
        const gateId = await s.requestPlan(id, opts.summary);
        return { id, taskId, gateId };
      },
      /** in_progress build with T1. */
      async inProgress(title, opts = {}) {
        const p = await s.planned(title, opts);
        await call("human", "gate_decide", { build_id: p.id, gate_id: p.gateId, decision: "approved" });
        return p;
      },
      async reviewRound(buildId, taskId, n, { verdict = "changes_requested", changes, label } = {}) {
        await call("developer", "send", {
          build_id: buildId, to_role: "creative-director", type: "review_request", task_id: taskId,
          body: `Round ${n}: the preview is up.`,
          links: [{ url: `https://preview.example.com/r${n}`, label: label ?? `Preview r${n}` }],
        });
        const v = { build_id: buildId, to_role: "developer", type: "verdict", task_id: taskId, verdict, body: `Round ${n} review.` };
        if (verdict === "changes_requested") v.changes = changes ?? ["Fix the hero crop.", "Raise the CTA contrast."];
        await call("creative-director", "send", v);
      },
      /** in_progress build whose T1 hit the review cap: pending escalation gate. */
      async escalated(title, opts = {}) {
        const p = await s.inProgress(title, opts);
        for (let n = 1; n <= 3; n++) await s.reviewRound(p.id, p.taskId, n, opts.round?.(n));
        const ledger = await s.ledger(p.id);
        const gate = ledger.gates.find((g) => g.kind === "escalation" && g.status === "pending");
        assert.ok(gate, "three changes_requested rounds must open an escalation gate");
        return { ...p, escalationId: gate.id };
      },
      ledger: (buildId) => call("human", "ledger_get", { build_id: buildId }),
    };
    return s;
  }
  const seed = () => seeder(relay);

  // ------------------------------------------------------------------ browser helpers

  /**
   * Opens a fresh browser context (own localStorage) watching for console errors, page errors,
   * native dialogs (alert/confirm fired by injected script), CSP violations, external requests
   * and token leaks into URLs.
   */
  async function openPage({ role = "human", viewport = DESKTOP, colorScheme = "light", hash = "", target = relay } = {}) {
    const context = await browser.newContext({ viewport, colorScheme });
    const problems = [];
    await context.exposeBinding("__e2eReport", (_source, kind, text) => problems.push({ kind, text }));
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__e2eReport?.("csp", `${e.violatedDirective} blocked ${e.blockedURI || "(inline)"} at ${e.sourceFile}:${e.lineNumber}`);
      });
    });
    if (role) {
      // Seed the saved token once per tab, so signing out and reloading really signs out.
      await context.addInitScript(([key, token]) => {
        if (!sessionStorage.getItem("__e2e_seeded")) {
          localStorage.setItem(key, token);
          sessionStorage.setItem("__e2e_seeded", "1");
        }
      }, [TOKEN_KEY, target.tokens[role]]);
    }
    const page = await context.newPage();
    const tokens = Object.values(target.tokens);
    page.on("console", (m) => {
      if (m.type() === "error") problems.push({ kind: "console", text: m.text() });
    });
    page.on("pageerror", (e) => problems.push({ kind: "pageerror", text: e.message }));
    page.on("dialog", (d) => {
      problems.push({ kind: "dialog", text: `${d.type()}: ${d.message()}` });
      d.dismiss().catch(() => {});
    });
    page.on("request", (r) => {
      const url = r.url();
      if (!url.startsWith(target.url) && !url.startsWith("data:")) problems.push({ kind: "external-request", text: url });
      if (tokens.some((tok) => url.includes(tok))) problems.push({ kind: "token-in-url", text: url.replace(/e2e-[\w-]+/g, "<token>") });
    });
    await page.goto(`${target.url}/${hash}`);
    return {
      context,
      page,
      problems,
      /** Fails on anything but the listed deliberate HTTP 4xx resource errors. */
      check({ allow = [] } = {}) {
        const deliberate = (p) =>
          p.kind === "console" && allow.some((code) => p.text.includes(`the server responded with a status of ${code}`));
        assert.deepEqual(problems.filter((p) => !deliberate(p)), [], "unexpected console errors, dialogs, CSP violations or requests");
      },
      close: () => context.close(),
    };
  }

  const waitPost = (page, path) =>
    page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "POST");
  const text = (page, selector) => page.locator(selector).first().innerText();

  async function assertNoHorizontalScroll(page, label) {
    const m = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const depth = (el) => { let d = 0; for (let n = el; n; n = n.parentElement) d++; return d; };
      // Deepest overflowing elements first: those are the culprits, their ancestors only stretch.
      const offenders = [...document.querySelectorAll("body *")]
        .filter((el) => {
          if (el.closest("[hidden], .sr-only, .skip-link")) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (r.right > vw + 0.5 || r.left < -0.5);
        })
        .sort((a, b) => depth(b) - depth(a))
        .slice(0, 4)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).replace(/\s+/g, ".")} right=${Math.round(el.getBoundingClientRect().right)}`);
      return { scrollWidth: document.documentElement.scrollWidth, clientWidth: vw, offenders };
    });
    assert.ok(
      m.scrollWidth <= m.clientWidth && m.offenders.length === 0,
      `${label}: page scrolls sideways (scrollWidth ${m.scrollWidth} > ${m.clientWidth}); overflowing: ${m.offenders.join(", ")}`,
    );
  }

  /** Every visible match of each selector must be at least 44x44 CSS px. */
  async function assertTapTargets(page, selectors, label) {
    const small = [];
    let checked = 0;
    for (const selector of selectors) {
      for (const el of await page.locator(selector).all()) {
        if (!(await el.isVisible())) continue;
        const box = await el.boundingBox();
        checked++;
        if (box && (box.height < 44 || box.width < 44)) {
          small.push(`${selector} "${(await el.innerText().catch(() => "")).trim().slice(0, 30)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
      }
    }
    assert.ok(checked > 0, `${label}: no tap targets found`);
    assert.deepEqual(small, [], `${label}: tap targets smaller than 44px`);
  }

  /** Nothing injected by data: no foreign elements, no inline handlers, no script-set globals. */
  async function assertNothingInjected(page) {
    const r = await page.evaluate(() => {
      const foreign = [...document.querySelectorAll("#app img, #app script, #app iframe, #app object, #app embed, #app svg:not(.icon)")].map(
        (el) => el.outerHTML.slice(0, 80),
      );
      const handlers = [...document.querySelectorAll("#app *")]
        .flatMap((el) => [...el.attributes].filter((a) => a.name.startsWith("on")).map((a) => `${el.tagName}[${a.name}]`));
      return { foreign, handlers, xss: window.__xss ?? null };
    });
    assert.deepEqual(r, { foreign: [], handlers: [], xss: null });
  }

  // ================================================================== tests

  pageTest("serves the page with a strict CSP and no third-party requests", async () => {
    const res = await fetch(`${relay.url}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");

    // Positive control: the CSP listener really reports violations.
    const s = await openPage({ role: null });
    try {
      await s.page.evaluate(() => {
        const img = new Image();
        img.src = "https://blocked.example.com/pixel.png";
        document.body.append(img);
      });
      await s.page.waitForTimeout(300);
      assert.ok(s.problems.some((p) => p.kind === "csp" && /img-src/.test(p.text)), "the CSP listener must see a blocked image");
    } finally {
      await s.close();
    }
  });

  pageTest("token prompt: bad token error, sign in with the human token, sign out", async () => {
    const s = await openPage({ role: null });
    const { page } = s;
    try {
      await page.waitForSelector("#signin:not([hidden])");
      assert.equal(await page.isHidden("#app"), true);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "token-input", "the token field has focus");

      // Show / hide the token.
      assert.equal(await page.getAttribute("#token-input", "type"), "password");
      await page.click("#token-reveal");
      assert.equal(await page.getAttribute("#token-input", "type"), "text");
      assert.equal(await page.getAttribute("#token-reveal", "aria-pressed"), "true");
      await page.click("#token-reveal");
      assert.equal(await page.getAttribute("#token-input", "type"), "password");

      // Empty, then a wrong token.
      await page.click("#signin-btn");
      assert.equal(await text(page, "#signin-msg"), "Enter your relay token.");
      await page.fill("#token-input", "definitely-not-a-relay-token-0123456789abcdef");
      await page.click("#signin-btn");
      await page.waitForFunction(() => document.getElementById("signin-msg").textContent.includes("not accepted"));
      assert.equal(await text(page, "#signin-msg"), "That token was not accepted. Check it and try again.");
      assert.equal(await page.isHidden("#app"), true);
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY), null, "a rejected token is not stored");

      // The human token, submitted with Enter.
      await page.fill("#token-input", relay.tokens.human);
      await page.press("#token-input", "Enter");
      await page.waitForSelector("#app:not([hidden])");
      assert.equal(await text(page, "#who-name"), "James");
      assert.equal(await text(page, "#who-role"), "human");
      assert.equal(await page.inputValue("#token-input"), "", "the token field is cleared");
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY), relay.tokens.human);
      await page.waitForSelector("#view-list:not([hidden])");

      // Survives a reload.
      await page.reload();
      await page.waitForSelector("#app:not([hidden])");
      assert.equal(await page.isHidden("#signin"), true);

      // Sign out clears the token and the data.
      await page.click("#signout");
      await page.waitForSelector("#signin:not([hidden])");
      assert.match(await text(page, "#signin-msg"), /Signed out/);
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY), null);
      assert.equal(await page.evaluate(() => document.getElementById("builds").childElementCount), 0);
      await page.reload();
      await page.waitForSelector("#signin:not([hidden])");
      assert.equal(await page.isHidden("#app"), true);
      s.check({ allow: [401] });
    } finally {
      await s.close();
    }
  });

  pageTest("builds list shows status, current owner and last message", async () => {
    const sd = seed();
    // A: awaiting plan approval, two owners, last message a question to the human.
    const a = await sd.build("List A: recipe box");
    await sd.task(a, { title: "Design spec", assignee: "creative-director", reviewer: null });
    await sd.task(a, { title: "Build the recipe list" });
    await sd.requestPlan(a, "Two tasks: design spec, then the list screen.");
    await sd.call("orchestrator", "send", { build_id: a, to_role: "human", type: "question", body: "Which colour palette do you prefer for the recipe box?" });
    // B: in progress, last message from the developer to the orchestrator.
    const b = await sd.inProgress("List B: habit tracker");
    await sd.call("developer", "send", { build_id: b.id, to_role: "orchestrator", type: "status", body: "Started on T1; scaffolding the repo now." });

    const s = await openPage();
    const { page } = s;
    try {
      const cardA = page.locator(`.build-card[href="#${a}"]`);
      const cardB = page.locator(`.build-card[href="#${b.id}"]`);
      await cardA.waitFor();
      assert.equal(await cardA.locator(".bc-title").innerText(), "List A: recipe box");
      assert.equal(await cardA.locator(".pill").first().innerText(), "Awaiting plan approval");
      assert.match(await cardA.locator(".bc-gate").innerText(), /Plan approval · needs you/);
      assert.equal(await cardA.locator(".bc-label").first().textContent(), "Current owners");
      const ownersA = (await cardA.locator(".owner-chip").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
      assert.deepEqual(ownersA.sort(), ["CD Creative Director T1", "D Full-Stack Developer T2"]);
      const lastA = (await cardA.locator(".bc-last-head").innerText()).replace(/\s+/g, " ");
      assert.match(lastA, /Orchestrator\s*→\s*to You/);
      assert.match(lastA, /question/);
      assert.equal(await cardA.locator(".bc-excerpt").innerText(), "Which colour palette do you prefer for the recipe box?");
      assert.ok((await page.locator(`.attention-item[href="#${a}"]`).count()) === 1, "build A is listed under gates needing a decision");

      assert.equal(await cardB.locator(".pill").first().innerText(), "In progress");
      assert.equal(await cardB.locator(".bc-label").first().textContent(), "Current owner");
      assert.deepEqual((await cardB.locator(".owner-chip").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim()), ["D Full-Stack Developer T1"]);
      assert.match((await cardB.locator(".bc-last-head").innerText()).replace(/\s+/g, " "), /Full-Stack Developer\s*→\s*to Orchestrator/);
      assert.equal(await cardB.locator(".bc-excerpt").innerText(), "Started on T1; scaffolding the repo now.");

      // What the page shows is what the relay says.
      const { builds } = await sd.call("human", "build_list", {});
      const summaryA = builds.find((x) => x.build_id === a);
      assert.equal(summaryA.status, "awaiting_plan_approval");
      assert.equal(summaryA.last_message.excerpt, "Which colour palette do you prefer for the recipe box?");
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("deep link #<build_id>, before and after sign-in; unknown and malformed ids", async () => {
    const sd = seed();
    const { id } = await sd.planned("Deep link build");

    // Opened while signed out: lands on the build after signing in.
    const out = await openPage({ role: null, hash: `#${id}` });
    try {
      await out.page.waitForSelector("#signin:not([hidden])");
      await out.page.fill("#token-input", relay.tokens.human);
      await out.page.click("#signin-btn");
      await out.page.waitForSelector(".detail-title");
      assert.equal(await text(out.page, ".detail-title"), "Deep link build");
      out.check();
    } finally {
      await out.close();
    }

    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.waitForSelector(".detail-title");
      assert.equal(await text(page, ".detail-title"), "Deep link build");
      assert.match(await text(page, ".detail-meta"), new RegExp(id));
      // Back to the list and forward again with browser history.
      await page.click("a.back");
      await page.waitForSelector(`.build-card[href="#${id}"]`);
      await page.goBack();
      await page.waitForSelector(".detail-title");
      assert.equal(new URL(page.url()).hash, `#${id}`);

      // A well-formed id that does not exist.
      await page.evaluate(() => { location.hash = "#b-aaaaaaaaaa"; });
      await page.waitForFunction(() => document.getElementById("build").textContent.includes("No build with ID"));
      assert.match(await text(page, "#build"), /No build with ID b-aaaaaaaaaa\./);
      assert.equal(await page.isHidden("#load-error"), true);

      // A mistyped link (the relay answers 400 invalid_input, not 404) must not leave the page on "Loading build…".
      await page.evaluate(() => { location.hash = "#not-a-build"; });
      await page.waitForTimeout(1500);
      const stuck = await page.evaluate(() => document.getElementById("build").textContent);
      assert.notEqual(stuck, "Loading build…", "malformed deep link #not-a-build stays on 'Loading build…' forever");
      s.check({ allow: [400, 404] });
    } finally {
      await s.close();
    }
  });

  pageTest("plan gate: approve by clicking (phone) → build in_progress", async () => {
    const sd = seed();
    const { id, gateId } = await sd.planned("Plan gate build", { summary: "Plan: T1 home screen, reviewed by the Creative Director." });
    const s = await openPage({ hash: `#${id}`, viewport: SHOT_VIEWPORT });
    const { page } = s;
    try {
      await page.waitForSelector(".gate");
      assert.equal(await text(page, ".gate-kind"), "Plan approval");
      assert.match(await text(page, ".gate-summary"), /T1 home screen/);
      assert.match(await text(page, ".gate-hint"), /Approve to start building/);
      await page.fill(".gate textarea", "Looks good, go ahead.");
      const [res] = await Promise.all([waitPost(page, "/api/call/gate_decide"), page.click(".gate .btn-approve")]);
      assert.equal((await res.json()).ok, true);
      assert.deepEqual(res.request().postDataJSON(), { build_id: id, gate_id: gateId, decision: "approved", note: "Looks good, go ahead." });
      await page.waitForFunction(() => document.querySelector(".detail-meta .pill")?.textContent === "In progress");
      await page.waitForSelector(".toast:has-text('Plan approval approved')");
      assert.equal(await page.locator(".gate").count(), 0, "the decided gate leaves the gate section");
      assert.match(await text(page, ".history"), /Plan approval[\s\S]*Approved/);

      const ledger = await sd.ledger(id);
      assert.equal(ledger.build.status, "in_progress");
      const gate = ledger.gates.find((g) => g.id === gateId);
      assert.equal(gate.status, "approved");
      assert.equal(gate.note, "Looks good, go ahead.");
      assert.equal(gate.decided_by, "human");
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("escalation gate: choose extra rounds, approve → task max_rounds grew", async () => {
    const sd = seed();
    const { id, taskId, escalationId } = await sd.escalated("Escalation build");
    const before = (await sd.ledger(id)).tasks.find((t) => t.id === taskId);
    assert.equal(before.status, "blocked");
    assert.equal(before.max_rounds, 3);

    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.waitForSelector(".gate select");
      assert.equal(await text(page, ".gate-kind"), "Escalation");
      assert.match(await text(page, ".gate-task"), /T1.*round 3 of 3/);
      assert.ok(await page.isVisible(".task .badge:text('Escalated')"));
      assert.equal(await page.inputValue(".gate select"), "1");
      await page.selectOption(".gate select", "3");
      const [res] = await Promise.all([waitPost(page, "/api/call/gate_decide"), page.click(".gate .btn-approve")]);
      assert.equal((await res.json()).ok, true);
      assert.deepEqual(res.request().postDataJSON(), { build_id: id, gate_id: escalationId, decision: "approved", extra_rounds: 3 });
      await page.waitForFunction(() => document.querySelector(".task-list")?.textContent.includes("3 of 6"));
      assert.match(await text(page, ".history"), /3 extra rounds/);

      const ledger = await sd.ledger(id);
      const task = ledger.tasks.find((t) => t.id === taskId);
      assert.equal(task.max_rounds, 6);
      assert.equal(task.status, "changes_requested");
      assert.equal(task.owner, "developer");
      assert.equal(task.escalated, false);
      assert.equal(ledger.gates.find((g) => g.id === escalationId).extra_rounds, 3);
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("reject with a note → the note reaches the orchestrator's inbox", async () => {
    const sd = seed();
    const { id, gateId } = await sd.planned("Reject build");
    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    const note = "Split T1 into a design task and a build task, then ask again.";
    try {
      await page.waitForSelector(".gate textarea");
      // A pasted key is refused by the relay's secret scanner; the page says so without echoing it.
      const key = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
      await page.fill(".gate textarea", `use ${key}`);
      const [refused] = await Promise.all([waitPost(page, "/api/call/gate_decide"), page.click(".gate button:has-text('Reject')")]);
      assert.equal(refused.status(), 400);
      await page.waitForFunction(() => document.querySelector(".gate .form-error")?.textContent.length > 0);
      const shown = await text(page, ".gate .form-error");
      assert.match(shown, /Looks like a secret/);
      assert.ok(!shown.includes(key.slice(12)), "the error does not echo the secret");
      assert.equal((await sd.ledger(id)).gates.find((g) => g.id === gateId).status, "pending");
      await page.fill(".gate textarea", note);
      const [res] = await Promise.all([waitPost(page, "/api/call/gate_decide"), page.click(".gate button:has-text('Reject')")]);
      assert.equal((await res.json()).ok, true);
      await page.waitForFunction(() => document.querySelector(".detail-meta .pill")?.textContent === "Planning");
      assert.match(await text(page, ".history"), /Rejected/);
      assert.match(await text(page, ".history"), /Split T1 into a design task/);

      const ledger = await sd.ledger(id);
      assert.equal(ledger.build.status, "planning");
      assert.equal(ledger.gates.find((g) => g.id === gateId).status, "rejected");
      const inbox = await sd.call("orchestrator", "inbox", { build_id: id, peek: true });
      const fromHuman = inbox.builds[0].messages.filter((m) => m.from === "human");
      assert.ok(fromHuman.some((m) => m.body.includes(note)), `orchestrator inbox lacks the note: ${JSON.stringify(fromHuman.map((m) => m.body))}`);
      s.check({ allow: [400] });
    } finally {
      await s.close();
    }
  });

  pageTest("final sign-off approve → shipped and listed with closed builds", async () => {
    const sd = seed();
    const { id, taskId } = await sd.inProgress("Sign-off build");
    await sd.reviewRound(id, taskId, 1, { verdict: "approved" });
    const { gate } = await sd.call("orchestrator", "gate_request", { build_id: id, kind: "final_signoff", summary: "Deployed to https://signoff.example.com" });
    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.waitForSelector(".gate");
      assert.equal(await text(page, ".gate-kind"), "Final sign-off");
      let decides = 0;
      page.on("request", (r) => { if (r.url().endsWith("/api/call/gate_decide")) decides++; });
      // A double tap on a phone must not send the decision twice.
      const [res] = await Promise.all([waitPost(page, "/api/call/gate_decide"), page.dblclick(".gate .btn-approve")]);
      assert.equal((await res.json()).ok, true);
      await page.waitForFunction(() => document.querySelector(".detail-meta .pill")?.textContent === "Shipped");
      assert.equal(decides, 1, "one decision request per tap");
      assert.equal(await page.locator(".controls").count(), 0, "a shipped build has no halt/cancel controls");
      assert.equal((await sd.ledger(id)).build.status, "shipped");
      assert.equal((await sd.ledger(id)).gates.find((g) => g.id === gate.id).status, "approved");
      await page.click("a.back");
      const closedGroup = page.locator("section.build-group", { has: page.locator("h2:has-text('Shipped and cancelled')") });
      await closedGroup.locator(`.build-card[href="#${id}"]`).waitFor();
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("gate note draft and focus survive an auto-refresh", async () => {
    const sd = seed();
    const { id } = await sd.planned("Draft build");
    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.waitForSelector(".gate textarea");
      await page.click(".gate textarea");
      await page.keyboard.type("Half-typed note");
      await sd.call("orchestrator", "send", { build_id: id, to_role: "human", type: "question", body: "Draft probe: arriving while you type." });
      await page.waitForSelector(".msg-body:has-text('Draft probe')", { timeout: REFRESH_BUDGET_MS });
      assert.equal(await page.inputValue(".gate textarea"), "Half-typed note");
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "TEXTAREA", "focus stays in the note");
      await page.keyboard.type(" and finished.");
      assert.equal(await page.inputValue(".gate textarea"), "Half-typed note and finished.");
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("kill switch on/off with a confirm dialog → /api/me halted", async () => {
    const sd = seed();
    const { id } = await sd.inProgress("Kill switch build");
    const s = await openPage();
    const { page } = s;
    const me = async () => (await getJson(relay, "human", "/api/me")).result.halted;
    try {
      await page.waitForSelector("#kill-on");
      let posted = 0;
      page.on("request", (r) => { if (r.url().endsWith("/api/call/kill_switch")) posted++; });

      // Cancel does nothing.
      await page.click("#kill-on");
      await page.waitForSelector("#confirm[open]");
      assert.equal(await text(page, "#confirm-title"), "Stop all agents?");
      await page.click("#confirm-cancel");
      await page.waitForSelector("#confirm", { state: "hidden" });
      assert.equal(posted, 0);
      assert.equal((await me()).global, false);

      // On, with a reason.
      await page.click("#kill-on");
      await page.waitForSelector("#confirm[open]");
      await page.fill("#confirm-reason", "E2E: runaway review loop");
      const [on] = await Promise.all([waitPost(page, "/api/call/kill_switch"), page.click("#confirm-ok")]);
      assert.deepEqual(on.request().postDataJSON(), { on: true, reason: "E2E: runaway review loop" });
      await page.waitForSelector("#halt-banner:not([hidden])");
      assert.match(await text(page, "#halt-banner"), /Kill switch is on[\s\S]*E2E: runaway review loop/);
      assert.equal(await page.isHidden("#kill-on"), true);
      assert.equal(await page.isVisible("#kill-off"), true);
      const halted = await me();
      assert.equal(halted.global, true);
      assert.equal(halted.reason, "E2E: runaway review loop");
      const blocked = await relay.call("developer", "send", { build_id: id, to_role: "orchestrator", type: "status", body: "still there?" });
      assert.equal(blocked.status, 423);
      assert.equal(blocked.error.code, "halted");

      // Off from the banner.
      await page.click("#kill-off");
      await page.waitForSelector("#confirm[open]");
      assert.equal(await text(page, "#confirm-title"), "Turn the kill switch off?");
      await Promise.all([waitPost(page, "/api/call/kill_switch"), page.click("#confirm-ok")]);
      await page.waitForSelector("#halt-banner", { state: "hidden" });
      assert.equal((await me()).global, false);
      assert.equal(await page.isVisible("#kill-on"), true);
      s.check();
    } finally {
      await s.close();
      await relay.call("human", "kill_switch", { on: false });
    }
  });

  pageTest("build halt and resume from the detail page", async () => {
    const sd = seed();
    const { id, gateId } = await sd.planned("Halt build");
    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.waitForSelector("button:has-text('Halt build')");
      await page.click("button:has-text('Halt build')");
      await page.waitForSelector("#confirm[open]");
      assert.equal(await text(page, "#confirm-title"), "Halt this build?");
      await page.fill("#confirm-reason", "E2E halt");
      const [res] = await Promise.all([waitPost(page, "/api/call/build_control"), page.click("#confirm-ok")]);
      assert.deepEqual(res.request().postDataJSON(), { build_id: id, action: "halt", reason: "E2E halt" });
      await page.waitForSelector(".callout:has-text('This build is halted.')");
      assert.match(await text(page, ".callout"), /Reason: E2E halt\./);
      assert.match(await text(page, ".callout"), /Resuming returns it to awaiting plan approval/);
      let ledger = await sd.ledger(id);
      assert.equal(ledger.build.status, "halted");
      assert.equal(ledger.build.halt_reason, "E2E halt");
      await page.click("a.back");
      await page.waitForSelector(`.build-card[href="#${id}"] .bc-halt`);
      assert.equal(await text(page, `.build-card[href="#${id}"] .bc-halt`), "Halted: E2E halt");
      assert.equal(await text(page, `.build-card[href="#${id}"] .pill`), "Halted");
      await page.goBack();
      await page.waitForSelector(".callout");
      const blocked = await relay.call("orchestrator", "send", { build_id: id, to_role: "human", type: "question", body: "halted?" });
      assert.equal(blocked.ok, false);

      // Deciding the pending gate while halted is refused by the relay; the page says why, inline.
      await page.click(".gate .btn-approve");
      await page.waitForFunction(() => document.querySelector(".gate .form-error")?.textContent.length > 0);
      assert.match(await text(page, ".gate .form-error"), /halted/);
      assert.equal((await sd.ledger(id)).gates.find((g) => g.id === gateId).status, "pending");

      await page.click("button:has-text('Resume')");
      await page.waitForSelector("#confirm[open]");
      await Promise.all([waitPost(page, "/api/call/build_control"), page.click("#confirm-ok")]);
      await page.waitForFunction(() => document.querySelector(".detail-meta .pill")?.textContent === "Awaiting plan approval");
      assert.equal(await page.locator(".callout").count(), 0);
      ledger = await sd.ledger(id);
      assert.equal(ledger.build.status, "awaiting_plan_approval");
      s.check({ allow: [409] });
    } finally {
      await s.close();
    }
  });

  pageTest("new-build form creates the build and opens it", async () => {
    const s = await openPage();
    const { page } = s;
    try {
      await page.waitForSelector("#nb-toggle");
      await page.click("#nb-toggle");
      await page.waitForSelector("#new-build:not([hidden])");
      assert.equal(await page.getAttribute("#nb-toggle", "aria-expanded"), "true");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "nb-title");
      await page.click("#nb-create");
      assert.match(await text(page, "#nb-error"), /A build needs a title and a brief/);

      await page.fill("#nb-title", "Form build: tip calculator");
      await page.fill("#nb-brief", "A one-screen tip calculator.\nDone when it is deployed and reviewed.");
      await page.uncheck("#nb-plan");
      const [res] = await Promise.all([waitPost(page, "/api/call/build_create"), page.click("#nb-create")]);
      const created = (await res.json()).result;
      assert.match(created.build_id, /^b-[a-z2-7]{10}$/);
      await page.waitForFunction((id) => location.hash === `#${id}`, created.build_id);
      await page.waitForSelector(".detail-title");
      assert.equal(await text(page, ".detail-title"), "Form build: tip calculator");

      const ledger = await seed().ledger(created.build_id);
      assert.equal(ledger.build.title, "Form build: tip calculator");
      assert.equal(ledger.build.brief, "A one-screen tip calculator.\nDone when it is deployed and reviewed.");
      assert.deepEqual(ledger.build.gates, { plan_approval: false, final_signoff: true });
      assert.equal(ledger.build.created_by, "human");
      const kickoff = ledger.messages.find((m) => m.type === "task" && m.to === "orchestrator");
      assert.ok(kickoff, "the orchestrator got a kickoff task");
      assert.match(kickoff.body, /tip calculator/);
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("developer token sees a read-only page", async () => {
    const sd = seed();
    const { id, gateId } = await sd.planned("Read-only build");
    const s = await openPage({ role: "developer" });
    const { page } = s;
    try {
      await page.waitForSelector(`.build-card[href="#${id}"]`);
      assert.equal(await text(page, "#who-role"), "developer");
      assert.equal(await text(page, "#who-name"), "Full-Stack Developer");
      for (const sel of ["#nb-toggle", "#kill-on", "#nav-spike", "#kill-off"]) assert.equal(await page.isHidden(sel), true, `${sel} is hidden`);
      assert.match(await text(page, ".attention-title"), /waiting for James/);
      const mine = page.locator(`.build-card[href="#${id}"] .owner-chip.me`);
      assert.equal((await mine.innerText()).replace(/\s+/g, " ").trim(), "D You T1", "the developer's own task shows as You");

      await page.click(`.build-card[href="#${id}"]`);
      await page.waitForSelector(".gate");
      assert.equal(await page.locator(".gate button, .gate textarea, .gate select").count(), 0, "no gate controls");
      assert.equal(await text(page, ".gate-waiting"), "Only James can answer this gate.");
      assert.equal(await page.locator(".controls").count(), 0, "no halt/cancel controls");
      assert.equal(await page.locator("#app button:visible").count(), 2, "only Sign out and Refresh are buttons");

      // The relay enforces it too, whatever the page shows.
      const forged = await page.evaluate(async ([buildId, gate, token]) => {
        const r = await fetch("/api/call/gate_decide", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ build_id: buildId, gate_id: gate, decision: "approved" }),
        });
        return r.status;
      }, [id, gateId, relay.tokens.developer]);
      assert.equal(forged, 403);

      await page.evaluate(() => { location.hash = "#spike"; });
      await page.waitForSelector("#view-spike:not([hidden]) #events .empty");
      assert.equal(await text(page, "#events"), "Spike events are visible to James only.");
      assert.equal(await page.isHidden("#wake-panel"), true);

      // Kill switch on: the banner shows, but there is no off switch for a non-human role.
      await must("human", "kill_switch", { on: true, reason: "E2E read-only check" });
      await page.evaluate(() => { location.hash = ""; });
      await page.waitForSelector("#halt-banner:not([hidden])");
      assert.equal(await page.isHidden("#kill-off"), true);
      assert.equal(await page.isHidden("#kill-on"), true);
      s.check({ allow: [403] });
    } finally {
      await s.close();
      await relay.call("human", "kill_switch", { on: false });
    }
  });

  pageTest("hostile text from agents renders as text (no script runs, nothing injected)", async () => {
    const sd = seed();
    const img = `<img src=x onerror="window.__xss=1;alert('img')">`;
    const script = `<script>window.__xss=2;alert('script')</script>`;
    const { id, taskId } = await sd.planned(`${img} Hostile build`, {
      build: { brief: `${script} brief` },
      taskTitle: `<svg onload="window.__xss=3;alert('svg')"></svg>Task`,
      taskDescription: `<iframe src="javascript:alert('iframe')"></iframe> description`,
      summary: `<b onmouseover="alert('b')">Plan</b> ${img}`,
    });
    await sd.call("orchestrator", "send", {
      build_id: id, to_role: "human", type: "question",
      body: `Pasted output: ${img} and ${script} and "><svg/onload=alert('attr')>`,
      links: [{ url: "https://example.com/?q=%22%3E%3Cimg%20src=x%20onerror=alert(1)%3E", label: `${img}label` }],
    });
    await sd.call("orchestrator", "ledger_update", { build_id: id, task_id: taskId, note: `${script} note` });
    await sd.call("human", "gate_decide", { build_id: id, gate_id: "G1", decision: "approved" });
    await sd.reviewRound(id, taskId, 1, { changes: [`${img} change one`, `${script} change two`], label: `${img}preview` });

    const s = await openPage();
    const { page } = s;
    try {
      await page.waitForSelector(`.build-card[href="#${id}"]`);
      await page.waitForTimeout(400);
      await assertNothingInjected(page);
      assert.match(await page.locator(`.build-card[href="#${id}"] .bc-title`).innerText(), /^<img src=x onerror=/);

      await page.click(`.build-card[href="#${id}"]`);
      await page.waitForSelector(".msg");
      await page.click(".task-notes summary");
      await page.waitForTimeout(400);
      await assertNothingInjected(page);
      assert.match(await text(page, ".detail-title"), /^<img src=x onerror=/);
      const bodies = (await page.locator(".msg-body").allInnerTexts()).join("\n");
      assert.ok(bodies.includes(`Pasted output: ${img} and ${script}`), "message body is shown literally");
      assert.ok((await page.locator(".changes li").allInnerTexts()).includes(`${img} change one`));
      assert.ok((await text(page, ".notes")).includes(`${script} note`));
      assert.ok((await page.locator(".links a").allInnerTexts()).some((t) => t.startsWith("<img src=x")));
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("javascript: and other non-http links are never rendered as anchors", async () => {
    const sd = seed();
    const { id, taskId } = await sd.inProgress("Link safety build");
    // The relay refuses them outright.
    for (const url of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
      const r = await relay.call("orchestrator", "send", { build_id: id, to_role: "developer", type: "status", body: "link", links: [{ url }] });
      assert.equal(r.status, 400, `relay accepted ${url}`);
      assert.equal(r.error.code, "invalid_input");
    }
    await sd.call("orchestrator", "send", { build_id: id, to_role: "developer", type: "status", body: "Links probe", links: [{ url: "https://ok.example.com/x", label: "Good link" }] });

    // Defence in depth: even if bad links reached the ledger, the page must not make them clickable.
    const hostile = [
      { url: "javascript:window.__xss=1", label: "JS link" },
      { url: " JaVaScRiPt:window.__xss=2", label: "Mixed-case JS link" },
      { url: "java\tscript:window.__xss=3", label: "Tab JS link" },
      { url: "data:text/html,<script>alert(1)</script>", label: "Data link" },
      { url: "/relative/path", label: "Relative link" },
    ];
    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.route(new RegExp(`/api/builds/${id}$`), async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        const probe = json.result.messages.find((m) => m.body === "Links probe");
        probe.links = [...probe.links, ...hostile];
        json.result.tasks.find((t) => t.id === taskId).artifacts = hostile;
        await route.fulfill({ response, json });
      });
      await page.reload();
      await page.waitForSelector(".msg-body:has-text('Links probe')");
      const anchors = await page.locator("#app a[href]").evaluateAll((els) => els.map((a) => a.getAttribute("href")));
      const bad = anchors.filter((href) => !/^(https?:\/\/|#)/.test(href));
      assert.deepEqual(bad, [], "only http(s) and in-page anchors");
      const blocked = await page.locator(".link-blocked").allInnerTexts();
      for (const l of hostile) assert.ok(blocked.includes(l.label), `${l.label} is shown as blocked text`);
      const good = page.locator(".links a:has-text('Good link')");
      assert.equal(await good.getAttribute("href"), "https://ok.example.com/x");
      assert.equal(await good.getAttribute("target"), "_blank");
      assert.equal(await good.getAttribute("rel"), "noopener noreferrer");
      await page.locator(".link-blocked").first().click();
      await assertNothingInjected(page);
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("#spike lists posted events and queues a wake that GET /spike/wake returns", async () => {
    const session = `sess-e2e-${Date.now()}`;
    const events = [
      { event: "SessionStart", session_id: session, surface: "cli", agent_id: "developer", detail: { cwd: "/work/app" } },
      { event: "UserPromptSubmit", session_id: session, surface: "cli", agent_id: "developer", detail: { prompt_chars: 42 } },
      { event: "Stop", session_id: session, surface: "cli", agent_id: "developer" },
    ];
    for (const e of events) assert.equal((await postJson(relay, "developer", "/spike/events", e)).ok, true);
    assert.equal((await postJson(relay, "orchestrator", "/spike/events", {
      event: `<img src=x onerror="window.__xss=1">Hostile`, session_id: "sess-other", surface: "<b>web</b>", detail: `<script>alert(1)</script>`,
    })).ok, true);

    const redirect = await fetch(`${relay.url}/spike`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(new URL(redirect.headers.get("location")).hash, "#spike");

    const s = await openPage();
    const { page } = s;
    try {
      await page.waitForSelector("#nav-spike:not([hidden])");
      await page.click("#nav-spike");
      await page.waitForSelector(".event");
      assert.equal(new URL(page.url()).hash, "#spike");
      const names = await page.locator(".event-name").allInnerTexts();
      assert.deepEqual(names.slice(0, 4), [`<img src=x onerror="window.__xss=1">Hostile`, "Stop", "UserPromptSubmit", "SessionStart"]);
      assert.match(await text(page, "#tally-title"), /2 sessions/);
      const first = page.locator(".event").nth(1);
      assert.match(await first.innerText(), new RegExp(`session\\s+${session}`));
      assert.match(await first.innerText(), /token\s+developer/);
      assert.match(await page.locator(".event").nth(3).innerText(), /"cwd": "\/work\/app"/);
      await assertNothingInjected(page);
      assert.equal(await page.locator(`#session-ids option[value="${session}"]`).count(), 1, "session ids are offered");

      // Empty text is refused locally.
      await page.click("#wake-send");
      assert.match(await text(page, "#wake-error"), /Enter the text to send/);

      // Targeted wake.
      await page.fill("#wake-session", session);
      await page.fill("#wake-text", "E2E: check your relay inbox.");
      const [res] = await Promise.all([waitPost(page, "/spike/wake"), page.click("#wake-send")]);
      const wake = (await res.json()).result.wake;
      await page.waitForSelector(`.toast:has-text("Wake ${wake.id} queued for ${session}")`);
      assert.equal(await page.inputValue("#wake-text"), "");
      assert.equal((await getJson(relay, "developer", "/spike/wake?session_id=some-other-session")).result.wakes.length, 0);
      const got = await getJson(relay, "developer", `/spike/wake?session_id=${encodeURIComponent(session)}`);
      assert.equal(got.ok, true);
      assert.deepEqual(got.result.wakes.map((w) => [w.id, w.session_id, w.text]), [[wake.id, session, "E2E: check your relay inbox."]]);
      assert.equal((await getJson(relay, "developer", `/spike/wake?session_id=${encodeURIComponent(session)}`)).result.wakes.length, 0, "wakes are consumed once");

      // Untargeted wake goes to any session.
      await page.fill("#wake-session", "");
      await page.fill("#wake-text", "Anyone: check your inbox.");
      await Promise.all([waitPost(page, "/spike/wake"), page.click("#wake-send")]);
      await page.waitForSelector(`.toast:has-text("queued for any session")`);
      const any = await getJson(relay, "creative-director", "/spike/wake?session_id=whatever");
      assert.deepEqual(any.result.wakes.map((w) => w.text), ["Anyone: check your inbox."]);
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("auto-refresh picks up a new message within ~12 s (detail and list)", async () => {
    const sd = seed();
    const { id } = await sd.inProgress("Auto-refresh build");
    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.waitForSelector(".msg");
      const t0 = Date.now();
      await sd.call("developer", "send", { build_id: id, to_role: "orchestrator", type: "status", body: "Auto-refresh probe one" });
      await page.waitForSelector(".msg-body:has-text('Auto-refresh probe one')", { timeout: REFRESH_BUDGET_MS });
      const detailMs = Date.now() - t0;

      await page.click("a.back");
      await page.waitForSelector(`.build-card[href="#${id}"] .bc-excerpt:has-text('Auto-refresh probe one')`);
      const t1 = Date.now();
      await sd.call("orchestrator", "send", { build_id: id, to_role: "developer", type: "status", body: "Auto-refresh probe two" });
      await page.waitForSelector(`.build-card[href="#${id}"] .bc-excerpt:has-text('Auto-refresh probe two')`, { timeout: REFRESH_BUDGET_MS });
      const listMs = Date.now() - t1;
      assert.match(await text(page, "#updated"), /^Updated /);
      console.log(`# auto-refresh: detail ${detailMs} ms, list ${listMs} ms`);
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("cancel a build from the detail page", async () => {
    const sd = seed();
    const { id, gateId } = await sd.planned("Cancel build");
    const s = await openPage({ hash: `#${id}` });
    const { page } = s;
    try {
      await page.waitForSelector("button:has-text('Cancel build')");
      await page.click("button:has-text('Cancel build')");
      await page.waitForSelector("#confirm[open]");
      assert.equal(await text(page, "#confirm-title"), "Cancel this build?");
      await page.fill("#confirm-reason", "E2E: not needed");
      const [res] = await Promise.all([waitPost(page, "/api/call/build_control"), page.click("#confirm-ok")]);
      assert.deepEqual(res.request().postDataJSON(), { build_id: id, action: "cancel", reason: "E2E: not needed" });
      await page.waitForFunction(() => document.querySelector(".detail-meta .pill")?.textContent === "Cancelled");
      assert.equal(await page.locator(".controls, .gate").count(), 0, "no controls or open gates on a cancelled build");
      const ledger = await sd.ledger(id);
      assert.equal(ledger.build.status, "cancelled");
      assert.equal(ledger.gates.find((g) => g.id === gateId).status, "cancelled");
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("message-cap halt: the page lets James raise the cap so Resume can work", async () => {
    const r = await launchRelay({ vars: { ...RELAY_VARS, MAX_MESSAGES_PER_BUILD: "3" } });
    try {
      const sd = seeder(r);
      const { id } = await sd.inProgress("Cap build");
      let capped = null;
      for (let n = 1; n <= 6 && !capped; n++) {
        const res = await r.call("developer", "send", { build_id: id, to_role: "orchestrator", type: "status", body: `status ${n}` });
        if (!res.ok) capped = res;
      }
      assert.equal(capped?.error.code, "cap_reached");
      assert.equal((await sd.ledger(id)).build.halt_reason, "message cap reached");

      const s = await openPage({ hash: `#${id}`, target: r });
      const { page } = s;
      try {
        await page.waitForSelector(".callout");
        assert.match(await text(page, ".callout"), /message cap reached/);
        // Resume alone cannot help: the count is still at the cap, so the next agent message halts it again.
        await page.click("button:has-text('Resume')");
        await Promise.all([waitPost(page, "/api/call/build_control"), page.click("#confirm-ok")]);
        await page.waitForFunction(() => document.querySelector(".detail-meta .pill")?.textContent === "In progress");
        const again = await r.call("developer", "send", { build_id: id, to_role: "orchestrator", type: "status", body: "after resume" });
        assert.equal(again.error?.code, "cap_reached", "resume without raising the cap re-trips it at once");
        await page.click("#refresh");
        await page.waitForSelector(".callout");
        // build_control set_caps exists for this; the page must offer it on a cap-halted build.
        const capControls = await page.locator("#build button, #build input, #build select")
          .filter({ hasText: /cap|limit/i }).count()
          + await page.locator("#build input[type=number], #build [data-key^='caps']").count();
        assert.ok(capControls > 0, "no control on the page to raise the message cap (build_control set_caps); a cap-halted build cannot be continued from the phone");
        s.check();
      } finally {
        await s.close();
      }
    } finally {
      await r.stop();
    }
  });

  pageTest("a task that missed two nudges shows as stalled", async () => {
    const r = await launchRelay({ vars: { ...RELAY_VARS, NUDGE_AFTER_MINUTES: "0.05" } });
    try {
      const sd = seeder(r);
      const { id, taskId } = await sd.inProgress("Stalled build");
      const deadline = Date.now() + 30_000;
      let task;
      do {
        await new Promise((done) => setTimeout(done, 500));
        task = (await sd.ledger(id)).tasks.find((t) => t.id === taskId);
      } while (!task.stalled && Date.now() < deadline);
      assert.equal(task.stalled, true, "the relay marks the task stalled after two missed nudges");

      const s = await openPage({ hash: `#${id}`, target: r });
      const { page } = s;
      try {
        await page.waitForSelector(".task");
        assert.ok(await page.isVisible(".task .badge:text('Stalled')"), "Stalled badge on the task");
        const toMe = await page.locator(".msg.to-me .msg-body").allInnerTexts();
        assert.ok(toMe.some((b) => /missed two nudges/.test(b)), `James sees the stall escalation: ${JSON.stringify(toMe)}`);
        const nudges = await page.locator(".msg.from-relay .msg-body").allInnerTexts();
        assert.ok(nudges.some((b) => /^Nudge: T1/.test(b)), "the nudge itself is in the message list");
        s.check();
      } finally {
        await s.close();
      }
    } finally {
      await r.stop();
    }
  });

  pageTest("default relay: active-build limit shows inline; an unreachable relay shows 'Update failed'", async () => {
    const r = await launchRelay();
    let stopped = false;
    try {
      const sd = seeder(r);
      const id = await sd.build("The one active build");
      const s = await openPage({ target: r });
      const { page } = s;
      try {
        await page.waitForSelector(`.build-card[href="#${id}"]`);
        await page.click("#nb-toggle");
        await page.fill("#nb-title", "Second build");
        await page.fill("#nb-brief", "Should hit the one-active-build limit.");
        const [res] = await Promise.all([waitPost(page, "/api/call/build_create"), page.click("#nb-create")]);
        assert.equal(res.status(), 409);
        await page.waitForFunction(() => document.getElementById("nb-error").textContent.length > 0);
        assert.match(await text(page, "#nb-error"), new RegExp(`only 1 active build allowed.*${id}`));
        assert.equal(await page.isVisible("#new-build"), true, "the form stays open with what was typed");
        assert.equal(await page.inputValue("#nb-title"), "Second build");
        assert.equal((await sd.call("human", "build_list", {})).builds.length, 1);

        await r.stop();
        stopped = true;
        await page.click("#refresh");
        await page.waitForSelector("#updated.is-stale");
        assert.equal(await text(page, "#updated"), "Update failed");
        assert.match(await text(page, "#load-error"), /Offline: Can't reach the relay[\s\S]*Showing the last data loaded/);
        assert.equal(await page.locator(`.build-card[href="#${id}"]`).count(), 1, "the last data stays on screen");
        assert.equal(await page.isVisible("#app"), true, "a network error does not sign James out");
        const unexpected = s.problems.filter((p) => !(p.kind === "console" && /ERR_CONNECTION_REFUSED|status of 409/.test(p.text)));
        assert.deepEqual(unexpected, []);
      } finally {
        await s.close();
      }
    } finally {
      if (!stopped) await r.stop();
    }
  });

  pageTest("phone 360x740: no horizontal scroll and key tap targets ≥ 44px, with long real data", async () => {
    const sd = seed();
    const long = "Supercalifragilisticexpialidocious".repeat(4);
    const url = `https://preview.example.com/${"very-long-path-segment-".repeat(12)}index.html?build=${"x".repeat(80)}`;
    const { id, taskId } = await sd.escalated(`Phone build ${long}`, {
      taskTitle: `Task ${long}`,
      taskDescription: `See ${url} for the full spec. ${long}`,
      summary: `Plan ${long} ${url}`,
      round: (n) => ({ changes: [`Change ${n}: ${long}`, `Check ${url}`], label: `Preview ${n} ${long}`.slice(0, 200) }),
    });
    await sd.call("developer", "send", {
      build_id: id, to_role: "orchestrator", type: "question", task_id: taskId,
      body: `Long line ${long} ${url}\n`.repeat(3), links: [{ url, label: long.slice(0, 200) }, { url }],
    });

    for (const scheme of ["light", "dark"]) {
      const out = await openPage({ role: null, viewport: PHONE, colorScheme: scheme });
      try {
        await out.page.waitForSelector("#signin:not([hidden])");
        await assertNoHorizontalScroll(out.page, `sign-in (${scheme})`);
        await assertTapTargets(out.page, ["#signin-btn", "#token-reveal", "#token-input"], "sign-in");
        out.check();
      } finally {
        await out.close();
      }
    }

    const s = await openPage({ viewport: PHONE });
    const { page } = s;
    try {
      await page.waitForSelector(`.build-card[href="#${id}"]`);
      await page.click("#nb-toggle");
      await assertNoHorizontalScroll(page, "builds list");
      await assertTapTargets(page, ["#signout", "#refresh", ".tab", "#nb-toggle", "#kill-on", "#nb-create", "#nb-cancel", "#nb-title", ".attention-item", ".build-card"], "builds list");
      await page.click("#nb-cancel");

      await page.click(`.build-card[href="#${id}"]`);
      await page.waitForSelector(".gate select");
      await page.locator(".more").first().click(); // expand one long text, the widest state
      await assertNoHorizontalScroll(page, "build detail with escalation gate");
      await assertTapTargets(page, [".back", ".controls .btn", ".gate .btn-approve", ".gate button:has-text('Reject')", ".gate select", ".gate textarea", ".links a", ".more", "details.audit summary"], "build detail");
      await page.click("details.audit summary");
      await assertNoHorizontalScroll(page, "build detail with the audit log open");

      await page.click("button:has-text('Halt build')");
      await page.waitForSelector("#confirm[open]");
      await assertNoHorizontalScroll(page, "confirm dialog");
      await assertTapTargets(page, ["#confirm-ok", "#confirm-cancel"], "confirm dialog");
      const box = await page.locator("#confirm").boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= PHONE.width, `dialog fits the screen (${JSON.stringify(box)})`);
      await page.click("#confirm-cancel");
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("phone 360x740: spike view with realistic Mod events", async () => {
    // Own relay, so only events shaped like the spike Mod's are listed.
    const r = await launchRelay({ vars: RELAY_VARS });
    try {
      const session = "5b0f1c2e-8a4d-4f7e-9c61-2d3b4a5c6d7e";
      for (const event of ["session.start", "turn.start", "prompt.submit", "context.injected", "tool.call", "ui.render.AbovePrompt", "spike.heartbeat", "wake.submitted", "wake.turn_started", "session.end"]) {
        await postJson(r, "developer", "/spike/events", { event, session_id: session, surface: "cli", agent_id: "developer", detail: { tool: "mcp__agent-relay__inbox", text_length: 128 } });
      }
      const s = await openPage({ viewport: PHONE, hash: "#spike", target: r });
      try {
        await s.page.waitForSelector(".event");
        await assertNoHorizontalScroll(s.page, "spike view");
        await assertTapTargets(s.page, ["#wake-send", "#wake-session", "#wake-text", ".tab"], "spike view");
        s.check();
      } finally {
        await s.close();
      }
    } finally {
      await r.stop();
    }
  });

  pageTest("phone 360x740: spike view stays on screen with a long event name", async () => {
    // POST /spike/events accepts event names up to 200 chars from any role token.
    const event = "tool.call.mcp__agent-relay__ledger_update.after_retry_with_backoff";
    assert.equal((await postJson(relay, "developer", "/spike/events", { event, session_id: "sess-long-name", surface: "cli" })).ok, true);
    const s = await openPage({ viewport: PHONE, hash: "#spike" });
    try {
      await s.page.waitForSelector(".event");
      await assertNoHorizontalScroll(s.page, `spike view with a ${event.length}-char event name`);
      s.check();
    } finally {
      await s.close();
    }
  });

  pageTest("screenshots at 390x844, light and dark, on a realistic build", async () => {
    mkdirSync(SHOTS_DIR, { recursive: true });
    const r = await launchRelay({ vars: { MAX_ACTIVE_BUILDS: "3", BURST_PER_MINUTE: "1000" } });
    try {
      const sd = seeder(r);
      // A shipped build for the closed group.
      const shipped = await sd.build("Landing page refresh", { gates: { plan_approval: false, final_signoff: false } });
      const t = await sd.task(shipped, { title: "Refresh the hero and pricing sections" });
      await sd.call("orchestrator", "gate_request", { build_id: shipped, kind: "plan_approval", summary: "One task." });
      await sd.reviewRound(shipped, t, 1, { verdict: "approved" });
      await sd.call("orchestrator", "gate_request", { build_id: shipped, kind: "final_signoff", summary: "Live at https://landing.example.com" });

      // The active build: design done, home screen escalated after three rounds, deploy waiting.
      const id = await sd.build("Habit tracker PWA", {
        brief: "A small PWA to track three daily habits, with streaks and a weekly view. Offline first, installable, no accounts.",
      });
      const design = await sd.task(id, { title: "Design system and home screen", assignee: "creative-director", reviewer: null, description: "Type scale, colour tokens, the home screen in light and dark." });
      const home = await sd.task(id, { title: "Build the home screen", description: "Implement the home screen from the design spec; deploy a preview per round." });
      await sd.task(id, { title: "Deploy v1", reviewer: null });
      const plan = await sd.requestPlan(id, "Three tasks:\n1. T1 Creative Director designs the system and home screen.\n2. T2 Developer builds it; the Creative Director reviews each preview.\n3. T3 Developer deploys v1.");
      await sd.call("human", "gate_decide", { build_id: id, gate_id: plan, decision: "approved", note: "Keep it to three habits." });
      const figma = [{ url: "https://www.figma.com/file/habit-tracker", label: "Figma: Habit tracker" }];
      await sd.call("creative-director", "ledger_update", { build_id: id, task_id: design, status: "done", links: figma, note: "Spec ready for the developer." });
      await sd.call("creative-director", "send", { build_id: id, to_role: "developer", type: "status", task_id: design, body: "Design spec is ready: tokens, type scale and the home screen.", links: figma });
      const rounds = [
        ["Streak badges overlap the habit names on narrow screens.", "The week strip needs 44px tap targets."],
        ["Dark mode: the progress ring is invisible on the surface colour.", "Use the type scale for the habit names."],
        ["The empty state still shows placeholder copy.", "Check-in animation stutters on iOS Safari."],
      ];
      for (let n = 1; n <= 3; n++) await sd.reviewRound(id, home, n, { changes: rounds[n - 1], label: `Preview round ${n}` });
      await sd.call("developer", "inbox", { build_id: id, peek: true, session_ref: "claude-code: habit-tracker" });
      await sd.call("creative-director", "inbox", { build_id: id, peek: true, session_ref: "project thread" });
      for (const [event, extra] of [["SessionStart", { source: "startup" }], ["UserPromptSubmit", { prompt_chars: 120 }], ["PreToolUse", { tool: "mcp__relay__inbox" }], ["Stop", {}]]) {
        await postJson(r, "developer", "/spike/events", { event, session_id: "sess_7f3a9c", surface: "cli", agent_id: "developer", detail: extra });
      }
      await postJson(r, "creative-director", "/spike/events", { event: "SessionStart", session_id: "sess_cloud_21", surface: "project-thread", agent_id: "creative-director", detail: { source: "resume" } });

      for (const scheme of ["light", "dark"]) {
        const s = await openPage({ viewport: SHOT_VIEWPORT, colorScheme: scheme, target: r });
        const { page } = s;
        try {
          await page.waitForSelector(`.build-card[href="#${id}"]`);
          await assertNoHorizontalScroll(page, `list (${scheme})`);
          await page.screenshot({ path: join(SHOTS_DIR, `list-${scheme}.png`), fullPage: true });
          await page.click(`.build-card[href="#${id}"]`);
          await page.waitForSelector(".gate select");
          await page.screenshot({ path: join(SHOTS_DIR, `detail-gate-${scheme}.png`) });
          await page.screenshot({ path: join(SHOTS_DIR, `detail-full-${scheme}.png`), fullPage: true });
          await page.click("#nav-spike");
          await page.waitForSelector(".event");
          await page.screenshot({ path: join(SHOTS_DIR, `spike-${scheme}.png`), fullPage: true });
          await page.click("#nav-builds");
          await page.waitForSelector("#kill-on");
          await page.click("#kill-on");
          await page.waitForSelector("#confirm[open]");
          await page.fill("#confirm-reason", "Review loop on T2 is running away");
          await page.screenshot({ path: join(SHOTS_DIR, `kill-dialog-${scheme}.png`) });
          await Promise.all([waitPost(page, "/api/call/kill_switch"), page.click("#confirm-ok")]);
          await page.waitForSelector("#halt-banner:not([hidden])");
          await page.waitForTimeout(300);
          await page.screenshot({ path: join(SHOTS_DIR, `killed-list-${scheme}.png`) });
          await sd.call("human", "kill_switch", { on: false });
          s.check();
        } finally {
          await s.close();
        }
      }
      console.log(`# screenshots in ${SHOTS_DIR}`);
    } finally {
      await r.stop();
    }
  });
});
