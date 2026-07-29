/**
 * Real responses captured from the workbench api-service validation oracle.
 *
 * `POST https://workbench.ondc.tech/api-service/ONDC:TRV11/2.0.1/test/{action}`,
 * captured 2026-07-29. Verbatim, including the parts that look like mistakes —
 * the `%!s(<nil>)` in `INTERNAL_ERROR` is a Go nil-format artifact the service
 * really does emit, and the `error.code` really is the literal string
 * `"Bad Request"` on every rejection regardless of layer.
 *
 * These exist so `validate.parse.test.ts` is a test of the wire rather than of
 * my memory of the wire. Do not tidy them. If upstream changes,
 * `validate.live.test.ts` is what will notice, and *then* these get re-captured.
 */

/** Every rejection carries this, so it identifies nothing. */
export const UPSTREAM_ERROR_CODE = "Bad Request";

export const DOCS_URL =
  "https://workbench.ondc.tech/validations/developer-guide/ONDC:TRV11/2.0.1";

/* -------------------------------------------------------------------------- */
/* Accepted                                                                    */
/* -------------------------------------------------------------------------- */

/** HTTP 200. The only shape that means the payload passed. */
export const ACK_RESPONSE = { message: { ack: { status: "ACK" } } };

/* -------------------------------------------------------------------------- */
/* L1 — x-validations. HTTP 200 with a NACK body.                              */
/* -------------------------------------------------------------------------- */

/** Five rules, one conjunction, one conditional guard, one bare rule. */
export const L1_MULTI_RULE =
  "#### **REQUIRED_CONTEXT_CODE_1**\n\n" +
  "**All of the following must be true:**\n" +
  "  - $.context.location.country.code must be present in the payload\n" +
  '  - All elements of $.context.location.country.code must be in ["IND"];\n' +
  " #### **REQUIRED_CONTEXT_VERSION_8**\n\n" +
  "- $.context.version must be present in the payload;\n" +
  " #### **VALID_ENUM_MESSAGE_TYPE_1**\n\n" +
  '- All elements of $.message.intent.fulfillment.type must be in ["ROUTE", "TRIP"]\n\n' +
  "> **Skip if:**\n>\n" +
  ">     - $.message.intent.fulfillment.type is not in the payload;\n" +
  " #### **VEHICLE_CATEGORY_REQUIRED**\n\n" +
  "- $.message.intent.fulfillment.vehicle.category must be present in the payload;\n" +
  " #### **VALID_VEHICLE_CATEGORY**\n\n" +
  '- All elements of $.message.intent.fulfillment.vehicle.category must be in ["BUS", "METRO"];\n' +
  ` for full list of validations refer ${DOCS_URL}`;

/**
 * 4000 non-compliant items collapsed into one finding with a `[*]` path.
 *
 * This is why findings are safe to put in a tool result uncapped: the oracle
 * reports the *rule*, not the cardinality of its violations.
 */
export const L1_WILDCARD_PATH =
  "#### **VALID_ITEM_DESCRIPTOR_CODE**\n\n" +
  "- All elements of $.message.catalog.providers[*].items[*].descriptor.code " +
  'must be in ["SJT", "RJT", "PASS", "SFSJT"];\n' +
  ` for full list of validations refer ${DOCS_URL}`;

/** Sent to `/search` with `context.action: "select"`. */
export const L1_ACTION_MISMATCH =
  "#### **REQUIRED_CONTEXT_ACTION_9**\n\n" +
  "**All of the following must be true:**\n" +
  "  - $.context.action must be present in the payload\n" +
  '  - All elements of $.context.action must be in ["search"];\n' +
  ` for full list of validations refer ${DOCS_URL}`;

export const L1_MULTI_RULE_RESPONSE = {
  message: { ack: { status: "NACK" } },
  error: { code: UPSTREAM_ERROR_CODE, message: L1_MULTI_RULE },
};

/* -------------------------------------------------------------------------- */
/* L0 — JSON Schema. HTTP 200 with a NACK body, and a different grammar.       */
/* -------------------------------------------------------------------------- */

/** Two type violations. Note the join: `";\n "`, and no trailing semicolon. */
export const L0_MULTI_ENTRY =
  "at '/context/timestamp': got number, want string;\n" +
  " at '/message/intent': got string, want object";

export const L0_SINGLE_ENTRY = "at '/message': got array, want object";

export const L0_MULTI_ENTRY_RESPONSE = {
  message: { ack: { status: "NACK" } },
  error: { code: UPSTREAM_ERROR_CODE, message: L0_MULTI_ENTRY },
};

/* -------------------------------------------------------------------------- */
/* HTTP 400 — rejected before the layers ran. Still payload defects.           */
/* -------------------------------------------------------------------------- */

export const BAD_JSON_MESSAGE =
  "BAD Request: failed to parse JSON payload: invalid character 'h' in literal true (expecting 'r')";

export const MISSING_DOMAIN_MESSAGE =
  "BAD Request: missing field Domain in context";

/** Raised when `context.version` names a build the oracle has no schema for. */
export const SCHEMA_NOT_FOUND_MESSAGE =
  "BAD Request: schema not found for domain: ondc_trv11";

export const BAD_REQUEST_RESPONSE = {
  message: { ack: { status: "NACK" } },
  error: { code: UPSTREAM_ERROR_CODE, message: MISSING_DOMAIN_MESSAGE },
};

/* -------------------------------------------------------------------------- */
/* Not verdicts — these must never be read as "invalid"                        */
/* -------------------------------------------------------------------------- */

/**
 * HTTP 500, returned when `context.transaction_id` is absent.
 *
 * The L1 validator dereferences the id while building its internal payload and
 * the resulting error is not one of ONIX's typed errors, so it falls through to
 * the generic handler — hence the unformatted `%!s(<nil>)`. It says nothing
 * about the payload's protocol validity, which is why the gateway guards the id
 * locally rather than letting a caller discover this.
 */
export const INTERNAL_ERROR_RESPONSE = {
  message: { ack: { status: "NACK" } },
  error: {
    code: "Internal Server Error",
    message: "Internal server error, MessageID: %!s(<nil>)",
  },
};

/** HTTP 404, and **not** JSON: the build is not served by this instance. */
export const ROUTE_NOT_CONFIGURED_BODY = "api route not configured";
