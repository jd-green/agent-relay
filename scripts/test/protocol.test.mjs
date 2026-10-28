// Checks on the protocol texts (protocol/PROTOCOL.md, protocol/roles/*.md, protocol/mcp/*.md): the MCP digests fit
// their budget, every call example carries the fields its tool requires (src/schemas.ts), and the relay texts the
// protocol quotes are the ones src/build-do.ts and the inbox Mod actually send.
//
//   node --test scripts/test/*.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(REPO, path), "utf8");
const DIGESTS = readdirSync(join(REPO, "protocol", "mcp")).map((file) => `protocol/mcp/${file}`);
const TEXTS = [
  "protocol/PROTOCOL.md",
  ...readdirSync(join(REPO, "protocol", "roles")).map((file) => `protocol/roles/${file}`),
  ...DIGESTS,
];
const ALL = TEXTS.map(read).join("\n");

// Required input fields per tool (src/schemas.ts: the fields without .optional() or .default()).
const REQUIRED = {
  send: ["build_id", "to_role", "type", "body"],
  ledger_update: ["build_id"],
  ledger_get: ["build_id"],
  gate_request: ["build_id", "kind", "summary"],
  gate_decide: ["build_id", "gate_id", "decision"],
  build_control: ["build_id", "action"],
  build_create: ["title", "brief"],
  kill_switch: ["on"],
};
// What a send of each work type needs on top (validateSend in src/build-do.ts).
const SEND_TYPE_FIELDS = {
  handoff: ["task_id", "links"],
  review_request: ["task_id", "links"],
  verdict: ["task_id", "verdict"],
  task: ["task_id"],
};

/** Every `tool {…}` code span in the texts, with the top-level field names it lists. */
function callExamples() {
  const examples = [];
  for (const path of TEXTS) {
    for (const [, tool, inner] of read(path).matchAll(/`([a-z_]+) \{(.*?)\}`/g)) {
      // Top-level fields only: drop nested {…} and […] groups first.
      let flat = inner;
      while (/\{[^{}]*\}|\[[^[\]]*\]/.test(flat)) flat = flat.replace(/\{[^{}]*\}|\[[^[\]]*\]/g, "");
      const fields = flat.split(",").map((part) => part.trim().split(/[?:\s]/)[0]).filter(Boolean);
      const typeMatch = inner.match(/type: "([a-z_]+)"/);
      examples.push({ path, tool, text: `${tool} {${inner}}`, fields, type: typeMatch?.[1] });
    }
  }
  return examples;
}

