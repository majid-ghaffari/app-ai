# Image-Selection Prompt — Maintenance Doc

The design/maintenance record for the `image-selection` prompt. The runtime files it documents live at [`src/prompts/image-selection/prompt.md`](../../src/prompts/image-selection/prompt.md) (system prompt) and [`src/prompts/image-selection/sample.md`](../../src/prompts/image-selection/sample.md) (training-examples attachment), registered as `image-selection` in [`src/prompts.ts`](../../src/prompts.ts). The authoring/iteration process — artifact conventions, length enforcement, how this doc is kept — is defined in [docs/PROMPT-AUTHORING.md](PROMPT-AUTHORING.md).

## Project Overview

An AI-powered element analyzer for LimeSpot's Agentic Designer. Analyzes screenshots + HTML to generate CSS selectors for image personalization in e-commerce (Shopify/BigCommerce).

**Goal:** Generate robust CSS selectors that survive theme updates, carousel navigation, and lazy loading.

**CRITICAL:** This is a **production system** deployed at scale — the LIVE smart-image feature calls it through the worker's `POST /messages` endpoint. Every API call costs money. Token efficiency matters while maintaining 95%+ accuracy.

## Current Artifacts

### prompt.md

- **Purpose:** System prompt for Claude API calls (production)
- **Size:** 4,651 characters / 74 lines (design HARD LIMIT: 4,500 characters, target <4,400 — currently 151 over; needs a trim pass)
- **Token cost:** ~1,150 tokens per API call (estimated at ~4 chars/token)
- **Content:** Selector rules, campaign-name generation, JSON output schema

### sample.md

- **Purpose:** Training examples showing correct selector generation
- **Size:** 25,680 characters / 649 lines (~6.5K tokens estimated)
- **Structure:** 5 examples with campaign names in all outputs — Collection Grid, Background Images, Carousel WITH/WITHOUT data-slide-index, Container IS Link
- **Wiring:** NOT part of the system prompt — an `attachments` entry in the registry, uploaded via the Files API (SHA-256 dedup) and prepended to the first message as a document block

### API-call cost

- Uncached: roughly ~7.5K tokens per request (prompt + sample, estimated)
- The sample.md attachment blocks carry an extended 1h prompt-cache breakpoint and the upload is content-hash deduplicated, so repeat calls read the sample from cache at 0.1× — the recurring cost is dominated by the per-request HTML/screenshot payload, not the prompt files
- See the Token-saving levers section in the root [CLAUDE.md](../../CLAUDE.md) for the caching/dedup mechanics

## Constraints & Requirements

### CRITICAL: Production Cost Constraints

1. **prompt.md HARD LIMIT:** 4,500 characters (spaces included) — a design budget, not code-enforced; measured size is checked with `wc -c` (see [PROMPT-AUTHORING.md](PROMPT-AUTHORING.md))
2. **Token sensitivity:** Every token costs $$ at scale
3. **Quality cannot be sacrificed:** 95%+ accuracy required for production
4. **Balance:** Maximum quality at minimum token count
5. **No redundancy:** Every word must add value

### File Size Targets

- **prompt.md:** <4,500 chars (hard limit) — currently 4,651, over budget; trim on next edit
- **sample.md:** Keep concise but complete — ~650 lines acceptable but monitor growth

### Quality Metrics

- Selector accuracy: 95%+ correct on first try (MUST maintain)
- Selector stability: 90%+ survive theme updates
- False positive rate: <5% (detecting product images as content)
- Token efficiency: Minimize while maintaining all quality metrics

## Key Selector Generation Rules

### What to Use

1. ✅ Base semantic classes: `CollectionItem`, `Grid`, `Card`, `Slideshow__Slide`
2. ✅ Position attributes: `[data-slide-index="N"]` for carousels
3. ✅ nth-child fallback: `:nth-child(N)` when no position attributes exist
4. ✅ Wrapper prefix: Always start with wrapperSelector
5. ✅ BEM base classes: `Block__Element` (without modifiers)
6. ✅ Minimal specificity: Use simplest selector (e.g., `a` not `a[href="..."]` when only one exists)
7. ✅ Self-reference `::`: When container IS the target element (e.g., container is `<a>` → `"destinationUrlSelector": "::"`)

