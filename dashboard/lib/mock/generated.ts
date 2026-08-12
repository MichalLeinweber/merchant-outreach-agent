import type { GateId, MerchantCategory, ModelId, OutreachState } from "../contracts";
import type { BodyPart } from "./build";
import { c, spanOf, usage } from "./build";
import type { OutreachRecord, RecordSpec } from "./record";
import { buildRecord } from "./record";

/**
 * The rest of the campaign.
 *
 * A queue with fourteen rows does not look like a queue. These twenty-six
 * records exist for density — the screen has to show what a working shift
 * actually looks like — so their bodies come from one template rather than
 * being written individually. Their evidence is still real: every claim is
 * built from a field on the merchant record, the same way the hand-written
 * drafts are.
 *
 * They also carry the gate failures the hand-written set does not, so the
 * queue's "blocking gate" filter has something to filter on for all twelve.
 */

const SIGN_OFF = "\n\nBest,\nNora Whitfield\nGroupon Merchant Partnerships";

/** A deliberately broken draft, one per gate the hand-written set misses. */
type Defect =
  | { gate: "G01_schema" }
  | { gate: "G04_merchant_name"; nameInBody: string }
  | { gate: "G07_banned_claims" }
  | { gate: "G10_single_cta" }
  | { gate: "G11_frequency_cap" }
  | { gate: "G12_compliance" }
  | { gate: "G09_locale" };

interface Seed {
  slug: string;
  name: string;
  category: MerchantCategory;
  city: string;
  countryCode: "GB" | "IE";
  rating: number;
  reviewCount: number;
  yearsInBusiness: number;
  capacity: number;
  /** ISO date the last offer ended. */
  lastOffer: string;
  state: OutreachState;
  score: number;
  /** Set when triage escalated; the value is the model that resolved it. */
  escalatedTo?: ModelId;
  defect?: Defect;
}

