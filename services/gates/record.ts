/**
 * The source record, as data.
 *
 * G05 and G06 both need to ask "is this in the record?", which means the set
 * of fields has to be enumerable at runtime, not just at the type level.
 *
 * The list is duplicated from `services/agents/schemas.ts` on purpose. Encore
 * services do not reach into each other's internals — a shared helper between
 * two services is a dependency that shows up in the build topology and not in
 * anybody's mental model. The exhaustiveness check below makes the duplicate
 * safe: a field added to `Merchant` breaks compilation here, so the copy
 * cannot quietly fall behind the original.
 */

import type { Merchant } from "../../shared/contracts.js";

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

type _AllMerchantFieldsListed =
  Exclude<keyof Merchant, (typeof MERCHANT_FIELDS)[number]> extends never
    ? true
    : [
        "missing from MERCHANT_FIELDS:",
        Exclude<keyof Merchant, (typeof MERCHANT_FIELDS)[number]>,
      ];
const _fieldsAreExhaustive: _AllMerchantFieldsListed = true;
void _fieldsAreExhaustive;

export const MERCHANT_FIELD_SET: ReadonlySet<string> = new Set(MERCHANT_FIELDS);

/** Every value a `Merchant` field can hold. */
export type MerchantFieldValue = Merchant[keyof Merchant];

/** How a field's value reads in a failure message. */
export function describeValue(value: MerchantFieldValue): string {
  return value === null ? "null" : JSON.stringify(value);
}