describe("protocol texts", () => {
  it("keep every MCP digest within 3,900 bytes", () => {
    for (const path of DIGESTS) {
      const bytes = Buffer.byteLength(read(path), "utf8");
      assert.ok(bytes <= 3900, `${path} is ${bytes} bytes`);
    }
  });

  it("write every call example with its tool's required fields", () => {
    const examples = callExamples();
    assert.ok(examples.length >= 20, `found only ${examples.length} call examples`);
    for (const { path, tool, text, fields, type } of examples) {
      assert.ok(tool in REQUIRED || tool === "inbox", `${path}: unknown tool in \`${text}\` (a message type written as a call?)`);
      for (const field of REQUIRED[tool] ?? []) assert.ok(fields.includes(field), `${path}: \`${text}\` lacks ${field}`);
      if (tool === "send" && type) {
        for (const field of SEND_TYPE_FIELDS[type] ?? []) assert.ok(fields.includes(field), `${path}: \`${text}\` lacks ${field}`);
      }
      if (tool === "ledger_update") {
        // Without task_id a ledger_update creates a task: an update of a status, a note or depends_on names the task.
        if (fields.some((field) => ["status", "note", "depends_on"].includes(field)) && !fields.includes("title")) {
          assert.ok(fields.includes("task_id"), `${path}: \`${text}\` lacks task_id`);
        }
        if (!fields.includes("task_id")) {
          for (const field of ["title", "assignee"]) assert.ok(fields.includes(field), `${path}: \`${text}\` creates a task without ${field}`);
        }
      }
    }
  });

  it("never write a message type as if it were a tool call", () => {
    for (const path of TEXTS) {
      const shorthand = read(path).match(/`(handoff|review_request|verdict|task|question|status) \{[^`]*`/g);
      assert.equal(shorthand, null, `${path}: write send {build_id, to_role, type, body, …} instead of ${shorthand}`);
    }
  });

  // Each quoted text as the protocol writes it, and the literal pieces of the source template that produce it.
  const QUOTED = [
    { quote: 'T2 is blocked (developer). Their note: "…"', source: "src/build-do.ts", pieces: [" is blocked (", ").${note}", " Their note: "] },
    { quote: 'has been blocked for 30 min (developer). Their note: "…"', source: "src/build-do.ts", pieces: [" has been blocked for ${blockedFor} (${owner}).${note}"] },
    { quote: "Stalled: T2 blocked for 60 min …", source: "src/build-do.ts", pieces: ["`Stalled: ${id} blocked for ${blockedFor} ("] },
    { quote: "Stalled: developer missed two nudges on …", source: "src/build-do.ts", pieces: ["`Stalled: ${target} missed two nudges on "] },
    { quote: "T5 depends on it: update T5's depends_on or cancel T5.", source: "src/build-do.ts", pieces: [" depends on it: update ${dependents[0]}'s depends_on or cancel ${dependents[0]}."] },
    { quote: 'Now ready: T3 "Ship" (developer, todo).', source: "src/build-do.ts", pieces: [" Now ready: ${", " (${other.owner ?? \"no owner\"}, ${other.status})"] },
    { quote: "T2 was cancelled; create a narrower replacement task if the work is still needed.", source: "src/build-do.ts", pieces: ["`${id} was cancelled; create a narrower replacement task if the work is still needed.`"] },
    { quote: "T2 escalated to James after round 3; wait for the decision.", source: "src/build-do.ts", pieces: ["`${id} escalated to ${this.human()} after round ${task.round}; wait for the decision.`"] },
    { quote: "… continues on T3", source: "src/build-do.ts", pieces: ["; ${to} continues on ${input.next_task_id}"] },
    { quote: "Every task is closed: request final_signoff.", source: "src/build-do.ts", pieces: ['" Every task is closed: request final_signoff."'] },
    { quote: "No open tasks for 30 min: request final_signoff or add tasks.", source: "src/build-do.ts", pieces: ["`No open tasks for ${idle}: request final_signoff or add tasks.`"] },
    { quote: "Nothing to work on for 30 min", source: "src/build-do.ts", pieces: ["`Nothing to work on for ${idle}: "] },
    { quote: "has been waiting on your review", source: "src/build-do.ts", pieces: [" has been waiting on your review for ${idle}."] },
    { quote: "Plan auto-approved", source: "src/build-do.ts", pieces: ['"Plan auto-approved (plan_approval gate is off). The build is in_progress: assign the first tasks."'] },
    { quote: "Build resumed by James … Carry on from the ledger.", source: "src/build-do.ts", pieces: ["`Build resumed by ${by} (was halted: ${reason}). Carry on from the ledger.`"] },
    { quote: "Build cancelled by James … Stop work on it.", source: "src/build-do.ts", pieces: ["`Build cancelled by ${by}${because(input.reason)} Stop work on it.`"] },
    { quote: "Relay kill switch cleared by James. Carry on from the ledger.", source: "src/build-do.ts", pieces: ["`Relay kill switch cleared by ${by}. Carry on from the ledger.`"] },
    {
      quote: "[relay] N new relay message(s) for build <id>. Check your relay inbox and act per the relay protocol.",
      source: "mods/relay-inbox/hooks/messages.ts",
      pieces: [" new relay message(s) for build ", "'Check your relay inbox and act per the relay protocol.'"],
    },
    {
      quote: "They were added to the conversation above, already marked read: act on them per the relay protocol.",
      source: "mods/relay-inbox/hooks/messages.ts",
      pieces: ["'They were added to the conversation above, already marked read: act on them per the relay protocol.'"],
    },
    {
      quote: 'did not answer in time and may have marked messages read: call inbox {build_id: "<build>", since: <N>}',
      source: "mods/relay-inbox/hooks/messages.ts",
      pieces: [" did not answer in time and may have marked messages read: ", '`call inbox {build_id: "${token(build_id)}", since: ${since}}`'],
    },
    { quote: "Agent Relay inbox:", source: "mods/relay-inbox/hooks/messages.ts", pieces: ["`Agent Relay inbox: ${messages.length} new message(s)"] },
  ];

  for (const { quote, source, pieces } of QUOTED) {
    it(`quote what the relay sends: ${quote}`, () => {
      assert.ok(ALL.includes(quote), `no protocol text quotes ${quote}`);
      const code = read(source);
      for (const piece of pieces) assert.ok(code.includes(piece), `${source} no longer has ${piece}: update the protocol texts`);
    });
  }
});
