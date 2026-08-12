import { c, spanOf, usage } from "./build";
import type { OutreachRecord } from "./record";
import { buildRecord } from "./record";

/**
 * The hand-written part of the campaign.
 *
 * These fourteen records carry the prose. They exist so the draft detail screen
 * has something real to show: bodies that read like outreach, claims that are
 * genuinely traceable to a field on the merchant record, and gate failures that
 * point at the specific words that broke them.
 *
 * Between them they cover every lifecycle state worth looking at, four
 * different blocking gates, both warning gates, an escalation to Sonnet and one
 * to Opus, and a draft caught mid-evaluation with four gates still pending.
 *
 * All of it is synthetic. Every contact address ends in @example.invalid, which
 * the production database enforces with a constraint.
 */

const SIGN_OFF = "\n\nBest,\nNora Whitfield\nGroupon Merchant Partnerships";

export const HAND_WRITTEN_RECORDS: OutreachRecord[] = [
  // ── 1. Clean draft, waiting for a human ────────────────────────
  buildRecord({
    slug: "kettle_crumb",
    merchant: {
      name: "Kettle & Crumb",
      category: "restaurant",
      city: "Bristol",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://kettleandcrumb.example.invalid",
      contactEmail: "hello@kettleandcrumb.example.invalid",
      rating: 4.7,
      reviewCount: 812,
      yearsInBusiness: 6,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-02-14T00:00:00.000Z",
      seatsOrCapacity: 48,
      signals: [
        {
          key: "deal_gap",
          value: "No live offer for 179 days",
          sourceField: "lastOfferEndedAt",
        },
        {
          key: "high_rating_low_volume",
          value: "4.7 rating but no current listing to convert it",
          sourceField: "rating",
        },
      ],
    },
    triage: {
      score: 84,
      confidence: 0.88,
      reason:
        "Six-month gap since the last offer, rating well above category median, and 48 covers to fill midweek. Clear reactivation case.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1180, 164, 940),
    },
    draft: {
      subject: "Bristol diners are still finding Kettle & Crumb",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2310, 402, 1760),
      ageMinutes: 214,
      parts: [
        "Hi there,\n\nYour last offer with us ended on ",
        c("14 February", "lastOfferEndedAt", "2026-02-14T00:00:00.000Z"),
        ", and ",
        c("Kettle & Crumb", "name", "Kettle & Crumb"),
        " has been off the marketplace since. The demand has not gone anywhere: ",
        c("a 4.7 rating", "rating", "4.7"),
        " across ",
        c("812 reviews", "reviewCount", "812"),
        " keeps you near the top of local search.\n\nRestaurants coming back after a gap tend to fill their quietest services first. With ",
        c("48 covers", "seatsOrCapacity", "48"),
        ", a Tuesday-to-Thursday offer is the shape most ",
        c("Bristol", "city", "Bristol"),
        " partners choose — it protects the weekend rate that already sells.\n\nWould twenty minutes this week work to look at the numbers together?",
        SIGN_OFF,
      ],
    },
    gates: { durationMs: 41 },
    attempt: { state: "PENDING_APPROVAL" },
  }),

  // ── 2. Blocked: an ungrounded superlative ──────────────────────
  buildRecord({
    slug: "ardsley_bathhouse",
    merchant: {
      name: "Ardsley Bathhouse",
      category: "spa_wellness",
      city: "Leeds",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://ardsleybathhouse.example.invalid",
      contactEmail: "bookings@ardsleybathhouse.example.invalid",
      rating: 4.6,
      reviewCount: 344,
      yearsInBusiness: 3,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-05-30T00:00:00.000Z",
      seatsOrCapacity: 26,
      signals: [
        {
          key: "deal_gap",
          value: "No live offer for 74 days",
          sourceField: "lastOfferEndedAt",
        },
        {
          key: "capacity_headroom",
          value: "26 places per session, weekday sessions under-filled",
          sourceField: "seatsOrCapacity",
        },
      ],
    },
    triage: {
      score: 79,
      confidence: 0.83,
      reason:
        "Recent gap, strong rating, session capacity that suits a twilight slot. Worth a reactivation approach.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1205, 158, 940),
    },
    draft: {
      subject: "Filling weekday sessions at Ardsley Bathhouse",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2288, 468, 1760),
      ageMinutes: 168,
      parts: [
        "Hi there,\n\n",
        c("Ardsley Bathhouse", "name", "Ardsley Bathhouse"),
        " has been off the marketplace since ",
        c("30 May", "lastOfferEndedAt", "2026-05-30T00:00:00.000Z"),
        ". Through that whole window your listing held ",
        c("a 4.6 rating", "rating", "4.6"),
        " from ",
        c("344 reviews", "reviewCount", "344"),
        ".\n\nYou are the most booked bathhouse in the city, and returning guests will follow you back the moment something is live.\n\nWith ",
        c("26 places", "seatsOrCapacity", "26"),
        " per session, a weekday twilight slot is usually the easiest to fill without touching weekend pricing. Partners in ",
        c("Leeds", "city", "Leeds"),
        " running that shape tend to clear their quietest sessions first, which keeps the rate intact on the sessions that already sell out, and it gives you a clean read on how much of the weekday demand is genuinely new rather than moved from another day.",
        SIGN_OFF,
      ],
    },
    gates: {
      durationMs: 47,
      failures: {
        G05_evidence_grounding: (body) => ({
          detail:
            'Claim "the most booked bathhouse in the city" is not traceable to any field on the merchant record. Ranking data is not collected.',
          spans: [spanOf(body, "the most booked bathhouse in the city")],
        }),
        G02_length: (body) => ({
          detail: `Body is ${body.length} characters; the limit for en-GB is 900.`,
        }),
      },
    },
    attempt: { state: "BLOCKED" },
  }),

  // ── 3. Escalated to Sonnet after a low-confidence first pass ────
  buildRecord({
    slug: "northgate_strength",
    merchant: {
      name: "Northgate Strength",
      category: "fitness",
      city: "Manchester",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: null,
      contactEmail: "team@northgatestrength.example.invalid",
      rating: 4.4,
      reviewCount: 156,
      yearsInBusiness: 2,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-06-18T00:00:00.000Z",
      seatsOrCapacity: 90,
      signals: [
        {
          key: "new_to_market",
          value: "Trading 2 years, first offer ran this spring",
          sourceField: "yearsInBusiness",
        },
        {
          key: "capacity_headroom",
          value: "90 member places, off-peak largely unused",
          sourceField: "seatsOrCapacity",
        },
      ],
    },
    triage: {
      score: 66,
      confidence: 0.79,
      reason:
        "Haiku returned 0.42 confidence on a thin review history. Re-run on Sonnet resolved it: young gym, real capacity headroom, no live offer.",
      recommendedAction: "pursue",
      model: "claude-sonnet-5",
      escalated: true,
      usage: usage("claude-sonnet-5", 1840, 236, 1180),
    },
    draft: {
      subject: "Off-peak capacity at Northgate Strength",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2260, 388, 1760),
      ageMinutes: 143,
      parts: [
        "Hi there,\n\nTwo years in, ",
        c("Northgate Strength", "name", "Northgate Strength"),
        " has built ",
        c("a 4.4 rating", "rating", "4.4"),
        " from ",
        c("156 reviews", "reviewCount", "156"),
        " — a good base, and small enough that every new member still moves the number.\n\nYour last offer ended on ",
        c("18 June", "lastOfferEndedAt", "2026-06-18T00:00:00.000Z"),
        ". With ",
        c("90 places", "seatsOrCapacity", "90"),
        " on the books, the daytime hours are where an offer costs you least and earns most.\n\nCan I show you what two other ",
        c("Manchester", "city", "Manchester"),
        " gyms did with their off-peak slots?",
        SIGN_OFF,
      ],
    },
    gates: { durationMs: 38 },
    attempt: { state: "PENDING_APPROVAL" },
  }),

  // ── 4. Locale warning: US spelling in an en-IE draft ────────────
  buildRecord({
    slug: "vela_nail_studio",
    merchant: {
      name: "Vela Nail Studio",
      category: "beauty",
      city: "Dublin",
      countryCode: "IE",
      locale: "en-IE",
      websiteUrl: "https://velanails.example.invalid",
      contactEmail: "studio@velanails.example.invalid",
      rating: 4.9,
      reviewCount: 271,
      yearsInBusiness: 4,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-04-02T00:00:00.000Z",
      seatsOrCapacity: 8,
      signals: [
        {
          key: "high_rating_low_volume",
          value: "4.9 rating on 271 reviews, no live offer",
          sourceField: "rating",
        },
      ],
    },
    triage: {
      score: 88,
      confidence: 0.91,
      reason:
        "Highest rating in the Dublin beauty set with no live offer since April. Small capacity, so a tightly capped deal fits.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1160, 152, 940),
    },
    draft: {
      subject: "A capped offer for Vela Nail Studio",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2240, 372, 1760),
      ageMinutes: 96,
      parts: [
        "Hi there,\n\n",
        c("A 4.9 rating", "rating", "4.9"),
        " from ",
        c("271 reviews", "reviewCount", "271"),
        " is the strongest in our ",
        c("Dublin", "city", "Dublin"),
        " beauty set, and ",
        c("Vela Nail Studio", "name", "Vela Nail Studio"),
        " has had nothing live since ",
        c("2 April", "lastOfferEndedAt", "2026-04-02T00:00:00.000Z"),
        ".\n\nWith ",
        c("8 chairs", "seatsOrCapacity", "8"),
        ", volume is not the goal — a customized, tightly capped offer is. Most studios your size cap at forty redemptions and close the offer once it is met.\n\nWould you like to see how that cap works in practice?",
        SIGN_OFF,
      ],
    },
    gates: {
      durationMs: 44,
      failures: {
        G09_locale: (body) => ({
          detail:
            'Draft locale is en-IE but "customized" is the en-US spelling. Expected "customised".',
          spans: [spanOf(body, "customized")],
        }),
      },
    },
    // G09 blocks: a draft written for the wrong market never reaches a
    // reviewer's queue.
    attempt: { state: "BLOCKED" },
  }),

  // ── 5. Clean, seasonal angle ───────────────────────────────────
  buildRecord({
    slug: "cliffline_kayak",
    merchant: {
      name: "Cliffline Kayak Tours",
      category: "activity",
      city: "Galway",
      countryCode: "IE",
      locale: "en-IE",
      websiteUrl: "https://clifflinekayak.example.invalid",
      contactEmail: "book@clifflinekayak.example.invalid",
      rating: 4.8,
      reviewCount: 503,
      yearsInBusiness: 9,
      hasActiveOffer: false,
      lastOfferEndedAt: "2025-09-28T00:00:00.000Z",
      seatsOrCapacity: 14,
      signals: [
        {
          key: "seasonal_window",
          value: "Season runs to late September; last offer ended 28 Sep 2025",
          sourceField: "lastOfferEndedAt",
        },
        {
          key: "deal_gap",
          value: "No live offer for a full season",
          sourceField: "hasActiveOffer",
        },
      ],
    },
    triage: {
      score: 81,
      confidence: 0.86,
      reason:
        "Seasonal operator with six weeks of season left and no live offer since last autumn. Timing is the whole case here.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1190, 170, 940),
    },
    draft: {
      subject: "Six weeks of season left in Galway",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2295, 396, 1760),
      ageMinutes: 88,
      parts: [
        "Hi there,\n\n",
        c("Cliffline Kayak Tours", "name", "Cliffline Kayak Tours"),
        " has run for ",
        c("nine years", "yearsInBusiness", "9"),
        " and holds ",
        c("a 4.8 rating", "rating", "4.8"),
        " over ",
        c("503 reviews", "reviewCount", "503"),
        ". Your last offer ended ",
        c("28 September", "lastOfferEndedAt", "2025-09-28T00:00:00.000Z"),
        " — a full season ago.\n\nThere are about six weeks of usable weather left. With ",
        c("14 places", "seatsOrCapacity", "14"),
        " per launch, an offer now lands while people are still booking ",
        c("Galway", "city", "Galway"),
        " trips rather than planning next year's.\n\nShall we get something live this week?",
        SIGN_OFF,
      ],
    },
    gates: { durationMs: 36 },
    attempt: { state: "PENDING_APPROVAL" },
  }),

  // ── 6. Approved, waiting to send ───────────────────────────────
  buildRecord({
    slug: "proof_room",
    merchant: {
      name: "The Proof Room",
      category: "class_workshop",
      city: "Edinburgh",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://theproofroom.example.invalid",
      contactEmail: "hello@theproofroom.example.invalid",
      rating: 4.9,
      reviewCount: 188,
      yearsInBusiness: 5,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-03-21T00:00:00.000Z",
      seatsOrCapacity: 12,
      signals: [
        {
          key: "high_rating_low_volume",
          value: "4.9 rating, only 188 reviews for 5 years of trading",
          sourceField: "reviewCount",
        },
      ],
    },
    triage: {
      score: 87,
      confidence: 0.9,
      reason:
        "Near-perfect rating, low review volume for its age, and no live offer since March. Classes convert well from a gift angle.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1175, 160, 940),
    },
    draft: {
      subject: "Booking out The Proof Room's autumn classes",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2270, 384, 1760),
      ageMinutes: 402,
      parts: [
        "Hi there,\n\n",
        c("The Proof Room", "name", "The Proof Room"),
        " holds ",
        c("a 4.9 rating", "rating", "4.9"),
        " — but only ",
        c("188 reviews", "reviewCount", "188"),
        " after ",
        c("five years", "yearsInBusiness", "5"),
        ". That gap usually means the classes sell out to people who already know you.\n\nNothing has been live since ",
        c("21 March", "lastOfferEndedAt", "2026-03-21T00:00:00.000Z"),
        ". With ",
        c("12 places", "seatsOrCapacity", "12"),
        " per class, one autumn slot per week is enough to reach a new ",
        c("Edinburgh", "city", "Edinburgh"),
        " audience without disturbing the regulars.\n\nWould one slot a week be worth trying?",
        SIGN_OFF,
      ],
    },
    gates: { durationMs: 39 },
    attempt: {
      state: "APPROVED",
      approvedBy: "m.okafor@example.invalid",
      approvedAfterMinutes: 191,
    },
  }),

  // ── 7. Sent ────────────────────────────────────────────────────
  buildRecord({
    slug: "saffron_sea",
    merchant: {
      name: "Saffron & Sea",
      category: "restaurant",
      city: "Brighton",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://saffronandsea.example.invalid",
      contactEmail: "manager@saffronandsea.example.invalid",
      rating: 4.5,
      reviewCount: 967,
      yearsInBusiness: 11,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-01-09T00:00:00.000Z",
      seatsOrCapacity: 72,
      signals: [
        {
          key: "deal_gap",
          value: "No live offer for 215 days",
          sourceField: "lastOfferEndedAt",
        },
        {
          key: "capacity_headroom",
          value: "72 covers, midweek service under half full",
          sourceField: "seatsOrCapacity",
        },
      ],
    },
    triage: {
      score: 76,
      confidence: 0.84,
      reason:
        "Long-standing partner, large room, seven months without an offer. Straightforward midweek reactivation.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1198, 166, 940),
    },
    draft: {
      subject: "Seven months since Saffron & Sea last ran an offer",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2318, 410, 1760),
      ageMinutes: 1284,
      parts: [
        "Hi there,\n\n",
        c("Saffron & Sea", "name", "Saffron & Sea"),
        " has been trading for ",
        c("eleven years", "yearsInBusiness", "11"),
        " and carries ",
        c("967 reviews", "reviewCount", "967"),
        " at ",
        c("a 4.5 rating", "rating", "4.5"),
        ". Your last offer ended on ",
        c("9 January", "lastOfferEndedAt", "2026-01-09T00:00:00.000Z"),
        ".\n\n",
        c("72 covers", "seatsOrCapacity", "72"),
        " is a lot of room to fill on a Wednesday. An offer scoped to midweek service reaches the ",
        c("Brighton", "city", "Brighton"),
        " visitors who are already searching, without discounting the nights that sell themselves.\n\nIs midweek the right place to start?",
        SIGN_OFF,
      ],
    },
    gates: { durationMs: 43 },
    attempt: {
      state: "SENT",
      approvedBy: "m.okafor@example.invalid",
      approvedAfterMinutes: 168,
      sentAfterMinutes: 171,
      providerMessageId: "msg_01HQ7YB4KM2XVFR9TD3PN6WZ",
    },
  }),

  // ── 8. Blocked: a number the record does not contain ───────────
  buildRecord({
    slug: "verdant_float",
    merchant: {
      name: "Verdant Float Spa",
      category: "spa_wellness",
      city: "Cardiff",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://verdantfloat.example.invalid",
      contactEmail: "hello@verdantfloat.example.invalid",
      rating: 4.3,
      reviewCount: 92,
      yearsInBusiness: 2,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-07-11T00:00:00.000Z",
      seatsOrCapacity: 6,
      signals: [
        {
          key: "new_to_market",
          value: "Trading 2 years, 92 reviews so far",
          sourceField: "yearsInBusiness",
        },
      ],
    },
    triage: {
      score: 61,
      confidence: 0.74,
      reason:
        "Young business with thin review volume, but a recent offer that ended and only six tanks to fill. Marginal pursue.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1168, 148, 940),
    },
    draft: {
      subject: "Keeping Verdant Float Spa's tanks busy midweek",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2252, 416, 1760),
      ageMinutes: 121,
      parts: [
        "Hi there,\n\n",
        c("Verdant Float Spa", "name", "Verdant Float Spa"),
        " came off the marketplace on ",
        c("11 July", "lastOfferEndedAt", "2026-07-11T00:00:00.000Z"),
        ", with ",
        c("a 4.3 rating", "rating", "4.3"),
        " from ",
        c("92 reviews", "reviewCount", "92"),
        " behind you.\n\nPartners who run a midweek float offer lift their weekday bookings by 38% within the first month.\n\nWith only ",
        c("6 tanks", "seatsOrCapacity", "6"),
        ", a capped weekday offer is the low-risk version — you control the volume, and the ",
        c("Cardiff", "city", "Cardiff"),
        " weekend rate stays where it is.\n\nWorth a short call?",
        SIGN_OFF,
      ],
    },
    gates: {
      durationMs: 52,
      failures: {
        G06_no_invented_numbers: (body) => ({
          detail:
            'The figure "38%" appears in no source field and in no approved claim library. Performance figures may not be generated.',
          spans: [spanOf(body, "lift their weekday bookings by 38% within the first month")],
        }),
      },
    },
    attempt: { state: "BLOCKED" },
  }),

  // ── 9. Gates all passed, human said no anyway ──────────────────
  buildRecord({
    slug: "rowan_yoga",
    merchant: {
      name: "Rowan Yoga Rooms",
      category: "fitness",
      city: "Bath",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://rowanyoga.example.invalid",
      contactEmail: "studio@rowanyoga.example.invalid",
      rating: 4.8,
      reviewCount: 214,
      yearsInBusiness: 7,
      hasActiveOffer: true,
      lastOfferEndedAt: null,
      seatsOrCapacity: 20,
      signals: [
        {
          key: "high_rating_low_volume",
          value: "4.8 rating across 214 reviews",
          sourceField: "rating",
        },
      ],
    },
    triage: {
      score: 58,
      confidence: 0.69,
      reason:
        "Strong studio, but an offer is already live. Triage flagged it as a possible duplicate approach rather than a reactivation.",
      recommendedAction: "needs_human",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1155, 144, 940),
    },
    draft: {
      subject: "Adding a second slot at Rowan Yoga Rooms",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2230, 358, 1760),
      ageMinutes: 986,
      parts: [
        "Hi there,\n\n",
        c("Rowan Yoga Rooms", "name", "Rowan Yoga Rooms"),
        " has held ",
        c("a 4.8 rating", "rating", "4.8"),
        " over ",
        c("214 reviews", "reviewCount", "214"),
        " and ",
        c("seven years", "yearsInBusiness", "7"),
        " in ",
        c("Bath", "city", "Bath"),
        ".\n\nYour current offer is performing. With ",
        c("20 mats", "seatsOrCapacity", "20"),
        " per class, adding a second weekday slot alongside it is usually the next step rather than replacing what is already live.\n\nShall we look at which class to add?",
        SIGN_OFF,
      ],
    },
    gates: { durationMs: 35 },
    attempt: {
      state: "REJECTED",
      approvedBy: "m.okafor@example.invalid",
      approvedAfterMinutes: 640,
    },
  }),

  // ── 10. Warning only: over length, still approvable ────────────
  buildRecord({
    slug: "atelier_brow",
    merchant: {
      name: "Atelier Brow Bar",
      category: "beauty",
      city: "Cork",
      countryCode: "IE",
      locale: "en-IE",
      websiteUrl: null,
      contactEmail: "hello@atelierbrow.example.invalid",
      rating: 4.6,
      reviewCount: 118,
      yearsInBusiness: 3,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-05-02T00:00:00.000Z",
      seatsOrCapacity: 5,
      signals: [
        {
          key: "deal_gap",
          value: "No live offer for 102 days",
          sourceField: "lastOfferEndedAt",
        },
      ],
    },
    triage: {
      score: 72,
      confidence: 0.81,
      reason:
        "Solid rating, three months without an offer, very small capacity. Fits a capped weekday deal.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1172, 156, 940),
    },
    draft: {
      subject: "A weekday cap for Atelier Brow Bar",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2266, 452, 1760),
      ageMinutes: 74,
      parts: [
        "Hi there,\n\n",
        c("Atelier Brow Bar", "name", "Atelier Brow Bar"),
        " has been off the marketplace since ",
        c("2 May", "lastOfferEndedAt", "2026-05-02T00:00:00.000Z"),
        ", holding ",
        c("a 4.6 rating", "rating", "4.6"),
        " across ",
        c("118 reviews", "reviewCount", "118"),
        " built up over ",
        c("three years", "yearsInBusiness", "3"),
        ".\n\nWith ",
        c("5 chairs", "seatsOrCapacity", "5"),
        ", the risk in any offer is filling the diary with discounted work you would have sold anyway. The way partners your size avoid that is a hard cap plus weekday-only availability, which puts the offer in front of new clients while your regulars keep booking at the usual rate. It also gives you a clean number at the end of the month: everyone who redeemed is someone who had not booked with you before, so the return is measurable rather than assumed, and you can decide whether to run it again on evidence rather than instinct.\n\nWould a capped weekday trial in ",
        c("Cork", "city", "Cork"),
        " be worth a look?",
        SIGN_OFF,
      ],
    },
    gates: {
      durationMs: 46,
      failures: {
        G02_length: (body) => ({
          detail: `Body is ${body.length} characters; the limit for en-IE is 900.`,
        }),
      },
    },
    attempt: { state: "BLOCKED" },
  }),

  // ── 11. Escalated all the way to Opus ──────────────────────────
  buildRecord({
    slug: "peak_line_climbing",
    merchant: {
      name: "Peak Line Climbing",
      category: "activity",
      city: "Sheffield",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://peaklineclimbing.example.invalid",
      contactEmail: "info@peaklineclimbing.example.invalid",
      rating: 4.2,
      reviewCount: 1043,
      yearsInBusiness: 14,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-06-30T00:00:00.000Z",
      seatsOrCapacity: 120,
      signals: [
        {
          key: "capacity_headroom",
          value: "120 places, weekday daytime largely empty",
          sourceField: "seatsOrCapacity",
        },
        {
          key: "deal_gap",
          value: "No live offer for 43 days",
          sourceField: "lastOfferEndedAt",
        },
      ],
    },
    triage: {
      score: 69,
      confidence: 0.77,
      reason:
        "Haiku and Sonnet disagreed: high review count against a below-median rating. Opus resolved it — the rating reflects volume, not quality decline.",
      recommendedAction: "pursue",
      model: "claude-opus-5",
      escalated: true,
      usage: usage("claude-opus-5", 2140, 318, 1420),
    },
    draft: {
      subject: "Weekday daytime at Peak Line Climbing",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2304, 394, 1760),
      ageMinutes: 57,
      parts: [
        "Hi there,\n\n",
        c("1043 reviews", "reviewCount", "1043"),
        " over ",
        c("fourteen years", "yearsInBusiness", "14"),
        " puts ",
        c("Peak Line Climbing", "name", "Peak Line Climbing"),
        " among the most reviewed centres we work with in ",
        c("Sheffield", "city", "Sheffield"),
        ".\n\nYour last offer ended ",
        c("30 June", "lastOfferEndedAt", "2026-06-30T00:00:00.000Z"),
        ". A centre with ",
        c("120 places", "seatsOrCapacity", "120"),
        " has more to gain from filling weekday daytime than from another weekend push — the marginal cost of a daytime session is close to zero.\n\nCan we scope a daytime-only offer together?",
        SIGN_OFF,
      ],
    },
    gates: { durationMs: 40 },
    attempt: { state: "PENDING_APPROVAL" },
  }),

  // ── 12. Blocked: an unrendered template placeholder ────────────
  buildRecord({
    slug: "clay_kiln",
    merchant: {
      name: "Clay & Kiln Studio",
      category: "class_workshop",
      city: "Nottingham",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://clayandkiln.example.invalid",
      contactEmail: "studio@clayandkiln.example.invalid",
      rating: 4.7,
      reviewCount: 96,
      yearsInBusiness: 4,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-04-25T00:00:00.000Z",
      seatsOrCapacity: 10,
      signals: [
        {
          key: "deal_gap",
          value: "No live offer for 109 days",
          sourceField: "lastOfferEndedAt",
        },
      ],
    },
    triage: {
      score: 74,
      confidence: 0.82,
      reason:
        "Good rating, small class sizes, no live offer since April. Workshop category converts on gifting.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1182, 154, 940),
    },
    draft: {
      subject: "Autumn wheel classes at Clay & Kiln Studio",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2244, 366, 1760),
      ageMinutes: 63,
      parts: [
        "Hi {{first_name}},\n\n",
        c("Clay & Kiln Studio", "name", "Clay & Kiln Studio"),
        " has ",
        c("a 4.7 rating", "rating", "4.7"),
        " from ",
        c("96 reviews", "reviewCount", "96"),
        " and has had nothing live since ",
        c("25 April", "lastOfferEndedAt", "2026-04-25T00:00:00.000Z"),
        ".\n\nWith ",
        c("10 wheels", "seatsOrCapacity", "10"),
        ", a single autumn class per week reaches new ",
        c("Nottingham", "city", "Nottingham"),
        " bookers without crowding the studio.\n\nShall we pick a slot?",
        SIGN_OFF,
      ],
    },
    gates: {
      durationMs: 29,
      failures: {
        G03_placeholders: (body) => ({
          detail:
            "Unrendered template placeholder {{first_name}} left in the body. The merchant record has no contact first name to fill it with.",
          spans: [spanOf(body, "{{first_name}}")],
        }),
      },
    },
    attempt: { state: "BLOCKED" },
  }),

  // ── 13. Caught mid-evaluation: four gates still pending ────────
  buildRecord({
    slug: "harbourside_grill",
    merchant: {
      name: "Harbourside Grill",
      category: "restaurant",
      city: "Plymouth",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://harboursidegrill.example.invalid",
      contactEmail: "bookings@harboursidegrill.example.invalid",
      rating: 4.1,
      reviewCount: 428,
      yearsInBusiness: 8,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-07-30T00:00:00.000Z",
      seatsOrCapacity: 64,
      signals: [
        {
          key: "capacity_headroom",
          value: "64 covers, weekday lunch under-used",
          sourceField: "seatsOrCapacity",
        },
      ],
    },
    triage: {
      score: 63,
      confidence: 0.76,
      reason:
        "Recent offer only just ended and the rating sits below the category median. Pursue on capacity rather than on strength.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1164, 150, 940),
    },
    draft: {
      subject: "Weekday lunch at Harbourside Grill",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2258, 380, 1760),
      ageMinutes: 3,
      parts: [
        "Hi there,\n\n",
        c("Harbourside Grill", "name", "Harbourside Grill"),
        " came off the marketplace on ",
        c("30 July", "lastOfferEndedAt", "2026-07-30T00:00:00.000Z"),
        " with ",
        c("428 reviews", "reviewCount", "428"),
        " behind it.\n\n",
        c("64 covers", "seatsOrCapacity", "64"),
        " and a quiet weekday lunch is the clearest opening — ",
        c("Plymouth", "city", "Plymouth"),
        " partners who scope an offer to lunch alone keep their evening rate untouched.\n\nWould lunch be the right place to start?",
        SIGN_OFF,
      ],
    },
    gates: {
      durationMs: 18,
      // Evaluation is still running. These four have not been reached yet,
      // which is what the empty segments on the strip mean.
      pending: ["G09_locale", "G10_single_cta", "G11_frequency_cap", "G12_compliance"],
    },
    attempt: { state: "GATED" },
  }),

  // ── 14. Blocked: personal data in the body ─────────────────────
  buildRecord({
    slug: "stillpoint_massage",
    merchant: {
      name: "Stillpoint Massage",
      category: "spa_wellness",
      city: "Norwich",
      countryCode: "GB",
      locale: "en-GB",
      websiteUrl: "https://stillpointmassage.example.invalid",
      contactEmail: "hello@stillpointmassage.example.invalid",
      rating: 4.9,
      reviewCount: 76,
      yearsInBusiness: 3,
      hasActiveOffer: false,
      lastOfferEndedAt: "2026-06-05T00:00:00.000Z",
      seatsOrCapacity: 4,
      signals: [
        {
          key: "high_rating_low_volume",
          value: "4.9 rating on only 76 reviews",
          sourceField: "reviewCount",
        },
      ],
    },
    triage: {
      score: 77,
      confidence: 0.85,
      reason:
        "Excellent rating on a small review base, two months without an offer. Four rooms means a strict cap is essential.",
      recommendedAction: "pursue",
      model: "claude-haiku-4-5-20251001",
      escalated: false,
      usage: usage("claude-haiku-4-5-20251001", 1176, 162, 940),
    },
    draft: {
      subject: "A capped weekday offer for Stillpoint Massage",
      model: "claude-sonnet-5",
      usage: usage("claude-sonnet-5", 2276, 404, 1760),
      ageMinutes: 39,
      parts: [
        "Hi there,\n\n",
        c("Stillpoint Massage", "name", "Stillpoint Massage"),
        " holds ",
        c("a 4.9 rating", "rating", "4.9"),
        " from ",
        c("76 reviews", "reviewCount", "76"),
        ", and nothing has been live since ",
        c("5 June", "lastOfferEndedAt", "2026-06-05T00:00:00.000Z"),
        ".\n\nWith ",
        c("4 rooms", "seatsOrCapacity", "4"),
        ", a capped weekday offer keeps control of the volume. I can talk it through whenever suits — my direct line is 07700 900412, or reply here.\n\nWould this week work for a short call about ",
        c("Norwich", "city", "Norwich"),
        " demand?",
        SIGN_OFF,
      ],
    },
    gates: {
      durationMs: 33,
      failures: {
        G08_pii: (body) => ({
          detail:
            "A personal telephone number appears in the body. Outreach may carry only the shared partnerships mailbox.",
          spans: [spanOf(body, "my direct line is 07700 900412")],
        }),
      },
    },
    attempt: { state: "BLOCKED" },
  }),
];
