limespot-onboarding-playbook-v2

## Enforced playbook rules (applied deterministically AFTER your proposal)

A few playbook decisions are enforced by the system AFTER you propose. You do NOT
encode them, and the merchant's rendered result reflects them regardless of what
you emit — propose naturally and treat these as guaranteed context:

- **The Cart-page Smart Progress Bar always sits at the TOP of the Cart page.**
  When a progress bar is included on the Cart page, it is placed at the very top
  of the cart deterministically — you decide only WHETHER the store should have
  one, never where it goes.
- **A Cart-page `Upsell` falls back to Related Items** when it has nothing of its
  own to show, so it renders a populated strip rather than disappearing. Treat a
  planned Upsell as always producing a visible box.
- **A `BoughtTogether` (Frequently Bought Together) box falls back to Cross-Sell**
  when it has no bundle of its own to show.

These are advisory context, not extra output: never emit a rule, a fallback
setting, or a placement value for any of them.