const SEEDS: Seed[] = [
  { slug: "gilder_lane_tapas", name: "Gilder Lane Tapas", category: "restaurant", city: "Leeds", countryCode: "GB", rating: 4.4, reviewCount: 389, yearsInBusiness: 5, capacity: 40, lastOffer: "2026-03-08", state: "PENDING_APPROVAL", score: 78 },
  { slug: "harlow_steam_rooms", name: "Harlow Steam Rooms", category: "spa_wellness", city: "Birmingham", countryCode: "GB", rating: 4.2, reviewCount: 512, yearsInBusiness: 10, capacity: 34, lastOffer: "2026-02-27", state: "PENDING_APPROVAL", score: 71 },
  { slug: "vaultworks_gym", name: "Vaultworks Gym", category: "fitness", city: "Glasgow", countryCode: "GB", rating: 4.0, reviewCount: 233, yearsInBusiness: 6, capacity: 110, lastOffer: "2026-05-19", state: "BLOCKED", score: 64, defect: { gate: "G07_banned_claims" } },
  { slug: "lume_hair_house", name: "Lume Hair House", category: "beauty", city: "Belfast", countryCode: "GB", rating: 4.7, reviewCount: 167, yearsInBusiness: 4, capacity: 9, lastOffer: "2026-04-14", state: "SENT", score: 83 },
  { slug: "tidewater_surf_school", name: "Tidewater Surf School", category: "activity", city: "Newquay", countryCode: "GB", rating: 4.8, reviewCount: 641, yearsInBusiness: 12, capacity: 18, lastOffer: "2025-10-05", state: "PENDING_APPROVAL", score: 86 },
  { slug: "inkwell_letterpress", name: "Inkwell Letterpress", category: "class_workshop", city: "York", countryCode: "GB", rating: 4.9, reviewCount: 74, yearsInBusiness: 3, capacity: 8, lastOffer: "2026-06-11", state: "PENDING_APPROVAL", score: 80 },
  { slug: "ashgrove_pilates", name: "Ashgrove Pilates Studio", category: "fitness", city: "Reading", countryCode: "GB", rating: 4.5, reviewCount: 129, yearsInBusiness: 4, capacity: 16, lastOffer: "2026-05-08", state: "BLOCKED", score: 70, defect: { gate: "G04_merchant_name", nameInBody: "Ashgrove Pilates Studios" } },
  { slug: "copperpot_kitchen", name: "Copperpot Kitchen", category: "restaurant", city: "Cardiff", countryCode: "GB", rating: 4.3, reviewCount: 704, yearsInBusiness: 9, capacity: 56, lastOffer: "2026-01-22", state: "APPROVED", score: 75 },
  { slug: "solace_day_spa", name: "Solace Day Spa", category: "spa_wellness", city: "Limerick", countryCode: "IE", rating: 4.6, reviewCount: 205, yearsInBusiness: 7, capacity: 22, lastOffer: "2026-03-30", state: "BLOCKED", score: 77, defect: { gate: "G12_compliance" } },
  { slug: "rialto_barbers", name: "Rialto Barbers", category: "beauty", city: "Dublin", countryCode: "IE", rating: 4.4, reviewCount: 318, yearsInBusiness: 8, capacity: 6, lastOffer: "2026-07-02", state: "BLOCKED", score: 68, defect: { gate: "G11_frequency_cap" } },
  { slug: "hollowbrook_archery", name: "Hollowbrook Archery", category: "activity", city: "Exeter", countryCode: "GB", rating: 4.7, reviewCount: 152, yearsInBusiness: 11, capacity: 24, lastOffer: "2026-04-30", state: "PENDING_APPROVAL", score: 79, escalatedTo: "claude-sonnet-5" },
  { slug: "the_glass_bench", name: "The Glass Bench", category: "class_workshop", city: "Bristol", countryCode: "GB", rating: 4.8, reviewCount: 91, yearsInBusiness: 2, capacity: 10, lastOffer: "2026-06-24", state: "QUEUED", score: 82 },
  { slug: "marlowe_bistro", name: "Marlowe Bistro", category: "restaurant", city: "Cambridge", countryCode: "GB", rating: 4.1, reviewCount: 445, yearsInBusiness: 13, capacity: 52, lastOffer: "2026-02-05", state: "PENDING_APPROVAL", score: 66, defect: { gate: "G10_single_cta" } },
  { slug: "quarry_road_sauna", name: "Quarry Road Sauna", category: "spa_wellness", city: "Sheffield", countryCode: "GB", rating: 4.5, reviewCount: 138, yearsInBusiness: 3, capacity: 16, lastOffer: "2026-05-27", state: "PENDING_APPROVAL", score: 74 },
  { slug: "beacon_boxing", name: "Beacon Boxing Club", category: "fitness", city: "Liverpool", countryCode: "GB", rating: 4.6, reviewCount: 287, yearsInBusiness: 15, capacity: 75, lastOffer: "2026-03-17", state: "SENT", score: 81 },
  { slug: "orchid_lash_bar", name: "Orchid Lash Bar", category: "beauty", city: "Galway", countryCode: "IE", rating: 4.9, reviewCount: 143, yearsInBusiness: 2, capacity: 4, lastOffer: "2026-06-08", state: "BLOCKED", score: 85, defect: { gate: "G01_schema" } },
  { slug: "windrose_sailing", name: "Windrose Sailing", category: "activity", city: "Southampton", countryCode: "GB", rating: 4.4, reviewCount: 226, yearsInBusiness: 18, capacity: 12, lastOffer: "2025-09-14", state: "PENDING_APPROVAL", score: 73 },
  { slug: "flourbox_bakery_school", name: "Flourbox Bakery School", category: "class_workshop", city: "Cork", countryCode: "IE", rating: 4.7, reviewCount: 108, yearsInBusiness: 6, capacity: 14, lastOffer: "2026-04-19", state: "BLOCKED", score: 76, defect: { gate: "G09_locale" } },
  { slug: "sable_and_rye", name: "Sable & Rye", category: "restaurant", city: "Edinburgh", countryCode: "GB", rating: 4.6, reviewCount: 583, yearsInBusiness: 7, capacity: 44, lastOffer: "2026-01-31", state: "FAILED", score: 84 },
  { slug: "lantern_float_studio", name: "Lantern Float Studio", category: "spa_wellness", city: "Nottingham", countryCode: "GB", rating: 4.3, reviewCount: 87, yearsInBusiness: 2, capacity: 5, lastOffer: "2026-07-08", state: "GATED", score: 62 },
  { slug: "granite_crossfit", name: "Granite CrossFit", category: "fitness", city: "Aberdeen", countryCode: "GB", rating: 4.2, reviewCount: 194, yearsInBusiness: 5, capacity: 60, lastOffer: "2026-06-01", state: "REJECTED", score: 59 },
  { slug: "verity_skin_clinic", name: "Verity Skin Clinic", category: "beauty", city: "Manchester", countryCode: "GB", rating: 4.8, reviewCount: 356, yearsInBusiness: 9, capacity: 7, lastOffer: "2026-03-03", state: "PENDING_APPROVAL", score: 87, escalatedTo: "claude-sonnet-5" },
  { slug: "pinefall_zip_park", name: "Pinefall Zip Park", category: "activity", city: "Inverness", countryCode: "GB", rating: 4.5, reviewCount: 412, yearsInBusiness: 8, capacity: 45, lastOffer: "2026-05-12", state: "APPROVED", score: 78 },
  { slug: "cobalt_pottery", name: "Cobalt Pottery", category: "class_workshop", city: "Waterford", countryCode: "IE", rating: 4.6, reviewCount: 63, yearsInBusiness: 3, capacity: 9, lastOffer: "2026-06-17", state: "PENDING_APPROVAL", score: 72 },
  { slug: "harewood_smokehouse", name: "Harewood Smokehouse", category: "restaurant", city: "Newcastle", countryCode: "GB", rating: 4.0, reviewCount: 261, yearsInBusiness: 4, capacity: 38, lastOffer: "2026-04-08", state: "PENDING_APPROVAL", score: 65 },
  { slug: "still_water_yoga", name: "Still Water Yoga", category: "fitness", city: "Oxford", countryCode: "GB", rating: 4.9, reviewCount: 121, yearsInBusiness: 6, capacity: 18, lastOffer: "2026-02-19", state: "SENT", score: 88 },
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-03-08" → "8 March". Fixed to UTC, so it never shifts by timezone. */
function readableDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  const month = MONTHS[date.getUTCMonth()];
  return `${date.getUTCDate()} ${month ?? "?"}`;
}