### What to AVOID

**State Classes:**

- active, visible, open, closed, is-selected, hidden
- loading, loaded, lazyloaded, lazyautosizes, ls-is-cached, Image--lazyLoaded
- slick-current, slick-active, flickity-enabled, is-selected (carousels)
- focus, focused, hover, hovered, current, selected, checked
- transitioning, animated, animating, collapsed, expanded
- disabled, enabled, valid, invalid, error

**BEM Modifiers (--prefix):**

- `--expand`, `--collapse`, `--large`, `--small`, `--active`
- Any class with `--` indicating state/variant

**Utility Classes:**

- Spacing: `margin-bottom-md`, `padding-top-lg`, `mt-4`, `p-2`
- Positioning: `Carousel__Cell`, `Grid__Cell`, `Slideshow__Cell`

**Random Suffix Patterns:**

- Element IDs: `#Slideimage_wKgd6H`, `#hero-slide-abc456`
- Classes: `.Item_abc123`, `.Card-xyz789`
- Pattern: Underscores/hyphens followed by random alphanumeric
- **Exception:** Wrapper selectors like `#shopify-section-{uuid}` and `[data-widget-id="{uuid}"]` are valid

**Responsive Utilities:**

- `hidden-phone`, `hidden-tablet-and-up`, `visible-md`
- Only use if absolutely no alternative

### Carousel Slide Selection Priority

**Decision Tree:**

```
IF data-slide-index attribute exists:
  ✅ Use [data-slide-index="N"]
ELSE:
  ✅ Fallback to :nth-child(N) with warning about DOM order dependency

NEVER use:
  ❌ is-selected, slick-active, active (state classes that rotate)
  ❌ #Slide_abc123 (random suffix IDs)
```

## Technical Behaviors

### Campaign Name Generation

- Pattern: "{PageType} {ElementType}" in Title Case
- Examples: "Homepage Hero Banner", "Product Page CTA Block", "Collection Page Featured Image"
- Element types: Hero Banner, CTA Block, Featured Image, Promo Banner, Content Block, Slideshow
- Keep concise: 2-4 words
- Always start with page type when available from `pageType` input parameter

### extraImageSourceAttributes

