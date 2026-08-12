# Dashboard — operator console

The screen a person sits in front of to decide whether a generated message goes
out. Four views: the approval queue, a draft in detail, campaign metrics, and
the last eval run against its baseline.

It is a **separate npm project** from the backend, because it is deployed
separately. The repository root builds an Encore container; this directory
builds a Next.js application, and neither is aware of the other's toolchain.
The root `tsconfig.json` excludes `dashboard/` and the root ESLint config
ignores it.

## Running it

```bash
cd dashboard
npm install
npm run dev            # http://localhost:3000
```

Validation — the equivalent of the root `npm run verify`, for this project:

```bash
npm run verify         # typecheck && lint && build
```

## Where the data comes from

Everything on screen is built in `lib/mock/`. There is no backend call yet, and
no `fetch` anywhere in the application.

The mock is not loose, though. It is typed against `shared/contracts.ts` — the
frozen contract at the repository root — through `lib/contracts.ts`, which
re-exports those types with `import type` only. The reference is erased at
compile time, so nothing outside `dashboard/` is bundled, but a change to the
contract still turns into a compile error here rather than a screen that
quietly renders the wrong shape.

Two things are enforced while the fixtures are built rather than checked by eye:

- **A claim is always an exact substring of the body.** `composeBody` assembles
  the prose and its `EvidenceRef[]` from one list of parts, so the rule gate G05
  enforces holds by construction.
- **A claim's text never appears anywhere it was not registered.** The backend
  sends claims as strings, not offsets, so the interface locates them by
  searching. An unregistered duplicate would highlight the wrong words, and
  `composeBody` throws instead.

`lib/mock/evals.ts` defines its own types. The eval harness is WS6 and does not
exist yet; inventing a contract for it would have meant editing a frozen file.

## The gate strip

`components/GateStrip.tsx` is one component rendered in three places, at three
sizes:

| Size      | Where                | What it adds                             |
|-----------|----------------------|------------------------------------------|
| `compact` | a queue row          | nothing — a picture, read peripherally    |
| `full`    | the draft detail     | gate codes, hover, a caption with a pointer |
| `cell`    | one row of the heatmap | per-gate intensity for the batch pass rate |

The compact and cell sizes are `role="img"` with a one-sentence label rather
than twelve buttons, because twelve buttons in each of forty queue rows would
be 480 tab stops.

## Evidence highlighting

On the draft detail, pointing at a claim lights the field it came from;
pointing at a field lights every claim that leans on it; pointing at a gate
segment lights the text that broke it. One `Focus` value drives all three, and
`resolveFocus` turns it into the three highlight sets.

Overlapping marks are handled by cutting the body at every mark boundary into
atomic segments (`lib/spans.ts`) rather than by nesting elements, which would
produce invalid markup as soon as a gate span crossed a claim boundary.

## Design

Follows `_docs/repo-b-merchant-outreach/DESIGN.md`. The palette in
`app/globals.css` is copied from it verbatim and is not a starting point:
colour here carries meaning — green passed, red blocks, amber warns, blue means
escalated to a stronger model — and `--action` is spent only on the primary
button and the focus ring.

Verified against that document's quality bar:

- Responsive to 375px; the queue becomes cards, no horizontal overflow
- Focus ring 2px in `--action` on every control, including the gate segments
- `prefers-reduced-motion` collapses the one animation to nothing
- Tightest text contrast in the interface is 5.16:1 (`--ink-mute` on `--paper`)
- One animation only: the gate strip filling, 40 ms per segment
