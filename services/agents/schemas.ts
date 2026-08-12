/**
 * Response schemas and the validation that runs after parsing.
 *
 * Two layers, on purpose:
 *
 *   1. A JSON Schema sent to the API, which constrains what the model may
 *      produce at all.
 *   2. Checks in code, for the rules JSON Schema cannot express — numeric
 *      ranges and string lengths are not supported by structured outputs, and
 *      the grounding rule is not expressible in a schema at any price.
 *
 * Layer 2 is not defensive belt-and-braces. It is the layer that catches the
 * failures worth measuring.
 */

import type {
  EvidenceRef,
  Merchant,
  TriageResult,
} from "../../shared/contracts.js";
import { LlmResponseError } from "../../shared/errors.js";
import type { ModelId } from "../../shared/contracts.js";

// ─── Merchant field names ──────────────────────────────────────

/**
 * The keys of `Merchant`, as data. `EvidenceRef.sourceField` is one of these
 * and nothing else, which is what stops the model inventing a source.
 */
export const MERCHANT_FIELDS = [
  "id",
  "name",
  "category",
  "city",
  "countryCode",
  "locale",
  "websiteUrl",
  "contactEmail",
  "rating",
  "reviewCount",
  "yearsInBusiness",
  "hasActiveOffer",
  "lastOfferEndedAt",
  "seatsOrCapacity",
] as const satisfies readonly (keyof Merchant)[];

/**
 * Compile-time exhaustiveness check. If a field is ever added to `Merchant`
 * and not listed above, this line stops compiling — the alternative is a
 * schema that silently rejects a legitimate source field at runtime.
 */
type _AllMerchantFieldsListed =
  Exclude<keyof Merchant, (typeof MERCHANT_FIELDS)[number]> extends never
    ? true
    : ["missing from MERCHANT_FIELDS:", Exclude<keyof Merchant, (typeof MERCHANT_FIELDS)[number]>];
const _fieldsAreExhaustive: _AllMerchantFieldsListed = true;
void _fieldsAreExhaustive;

const MERCHANT_FIELD_SET: ReadonlySet<string> = new Set(MERCHANT_FIELDS);

// ─── What the model returns ────────────────────────────────────

/**
 * Triage, as produced by the model. Narrower than `TriageResult`: `model`,
 * `escalated` and `usage` are facts about the call, which the caller knows
 * and the model does not.
 */
export interface TriagePayload {
  score: number;
  confidence: number;
  reason: string;
  recommendedAction: TriageResult["recommendedAction"];
}

/** Draft, as produced by the model. Identity and usage are added by the caller. */
export interface DraftPayload {
  subject: string;
  body: string;
  evidence: EvidenceRef[];
}

export const MAX_REASON_LENGTH = 240;

export const TRIAGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      description: "How worth approaching this merchant is, from 0 to 100.",
    },
    confidence: {
      type: "number",
      description:
        "How sure you are of your own score, from 0 to 1. This is not how good the merchant is.",
    },
    reason: {
      type: "string",
      description: `One line explaining the score, at most ${MAX_REASON_LENGTH} characters.`,
    },
    recommendedAction: {
      type: "string",
      enum: ["pursue", "skip", "needs_human"],
    },
  },
  required: ["score", "confidence", "reason", "recommendedAction"],
  additionalProperties: false,
};

export const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Subject line of the email." },
    body: { type: "string", description: "Body of the email." },
    evidence: {
      type: "array",
      description:
        "One entry per personalized claim made in the body. Every claim must appear in the body character for character.",
      items: {
        type: "object",
        properties: {
          claim: {
            type: "string",
            description: "The exact text from the body that makes this claim.",
          },
          sourceField: {
            type: "string",
            enum: [...MERCHANT_FIELDS],
            description: "The merchant field this claim is based on.",
          },
          sourceValue: {
            type: "string",
            description: "The value of that field, as given to you.",
          },
        },
        required: ["claim", "sourceField", "sourceValue"],
        additionalProperties: false,
      },
    },
  },
  required: ["subject", "body", "evidence"],
  additionalProperties: false,
};

// ─── Parsing ───────────────────────────────────────────────────

function parseJson(model: ModelId, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new LlmResponseError(model, "the response was not valid JSON", { cause });
  }
}

function asRecord(model: ModelId, value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LlmResponseError(model, `${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function parseTriagePayload(model: ModelId, text: string): TriagePayload {
  const raw = asRecord(model, parseJson(model, text), "the triage response");

  const score = raw.score;
  const confidence = raw.confidence;
  const reason = raw.reason;
  const recommendedAction = raw.recommendedAction;

  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    throw new LlmResponseError(model, `score must be an integer 0-100, got ${JSON.stringify(score)}`);
  }
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new LlmResponseError(
      model,
      `confidence must be a number 0-1, got ${JSON.stringify(confidence)}`,
    );
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new LlmResponseError(model, "reason must be a non-empty string");
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new LlmResponseError(
      model,
      `reason is ${reason.length} characters; the limit is ${MAX_REASON_LENGTH}`,
    );
  }
  if (
    recommendedAction !== "pursue" &&
    recommendedAction !== "skip" &&
    recommendedAction !== "needs_human"
  ) {
    throw new LlmResponseError(
      model,
      `recommendedAction must be pursue, skip or needs_human, got ${JSON.stringify(recommendedAction)}`,
    );
  }

  return { score, confidence, reason, recommendedAction };
}

export function parseDraftPayload(model: ModelId, text: string): DraftPayload {
  const raw = asRecord(model, parseJson(model, text), "the draft response");

  const { subject, body, evidence } = raw;

  if (typeof subject !== "string" || subject.trim().length === 0) {
    throw new LlmResponseError(model, "subject must be a non-empty string");
  }
  if (typeof body !== "string" || body.trim().length === 0) {
    throw new LlmResponseError(model, "body must be a non-empty string");
  }
  if (!Array.isArray(evidence)) {
    throw new LlmResponseError(model, "evidence must be an array");
  }

  const parsed: EvidenceRef[] = evidence.map((entry, index) => {
    const item = asRecord(model, entry, `evidence[${index}]`);
    const { claim, sourceField, sourceValue } = item;

    if (typeof claim !== "string" || claim.length === 0) {
      throw new LlmResponseError(model, `evidence[${index}].claim must be a non-empty string`);
    }
    if (typeof sourceField !== "string" || !MERCHANT_FIELD_SET.has(sourceField)) {
      throw new LlmResponseError(
        model,
        `evidence[${index}].sourceField must be a Merchant field, got ${JSON.stringify(sourceField)}`,
      );
    }
    if (typeof sourceValue !== "string") {
      throw new LlmResponseError(model, `evidence[${index}].sourceValue must be a string`);
    }

    return { claim, sourceField: sourceField as keyof Merchant, sourceValue };
  });

  return { subject, body, evidence: parsed };
}