- Applied to target element **AND all descendants** (runtime traverses tree)
- Preserve `data-sizes="auto"` pattern (don't extract "auto" as value)
- Common: `data-srcset`, `data-src`, `data-bgset`, `data-sizes`

### Background Image Detection

When element has `style="background-image:..."` or `data-bgset`:

1. Return parent div selector (not child img/picture)
2. Runtime applies to: CSS background-image + searches container for `picture source` + updates child img
3. One selector handles all image sources

### Special Selectors

- **`::`** = Container itself IS the target element (applies to any selector, not just images)
  - Container is `<a>` → `"destinationUrlSelector": "::"`
  - Container is `<img>` → `"imageLargeSelector": "::"`
  - Container is `<button>` → `"ctaSelector": "::"`
- **Same selector for all sizes** = Enables combined srcset with breakpoints

### Source Cascade

- Targeting `<source>` auto-updates sibling `<img>` in same `<picture>`
- No need for separate selectors

## Issues Found & Fixed

### Issue 1: CollectionItem--expand in Training Example

**Problem:** sample.md used `CollectionItem--expand` as a good example
**Why Wrong:** `--expand` is a BEM modifier indicating expanded/collapsed state
**Fix:** Changed to `.CollectionItem:nth-child(1)` (base class only)
**Date:** 2025-01-24

### Issue 2: Missing BEM Modifier Rules

**Problem:** prompt.md didn't explicitly mention avoiding `--*` modifiers
**Fix:** Added "Avoid BEM modifiers" rule with examples
**Date:** 2025-01-24

### Issue 3: Utility Classes Not Called Out

**Problem:** `Carousel__Cell`, `margin-bottom-md` weren't in avoid list
**Fix:** Added utility class avoidance with spacing and positioning examples
**Date:** 2025-01-24

### Issue 4: Carousel State Classes (is-selected)

**Problem:** Real-world Flickity carousel returned `.Slideshow__Slide.is-selected` selector
**Why Wrong:** `is-selected` is a carousel state class that rotates between slides as user navigates
**Fix:** Added carousel-specific rules prioritizing `[data-slide-index="N"]` over state classes
**Date:** 2025-01-24

### Issue 5: Random Suffix Element IDs

**Problem:** Carousel slides have dynamic IDs like `#Slideimage_wKgd6H`
**Why Wrong:** These are dynamically generated and change on theme updates
**Fix:** Added rule to avoid random suffix patterns in element IDs/classes (exception: wrapper selectors)
**Date:** 2025-01-24

### Issue 6: prompt.md Over Character Limit

**Problem:** Adding carousel rules pushed prompt.md to 5,148 chars (648 over 4,500 limit)
**Why Critical:** Production system has hard character limit for API calls
**Fix:** Aggressive optimization: condensed JSON examples, shortened avoid lists, tightened wording. Reduced to 3,620 chars (30% reduction) while preserving all rules
**Date:** 2025-01-24

### Issue 7: Child Selectors Repeating Container Path

**Problem:** Claude returned `.Slideshow__Slide[data-slide-index="1"] a` instead of just `a`
**Why Wrong:** Runtime uses `containerElement.querySelector(childSelector)`, so container path is redundant and breaks the query
**Fix:** Strengthened rule #4 with explicit examples showing correct vs wrong patterns
**Date:** 2025-01-24

### Issue 8: Over-Specific Child Selectors

**Problem:** Claude returned `a[href="/collections/sparkle-knits"]` when only one `a` exists in container. Initially thought it was checking uniqueness within wrapper (multiple slides = multiple `a` tags), not within each container.
**Why Wrong:** href is content-specific and brittle, changes per slide/item. Minimal specificity principle violated. Root cause: checking uniqueness in wrong scope.
**Fix:**

- Made step 5 standalone: "MINIMIZE SPECIFICITY"
- Explicit: "Check uniqueness WITHIN the container (not wrapper)"
- Added minimal specificity examples to all 4 examples in sample.md
- Added "Common Mistakes" section showing wrong vs right approaches
  **Date:** 2025-01-24

### Issue 9: Container IS the Target Element

**Problem:** When container is `<a>` tag itself, Claude returned `a[href="..."]` for destinationUrlSelector, which fails because `container.querySelector("a")` looks inside container, but container IS the `<a>`
**Why Wrong:** querySelector cannot find container element from within itself
**Fix:**

- Extended `::` concept to ALL selectors, not just images
- Rule: If container IS the target element, return `"::"` for that selector
- Added Example 5 in sample.md showing CollectionItem where `<a>` is container
- Works for any selector: destinationUrl, cta, heading, image, etc.
  **Date:** 2025-01-24

## Working Example Structure

### Example 1: Collection Grid (sample.md)

**Scenario:** Shopify CollectionItem grid with 2 sections
**Demonstrates:**

- Importance of section ID prefix for global uniqueness
- nth-child for position within wrapper
- Base class usage (avoiding modifiers)
- Picture element with sources
- Child selector scoping (no wrapper path)
- Lazy loading attribute extraction

### Example 2: Background-Image Variant

**Scenario:** CSS background-image with data-bgset
**Shows:** CSS background-image + data-bgset detection and handling

### Example 3: Carousel WITH data-slide-index

**Scenario:** Flickity/Slick carousel with position attributes
**Demonstrates:**

- Using `[data-slide-index="2"]` for stable position
- Avoiding `is-selected` state class
- Avoiding random suffix IDs like `#Slideimage_wKgd6H`
- Semantic, human-readable position reference

### Example 4: Carousel WITHOUT data-slide-index

**Scenario:** Generic hero banner carousel without position attributes
**Demonstrates:**

- Fallback to `:nth-child(2)` when no data attributes
- Warning about DOM order dependency
- Lower confidence score (0.90 vs 0.95)

### Example 5: Container IS the Link Element

**Scenario:** Collection grid where `<a>` tag is the container
**Demonstrates:**

- Using `"::"` for destinationUrlSelector when container is the `<a>` itself
- Background-image detection in nested div
- Why `container.querySelector("a")` would fail in this case
- General rule: `::` applies to ANY selector when container IS that element

## Platform-Specific Patterns

### Shopify

- Wrapper: `#shopify-section-{uuid}`
- Common: `.CollectionItem`, `.Grid`, `.Slideshow__Slide`
- Themes: Dawn, Debut, Prestige
- Carousels: Often use Flickity with `data-slide-index`

### BigCommerce

- Wrapper: `[data-widget-id]` or `section`
- Common: `.card`, `.heroCarousel-slide`, `.slick-slide`, `.productGrid`
- Carousel: Slick slider with state classes (`slick-current`, `slick-active`)

## Next Steps

- Trim prompt.md back under the 4,500-char budget (measured 4,651 — 151 over)
- Gather edge cases from production usage
- Monitor selector accuracy metrics AND token costs
- Track production error rates and selector brittleness
- Continue monitoring prompt.md size as new rules are added

## Version History

- **v1.0** (2025-01-24): Initial implementation
  - Core selector rules: base classes, avoid state/BEM modifiers/utility classes
  - Collection grid example with background-image variant
  - Character limit: 4,500 chars, token optimization focus
- **v1.1** (2025-01-24): Carousel patterns
  - Added carousel slide selection: `[data-slide-index="N"]` priority, `:nth-child(N)` fallback
  - Avoid carousel state classes (is-selected, slick-active) and random suffix IDs
  - Extended sample.md with 4 examples (grid, bg-image, carousel with/without data-slide-index)
  - Optimized prompt.md from 5,148 to 4,004 chars after additions
- **v1.2** (2025-01-24): Child selector scoping and minimal specificity

  - Fixed: Child selectors repeating container path (use `"a"` not `.Slideshow__Slide a`)
  - Fixed: Over-specific selectors (`a[href="..."]` when simple `"a"` sufficient)
  - **Critical rule:** Check uniqueness WITHIN container scope, not wrapper scope
  - Updated all sample.md examples with minimal specificity notes
  - Current: prompt.md 4,141 chars, sample.md ~650 lines

- **v1.3** (2025-01-24): Extended :: self-reference to all selectors

  - Extended `::` concept from images-only to ANY selector
  - Use case: When container IS the target element (e.g., container is `<a>` → `"destinationUrlSelector": "::"`)
  - Added Example 5 in sample.md: CollectionItem where `<a>` is container
  - Current: prompt.md 4,236 chars, sample.md ~700 lines

- **v1.4** (2025-01-24): Campaign name generation

  - Added `suggestedCampaignTitle` to JSON response
  - Pattern: "{PageType} {ElementType}" in Title Case (2-4 words)
  - Examples: "Homepage Hero Banner", "Product Page CTA Block"
  - Added `pageType` to input parameters
  - Updated all 5 examples in sample.md with campaign names
  - Current: prompt.md 4,492 chars, sample.md ~720 lines

- **v1.5** (2026-07-01): Maintenance-doc restructure + fact refresh
  - This doc now lives at `docs/prompts/image-selection.md`; the generic prompt-authoring workflow (artifact rules, length enforcement, brainstorming mode) is factored out to `docs/PROMPT-AUTHORING.md`
  - Runtime layout described per the unified registry convention (`src/prompts/image-selection/` folder + `src/prompts.ts` entry; sample.md wired as a Files-API attachment with dedup + 1h prompt cache)
  - Sizes re-measured: prompt.md 4,651 chars (over the 4,500 budget — trim flagged in Next Steps), sample.md 25,680 chars / 649 lines
