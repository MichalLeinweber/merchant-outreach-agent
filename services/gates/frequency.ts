/**
 * G11 — the frequency cap.
 *
 * The one gate that depends on something outside the draft: whether this
 * merchant has heard from us recently. It still takes no I/O. The caller
 * looks the previous send up and puts it in the context, along with the
 * instant to measure from, and the gate does arithmetic on two given values.
 *
 * That split is what makes the cap testable. A gate that read the clock
 * itself could not be tested at a boundary without either mocking time or
 * waiting for it, and a cap whose behaviour on its exact boundary is unknown
 * is a cap nobody can reason about.
 */

import { fail, pass, type Gate } from "./types.js";

const MS_PER_DAY = 86_400_000;

export const g11FrequencyCap: Gate = (_draft, _merchant, context) => {
  const previous = context.previousApproach;
  if (previous === null) return pass("G11_frequency_cap");

  const sentAt = Date.parse(previous.sentAt);
  const now = Date.parse(context.now);

  // An unparseable instant is not a pass. Something upstream is broken, and
  // treating a broken cap as "no previous approach" is how a merchant gets
  // mailed twice in a week.
  if (Number.isNaN(sentAt) || Number.isNaN(now)) {
    return fail(
      "G11_frequency_cap",
      `The frequency cap cannot be evaluated: ` +
        `previous send ${JSON.stringify(previous.sentAt)} / evaluation time ` +
        `${JSON.stringify(context.now)} is not a parseable instant.`,
    );
  }

  const elapsedDays = (now - sentAt) / MS_PER_DAY;
  if (elapsedDays >= context.frequencyCapDays) return pass("G11_frequency_cap");

  const dueAt = new Date(sentAt + context.frequencyCapDays * MS_PER_DAY);

  // No spans: nothing in the body is wrong. The draft is fine and the timing
  // is not, which is a distinction the interface should be able to draw.
  return fail(
    "G11_frequency_cap",
    `This merchant was approached ${Math.floor(elapsedDays)} day(s) ago in campaign ` +
      `${previous.campaignId}. The cap is one approach per ${context.frequencyCapDays} ` +
      `days; the next one is due after ${dueAt.toISOString()}.`,
  );
};
