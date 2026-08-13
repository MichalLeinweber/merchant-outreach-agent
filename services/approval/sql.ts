/**
 * Reading Postgres errors.
 *
 * Only unique violations, and only by name. The rule this file exists to
 * serve: a conflict on `uq_outbox_attempt` means "already queued" and is part
 * of normal operation, while a conflict on `uq_attempt_sent` means the
 * database just stopped a second send and must never be swallowed. Telling
 * them apart requires looking at *which* constraint fired, so nothing here
 * ever matches a unique violation in general.
 */

/** Postgres SQLSTATE for unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Whether an error is a unique violation on one named constraint.
 *
 * The check is deliberately narrow. The SQLSTATE alone would match any unique
 * index in the schema, and "the insert conflicted with something" is not a
 * fact any caller here is allowed to act on.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;

  const { code, constraint: named, message } = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };

  if (named === constraint) return true;

  // The Encore runtime does not always surface the driver's structured
  // fields, so the constraint name is also matched in the message text —
  // Postgres always names it: `duplicate key value violates unique
  // constraint "uq_attempt_dedup"`.
  const text = typeof message === "string" ? message : "";
  const namesConstraint = text.includes(constraint);

  return namesConstraint && (code === UNIQUE_VIOLATION || text.includes("unique"));
}
