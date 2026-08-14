import { describe, expect, it } from "vitest";

import { g07BannedClaims, g10SingleCta, g12Compliance } from "./index.js";
import {
  bodyWith,
  highlighted,
  sampleContext,
  sampleDraft,
  sampleMerchant,
} from "./test-helpers.js";

const merchant = sampleMerchant();
const context = sampleContext();

describe("G07 banned claims", () => {
  it("passes a draft that describes reach rather than outcomes", () => {
    expect(g07BannedClaims(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails a performance guarantee and points at it", () => {
    const body = bodyWith([
      ["a weekday offer is usually", "this is guaranteed to double your bookings and is usually"],
    ]);
    const outcome = g07BannedClaims(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toContain("guaranteed");
  });

  it("does not read a sign-off as a superlative", () => {
    // "Best regards" ends most of these emails. A gate that fails every polite
    // draft is a gate somebody switches off.
    expect(sampleDraft().body).toContain("Best regards");
    expect(g07BannedClaims(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("does not read a bare 'Best,' sign-off as a superlative", () => {
    // How most of these drafts actually close. Two of ten recorded drafts were
    // blocked for their signature before this case was handled.
    const body = sampleDraft().body.replace("Best regards,", "Best,");
    expect(body).toContain("\nBest,\n");

    expect(g07BannedClaims(sampleDraft({ body }), merchant, context).passed).toBe(true);
  });

  it("still fails 'best' used as a claim, including at the start of a line", () => {
    // The sign-off exception is about position, not the word: nothing but an
    // optional comma may follow it on the line.
    const claimInSentence = sampleDraft().body.replace(
      "a weekday offer is usually",
      "this brings the best new bookings and a weekday offer is usually",
    );
    const claimOnItsOwnLine = sampleDraft().body.replace(
      "Best regards,",
      "Best prices in Leeds.\n\nBest regards,",
    );

    expect(g07BannedClaims(sampleDraft({ body: claimInSentence }), merchant, context).passed)
      .toBe(false);
    expect(g07BannedClaims(sampleDraft({ body: claimOnItsOwnLine }), merchant, context).passed)
      .toBe(false);
  });
});

describe("G10 single call to action", () => {
  it("passes a draft that asks for exactly one thing", () => {
    const outcome = g10SingleCta(sampleDraft(), merchant, context);

    expect(outcome.passed).toBe(true);
    // A warning, not a blocker: a second ask is a quality defect, not a lie.
    expect(outcome.severity).toBe("warning");
  });

  it("fails a draft that asks for two different things", () => {
    const body = bodyWith([
      [
        "you can register your interest using the link below",
        "reply to this email or book a call using the link below",
      ],
    ]);
    const outcome = g10SingleCta(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("2 different calls to action");
  });

  it("fails a draft that asks for nothing", () => {
    const body = bodyWith([
      [
        "If that shape of offer is useful, you can register your interest using the link below and someone from the team will follow up with the detail.",
        "That is the shape most partners of this size settle on in the end.",
      ],
    ]);
    const outcome = g10SingleCta(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("asks the reader to do nothing");
  });
});

describe("G10 in the campaign's other languages", () => {
  // The closing sentence of the recorded cs, de and es drafts, plus a Dutch
  // one in the same shape. Each makes exactly one ask. Before the patterns
  // covered these languages the gate reported "asks the reader to do nothing"
  // for all of them — a check that is silently inert everywhere but English.
  const oneAsk: Record<string, string> = {
    cs: "Pokud by vás taková spolupráce zajímala, zaregistrujte prosím svůj zájem zde: https://partners.example.invalid/register.",
    de: "Wenn Sie Interesse haben, mehr über diese Reichweite zu erfahren, registrieren Sie sich unter diesem Link, und unser Team meldet sich bei Ihnen.",
    es: "Si le interesa explorar esta opción, puede registrar su interés aquí y alguien de nuestro equipo se pondrá en contacto.",
    nl: "Als dit interessant klinkt, meld u aan via onderstaande link en iemand van ons team neemt contact op.",
  };

  for (const [language, sentence] of Object.entries(oneAsk)) {
    it(`sees the one call to action in ${language}`, () => {
      const outcome = g10SingleCta(sampleDraft({ body: sentence }), merchant, context);

      expect(outcome.passed).toBe(true);
    });
  }

  it("counts two different asks in a non-English body", () => {
    const body =
      "Registrieren Sie sich unter diesem Link. " +
      "Antworten Sie mir auch direkt auf diese E-Mail.";
    const outcome = g10SingleCta(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("2 different calls to action");
  });

  it("sees the ask however the closing is worded", () => {
    // Taken from recorded drafts. Matching whole closings rather than the verb
    // missed all three, and two of them are English — the gate reported that a
    // draft ending "you can register your details here" asked for nothing.
    const closings = [
      "If that's of interest, you can register your details here: https://partners.example.invalid/register",
      "If that's of interest, you can register to hear more here: https://partners.example.invalid/register",
      "Wenn Sie mehr erfahren möchten, können Sie hier Interesse hinterlegen, und jemand meldet sich bei Ihnen.",
    ];

    for (const body of closings) {
      const outcome = g10SingleCta(sampleDraft({ body }), merchant, context);

      expect(outcome.passed, body).toBe(true);
    }
  });

  it("matches a phrase that ends in an accented letter", () => {
    // "aquí" is the reason these patterns cannot use \b: `\w` is ASCII, so
    // there is no word boundary after "í" to assert and /\baquí\b/ never
    // matches. A regression here would look like a gate with nothing to say.
    const outcome = g10SingleCta(
      sampleDraft({ body: "Para verlo usted mismo, haga clic aquí y lo verá." }),
      merchant,
      context,
    );

    expect(outcome.passed).toBe(true);
  });
});

describe("G12 compliance", () => {
  it("passes a draft written as professional correspondence", () => {
    expect(g12Compliance(sampleDraft(), merchant, context).passed).toBe(true);
  });

  it("fails urgency and scarcity language", () => {
    const body = bodyWith([["a weekday offer", "act now, only 3 slots left, and a weekday offer"]]);
    const outcome = g12Compliance(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(highlighted(body, outcome.spans)).toContain("act now");
  });

  it("fails a body that shouts", () => {
    const body = bodyWith([["a strong signal", "a REALLY STRONG BUYING signal!!"]]);
    const outcome = g12Compliance(sampleDraft({ body }), merchant, context);

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("capitals");
  });

  it("fails a body that shouts in a language with accents", () => {
    const outcome = g12Compliance(
      sampleDraft({ body: "Máme pro vás ÚŽASNOU NABÍDKU DNES, podívejte se." }),
      merchant,
      context,
    );

    expect(outcome.passed).toBe(false);
    expect(outcome.detail).toContain("capitals");
  });

  it("blocks bulk-mail vocabulary in the other languages too", () => {
    // The English list blocks "no obligation". Leaving the direct equivalents
    // out meant the same sentence passed in German and failed in English.
    const equivalents = [
      "Registrieren Sie sich unverbindlich unter diesem Link.",
      "Zaregistrujte se nezávazně přes tento odkaz.",
      "Puede registrar su interés sin compromiso.",
      "U kunt zich vrijblijvend aanmelden via deze link.",
    ];

    for (const body of equivalents) {
      const outcome = g12Compliance(sampleDraft({ body }), merchant, context);

      expect(outcome.passed, body).toBe(false);
      expect(outcome.detail).toContain("bulk mail");
    }
  });

  it("passes an ordinary non-English body", () => {
    // The lists are vocabulary, not a language check: a clean Czech draft has
    // to come through as cleanly as a clean English one.
    const outcome = g12Compliance(
      sampleDraft({
        body:
          "Dobrý den, všiml jsem si, že Ateliér Kruh má hodnocení 4.6 z 41 recenzí. " +
          "Pokud by vás spolupráce zajímala, zaregistrujte prosím svůj zájem zde.",
      }),
      merchant,
      context,
    );

    expect(outcome.passed).toBe(true);
  });
});
