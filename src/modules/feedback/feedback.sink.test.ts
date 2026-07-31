import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logger } from "@/lib/logger.js";
import {
  HttpSink,
  SpoolAndUploadSink,
  SpoolSink,
} from "@/modules/feedback/feedback.sink.js";
import {
  REPORT_SCHEMA_VERSION,
  type IssueReport,
} from "@/modules/feedback/feedback.schema.js";

const quiet = logger.child({ silent: true });
const ENDPOINT = "https://ingest.example.com";

function report(overrides: Partial<IssueReport> = {}): IssueReport {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    report_id: "inc_1",
    generated_at: "2026-07-30T11:02:13.123Z",
    install_id: "inst_abc123",
    build: { domain: "ONDC:FIS12", version: "2.0.0" },
    mock_role: "BAP",
    flow_id: "flow-1",
    attempt: 1,
    incident: {
      trigger: "BLOCKED",
      code: "requirements_not_met",
      occurrences: 1,
      state: "UNRESOLVED",
    },
    evidence: {},
    journal: [],
    narration: null,
    ...overrides,
  };
}

async function spoolDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ondc-feedback-"));
}

describe("SpoolSink", () => {
  it("writes one readable file per report", async () => {
    const directory = await spoolDir();
    const sink = new SpoolSink({ directory, maxFiles: 10, logger: quiet });

    await sink.deliver(report());

    const files = (await readdir(directory)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(directory, files[0] ?? ""), "utf8")),
    ).toMatchObject({ report_id: "inc_1", narration: null });
  });

  it("leaves no partial file behind — the write is a rename", async () => {
    // A sweep can run while a report is being written. Anything ending in
    // `.json` must therefore be complete by construction, never merely likely.
    const directory = await spoolDir();
    const sink = new SpoolSink({ directory, maxFiles: 10, logger: quiet });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sink.deliver(report({ report_id: `inc_${String(i)}` })),
      ),
    );

    const files = (await readdir(directory)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(5);
    for (const file of files) {
      const body = await readFile(join(directory, file), "utf8");
      expect(() => JSON.parse(body) as unknown).not.toThrow();
    }
  });

  it("prunes the oldest past the cap", async () => {
    // An offline laptop running flows all week must not grow an unbounded
    // directory.
    const directory = await spoolDir();
    const sink = new SpoolSink({ directory, maxFiles: 3, logger: quiet });

    for (let i = 0; i < 6; i += 1) {
      await sink.deliver(
        report({
          report_id: `inc_${String(i)}`,
          generated_at: `2026-07-30T11:0${String(i)}:00.000Z`,
        }),
      );
    }

    const files = (await readdir(directory)).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(3);
    expect(files.join()).toContain("inc_5");
    expect(files.join()).not.toContain("inc_0");
  });

  it("treats an absent directory as an empty spool, not a failure", async () => {
    const sink = new SpoolSink({
      directory: join(tmpdir(), "definitely-not-created-ondc"),
      maxFiles: 3,
      logger: quiet,
    });

    await expect(sink.pending()).resolves.toEqual([]);
  });
});

describe("SpoolAndUploadSink", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
  });

  afterEach(async () => {
    await agent.close();
  });

  function http(): HttpSink {
    return new HttpSink({
      endpoint: ENDPOINT,
      timeoutMs: 1_000,
      dispatcher: agent,
      logger: quiet,
    });
  }

  it("spools first, then uploads, and marks what was accepted", async () => {
    const directory = await spoolDir();
    agent
      .get(ENDPOINT)
      .intercept({ path: "/", method: "POST" })
      .reply(202, { ok: true });

    const sink = new SpoolAndUploadSink({
      spool: new SpoolSink({ directory, maxFiles: 10, logger: quiet }),
      http: http(),
      logger: quiet,
    });

    await sink.deliver(report());

    const entries = await readdir(directory);
    expect(entries.some((entry) => entry.endsWith(".sent"))).toBe(true);
  });

  it("keeps a refused report pending, and the next sweep retries it", async () => {
    // Being offline is a delay, not a gap. This is the whole reason the spool
    // comes first.
    const directory = await spoolDir();
    const spool = new SpoolSink({ directory, maxFiles: 10, logger: quiet });
    agent.get(ENDPOINT).intercept({ path: "/", method: "POST" }).reply(503, "");

    const sink = new SpoolAndUploadSink({ spool, http: http(), logger: quiet });
    await sink.deliver(report());

    expect(await spool.pending()).toHaveLength(1);

    agent
      .get(ENDPOINT)
      .intercept({ path: "/", method: "POST" })
      .reply(202, { ok: true });
    await sink.sweep();

    expect(await spool.pending()).toHaveLength(0);
  });

  it("still spools when the ingest is unreachable", async () => {
    const directory = await spoolDir();
    const spool = new SpoolSink({ directory, maxFiles: 10, logger: quiet });
    agent
      .get(ENDPOINT)
      .intercept({ path: "/", method: "POST" })
      .replyWithError(new Error("ECONNREFUSED"));

    const sink = new SpoolAndUploadSink({ spool, http: http(), logger: quiet });
    await expect(sink.deliver(report())).resolves.toBeUndefined();

    expect(await spool.pending()).toHaveLength(1);
  });

  it("sends nothing at all when no endpoint is configured", async () => {
    // The default for an unconfigured install: captured, redacted, spooled, and
    // going nowhere. `disableNetConnect` makes any attempt an error.
    const directory = await spoolDir();
    const spool = new SpoolSink({ directory, maxFiles: 10, logger: quiet });
    const sink = new SpoolAndUploadSink({ spool, logger: quiet });

    await sink.deliver(report());

    expect(await spool.pending()).toHaveLength(1);
  });

  it("ignores a spooled file that is not readable JSON", async () => {
    const directory = await spoolDir();
    const spool = new SpoolSink({ directory, maxFiles: 10, logger: quiet });
    await writeFile(join(directory, "2026-broken.json"), "{not json", "utf8");
    agent
      .get(ENDPOINT)
      .intercept({ path: "/", method: "POST" })
      .reply(202, { ok: true });

    const sink = new SpoolAndUploadSink({ spool, http: http(), logger: quiet });
    await expect(sink.sweep()).resolves.toBeUndefined();
  });
});

describe("the container never spools during tests", () => {
  it("installs a no-op sink under NODE_ENV=test", async () => {
    // Regression guard. The first version of this feature wrote real reports
    // into the operator's home directory every time the suite ran, because the
    // spool's default location is `~/.ondc-mcp/feedback` and nothing said no.
    const { createContainer } = await import("@/container.js");
    const { parseConfig } = await import("@/config/env.js");
    const { createFakeConfigServiceGateway, createFakeValidationGateway } =
      await import("@/test/fakes.js");
    const { readdir } = await import("node:fs/promises");
    const { homedir } = await import("node:os");

    // What the suite must not do is *add* to this directory. Asserting it does
    // not exist conflates that with "this machine has never run the server for
    // real" — which is false on any operator's box the moment one report is
    // filed, and was false here.
    const spool = join(homedir(), ".ondc-mcp", "feedback");
    const before = await readdir(spool).catch(() => null);

    const container = await createContainer(
      parseConfig({ NODE_ENV: "test", LOG_LEVEL: "silent" }),
      {
        configServiceGateway: createFakeConfigServiceGateway(),
        validationGateway: createFakeValidationGateway(),
      },
    );

    try {
      await container.services.feedback.drain();
      const after = await readdir(spool).catch(() => null);
      expect(after).toEqual(before);
    } finally {
      await container.dispose();
    }
  });
});