/** The extra sentence a defect needs in the body, if any. */
function defectSentence(defect: Defect | undefined): string {
  switch (defect?.gate) {
    case "G07_banned_claims":
      return " This is guaranteed to double your bookings in the first month.";
    case "G10_single_cta":
      return " Reply to this email to get started, or book a slot in my diary using the link below.";
    case "G09_locale":
      return " We can have the offer authorized and live within a week.";
    default:
      return "";
  }
}

function buildSeed(seed: Seed, index: number): OutreachRecord {
  const nameInBody =
    seed.defect?.gate === "G04_merchant_name" ? seed.defect.nameInBody : seed.name;

  const parts: BodyPart[] = [
    "Hi there,\n\n",
    c(nameInBody, "name", seed.name),
    " holds ",
    c(`a ${seed.rating.toFixed(1)} rating`, "rating", String(seed.rating)),
    " from ",
    c(`${seed.reviewCount} reviews`, "reviewCount", String(seed.reviewCount)),
    " after ",
    c(`${seed.yearsInBusiness} years`, "yearsInBusiness", String(seed.yearsInBusiness)),
    " of trading, and nothing has been live on the marketplace since ",
    c(readableDate(seed.lastOffer), "lastOfferEndedAt", `${seed.lastOffer}T00:00:00.000Z`),
    ".\n\nWith ",
    c(`${seed.capacity} places`, "seatsOrCapacity", String(seed.capacity)),
    " to fill, a weekday-only offer is the lowest-risk way back on — it reaches new ",
    c(seed.city, "city", seed.city),
    " bookers without touching the rate on the slots that already sell.",
    defectSentence(seed.defect),
    "\n\nWould a short call this week be useful?",
    SIGN_OFF,
  ];

  const triageModel: ModelId = seed.escalatedTo ?? "claude-haiku-4-5-20251001";

  // Deterministic variation, so the token columns are not all the same number
  // while the data stays stable between renders.
  const jitter = (index * 37) % 90;

  const spec: RecordSpec = {
    slug: seed.slug,
    merchant: {
      name: seed.name,
      category: seed.category,
      city: seed.city,
      countryCode: seed.countryCode,
      locale: seed.countryCode === "IE" ? "en-IE" : "en-GB",
      websiteUrl: index % 5 === 0 ? null : `https://${seed.slug.replace(/_/g, "")}.example.invalid`,
      contactEmail: `hello@${seed.slug.replace(/_/g, "")}.example.invalid`,
      rating: seed.rating,
      reviewCount: seed.reviewCount,
      yearsInBusiness: seed.yearsInBusiness,
      hasActiveOffer: false,
      lastOfferEndedAt: `${seed.lastOffer}T00:00:00.000Z`,
      seatsOrCapacity: seed.capacity,
      signals: [
        {
          key: "deal_gap",
          value: `No live offer since ${readableDate(seed.lastOffer)}`,
          sourceField: "lastOfferEndedAt",
        },
      ],
    },
    triage: {
      score: seed.score,
      confidence: seed.escalatedTo ? 0.72 + (index % 7) / 100 : 0.8 + (index % 15) / 100,
      reason: seed.escalatedTo
        ? "Low confidence on the first pass; re-run on a stronger model confirmed the case."
        : "Rating above the category median with no live offer and usable weekday capacity.",
      recommendedAction: seed.score >= 60 ? "pursue" : "needs_human",
      model: triageModel,
      escalated: seed.escalatedTo !== undefined,
      usage: usage(triageModel, 1150 + jitter, 145 + (jitter % 30), 940),
    },
    draft: {
      subject: `A weekday offer for ${seed.name}`,
      parts,
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2230 + jitter, 360 + (jitter % 60), 1760),
      ageMinutes: 26 + index * 43,
    },
    gates: {
      durationMs: 28 + (jitter % 25),
      ...(seed.defect ? { failures: defectFailure(seed.defect) } : {}),
      ...(seed.state === "GATED"
        ? { pending: ["G10_single_cta", "G11_frequency_cap", "G12_compliance"] satisfies GateId[] }
        : {}),
    },
    attempt: {
      state: seed.state,
      ...(["APPROVED", "QUEUED", "SENT", "REJECTED", "FAILED"].includes(seed.state)
        ? { approvedBy: "m.okafor@example.invalid", approvedAfterMinutes: 95 + (jitter % 240) }
        : {}),
      ...(["SENT", "FAILED"].includes(seed.state)
        ? { sentAfterMinutes: 100 + (jitter % 240) }
        : {}),
      ...(seed.state === "SENT"
        ? { providerMessageId: `msg_01${seed.slug.toUpperCase().replace(/_/g, "").slice(0, 20)}` }
        : {}),
      ...(seed.state === "FAILED"
        ? {
            failureReason: "Provider returned 550: recipient mailbox unavailable.",
            attemptCount: 3,
          }
        : {}),
    },
  };

  return buildRecord(spec);
}

