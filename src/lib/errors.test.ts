import { ProtocolError } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  InternalFailure,
  NotFoundError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
  handleToolError,
  isAppError,
  toAppError,
  toProtocolError,
  toToolResult,
} from "@/lib/errors.js";

/**
 * The two-channel routing is the convention every module depends on, so it is
 * tested directly rather than only through the tools that use it.
 */

describe("channel classification", () => {
  it.each([
    ["ValidationError", new ValidationError("bad range"), "tool"],
    ["NotFoundError", new NotFoundError("item", "x"), "tool"],
    ["ConflictError", new ConflictError("dupe"), "tool"],
    ["UpstreamError", new UpstreamError("stripe", "503"), "tool"],
    ["InternalFailure", new InternalFailure("boom"), "tool"],
    ["UnauthorizedError", new UnauthorizedError(), "protocol"],
    ["ForbiddenError", new ForbiddenError(), "protocol"],
  ])("routes %s to the %s channel", (_name, error, channel) => {
    expect(error.channel).toBe(channel);
  });

  it("keeps only client-resolvable failures on the protocol channel", () => {
    // The rule in one assertion: if the model could fix it, the model must see
    // it. Auth is the exception — a model cannot mint a token.
    expect(new UnauthorizedError().channel).toBe("protocol");
    expect(new ValidationError("x").channel).toBe("tool");
  });
});

describe("handleToolError", () => {
  it("returns an isError result for tool-channel failures", () => {
    const result = handleToolError(new NotFoundError("item", "itm_9"));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "not_found", details: { resource: "item", id: "itm_9" } },
    });
    // Both channels of legibility: text for the model, structured for code.
    expect(result.content[0]).toHaveProperty(
      "text",
      expect.stringContaining("itm_9"),
    );
  });

  it("throws a ProtocolError for protocol-channel failures", () => {
    expect(() => handleToolError(new UnauthorizedError())).toThrow(
      ProtocolError,
    );
  });

  it("wraps unknown thrown values rather than leaking them", () => {
    const result = handleToolError(
      new TypeError("undefined is not a function"),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "internal_error" },
    });
  });
});

describe("toProtocolError", () => {
  it("carries the JSON-RPC code and machine-readable code", () => {
    const error = toProtocolError(new UnauthorizedError("no token"));
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.message).toBe("no token");
    expect(error.data).toMatchObject({ code: "unauthorized" });
  });
});

describe("exposure", () => {
  it("exposes deliberate failures", () => {
    const result = toToolResult(new ConflictError("name taken"));
    expect(result.content[0]).toHaveProperty("text", "name taken");
  });

  it("marks unexpected failures as not exposable", () => {
    // In production `publicMessage` withholds these; NODE_ENV is "test" here,
    // so assert the flag that drives it rather than the environment.
    expect(new InternalFailure("db password is hunter2").expose).toBe(false);
    expect(new ConflictError("name taken").expose).toBe(true);
  });

  it("omits details for non-exposable errors", () => {
    const result = toToolResult(new InternalFailure("secret", { dsn: "x" }));
    expect(result.structuredContent).not.toHaveProperty("error.details");
  });
});

describe("toAppError", () => {
  it("passes AppErrors through untouched", () => {
    const original = new NotFoundError("item", "a");
    expect(toAppError(original)).toBe(original);
  });

  it("preserves the stack of a wrapped Error", () => {
    const thrown = new Error("original");
    expect(toAppError(thrown).stack).toBe(thrown.stack);
  });

  it("handles non-Error throws", () => {
    expect(toAppError("just a string").message).toBe("just a string");
  });

  it("identifies AppErrors", () => {
    expect(isAppError(new ConflictError("x"))).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
  });
});
