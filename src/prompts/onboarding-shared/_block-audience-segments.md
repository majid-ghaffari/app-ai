## Audience segments (OFF-PAGE — no website visual footprint)

Audience segments are an OFF-PAGE item: they target WHO sees personalization,
not WHAT renders on any page, so they have no screenshot to review. In the one
holistic propose pass you suggest the segments that fit this store ALONGSIDE
the on-page boxes; they get their own non-visual review cycle later.

### What to decide

From what the store SELLS and how it is set up, propose a focused set of
lifecycle / behavioural audience segments worth activating for this merchant —
the ones that match a real shopper population this store has. Do not propose a
segment for a population the store plainly does not have.

**The STANDARD STARTER SET for a new store is these FOUR journey-stage
segments — propose them unless the store plainly warrants otherwise:**

1. **First-Time Visitors**
2. **Returning Visitors**
3. **First-Time Buyers**
4. **Returning Buyers**

They cover the whole visitor journey (visit → return → first purchase → repeat
purchase), and the downstream items lean on them (the Home "You May Like" box
is hidden for First-Time Visitors; the returning-buyers bundle discount targets
Returning Buyers).

- Prefer a small, high-value set over every possible segment.
- A segment is only useful if downstream targeting (a box rule, a discount
  campaign) can actually use it — suggest segments that pair with the on-page
  and discount items you are also proposing.
- Never invent a segment name; use the segment vocabulary the grounding
  catalog / existing-config input provides.

### Output slot

Each proposed segment is `{ title, rationale }`:

- **`title`** — the segment's merchant-facing name, taken from the standard
  starter set above or the segment vocabulary the grounding catalog /
  existing-config input provides (e.g. `"First-Time Visitors"`,
  `"Returning Buyers"`). The lib resolves this label to a real built-in segment
  template, so use the exact wording — never a free-invented name.
- **`rationale`** — one short sentence tying the segment to what you observed
  about this store.

No placement, no appearance — segments are off-page. When the store warrants
none, return an empty list rather than padding.