/** Maps a defect onto the gate failure it should produce. */
function defectFailure(defect: Defect): RecordSpec["gates"]["failures"] {
  switch (defect.gate) {
    case "G01_schema":
      // No spans: the draft did not parse, so there are no offsets to point at.
      return {
        G01_schema: () => ({
          detail:
            "Model output did not match the draft schema: `subject` was returned as an array of strings rather than a string.",
        }),
      };
    case "G04_merchant_name":
      return {
        G04_merchant_name: (body) => ({
          detail: `Body says "${defect.nameInBody}", the merchant record says something else. The name must match the record exactly.`,
          spans: [spanOf(body, defect.nameInBody)],
        }),
      };
    case "G07_banned_claims":
      return {
        G07_banned_claims: (body) => ({
          detail:
            'Performance guarantee detected. "guaranteed to double your bookings" is on the banned claims list.',
          spans: [spanOf(body, "guaranteed to double your bookings in the first month")],
        }),
      };
    case "G10_single_cta":
      return {
        G10_single_cta: (body) => ({
          detail:
            "Two calls to action in one message. Outreach carries exactly one, so the response is unambiguous.",
          spans: [spanOf(body, "book a slot in my diary using the link below")],
        }),
      };
    case "G11_frequency_cap":
      return {
        G11_frequency_cap: () => ({
          detail:
            "This merchant was approached 9 days ago in campaign cmp_2026w31_uk_ie_winback. The cap is one approach per 30 days.",
        }),
      };
    case "G12_compliance":
      return {
        G12_compliance: () => ({
          detail:
            "No opt-out line in the body. Commercial outreach to an IE address requires one in the first message.",
        }),
      };
    case "G09_locale":
      return {
        G09_locale: (body) => ({
          detail: 'Draft locale is en-IE but "authorized" is the en-US spelling. Expected "authorised".',
          spans: [spanOf(body, "authorized")],
        }),
      };
  }
}

export const GENERATED_RECORDS: OutreachRecord[] = SEEDS.map(buildSeed);
