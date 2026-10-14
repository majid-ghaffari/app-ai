OFFERS PER AUDIENCE
This step sets its offer per audience, so each audience gets the offer its own data supports. Every option starts from one of LimeSpot's offer templates, and Studio worked out its numbers from the store's own data. Its data carries:
- `audiences`: each with its `audienceKey`, its `title`, the `facts` it is judged by (each a `label` and a `value` with its `unit`, and its `currencyCode` when it is money), whether it is `eligible`, its `ineligibleReason` when it is not, `takenBy` when it already has the other kind of offer (`progress-bar` or `bundles`) and keeps it, and the `options` Studio built for it, each with an `optionKey`, a `label`, the `templateKey` and `templateName` of the template it starts from, and the numbers Studio worked out for it.
- `everyoneElse`: the same for shoppers no listed audience covers, or absent when Studio built nothing for them.
- `current`: the offers of this kind the store runs today, each with its `label` and the `audienceKey` it targets, absent when it targets everyone.
- `discountRate`: the discount rate Studio used for the options that give a discount, with its `percent` and its `source`. `orders` means Studio learned it from the discounts on this store's own discounted orders, and `discountedOrders` says how many it read; `default` means the store had too few discounted orders, so Studio started from LimeSpot's default rate; `owner` means the owner typed this rate in their notes for this step, and Studio used it as they gave it.

Rules:
1. Give an audience an offer only when its facts support one, by naming one of that audience's own `optionKey`s, and give it at most one.
2. An audience that is `eligible: false` or carries `takenBy` gets no offer: one offer per audience across Progress Bar and Bundle Discounts.
3. Every audience in the data appears once, in `offers` or in `leaveOut` with its reason.
4. `everyoneElse` gets an offer only when its `eligible` is true and its facts support one; otherwise it is `null`.
5. An offer replaces the `current` offer that targets the same audience, and `everyoneElse` replaces the one that targets everyone; its reason says so.
6. When an offer you choose gives a discount and `discountRate.source` is `default`, `summary` says you used that rate as a starting rate the owner can change, for example "I used <percent>% as a starting rate, and you can change it." When the source is `orders`, a reason that names the rate says it is the usual discount on the store's own discounted orders. When the source is `owner`, `summary` says you used the rate the owner asked for, for example "I used the <percent>% you asked for.", and never calls it learned from the store's orders or a starting rate.
7. Choose only among the options: never a template, an amount or a rate the data doesn't offer. Name an option's template in words by its `templateName`, never by its key.
8. Each offer's `basedOn` names, in one line, the facts it rests on and the period, for example "Based on <orders> orders from Returning Buyers in the last <days> days".

Output: one JSON object of this shape.

```json
{
  "headline": "Returning Buyers get an offer of their own",
  "summary": "Your returning buyers order more often than your other audiences, so I'd give them an offer sized to their own orders and keep one offer for the rest of your shoppers.",
  "offers": [
    {
      "audienceKey": "returning-buyers",
      "optionKey": "returning-buyers-1",
      "reason": "Their orders come close to what this offer asks for, so it fits how they already buy.",
      "basedOn": "Based on <orders> orders from Returning Buyers in the last <days> days"
    }
  ],
  "everyoneElse": {
    "optionKey": "everyone-else-1",
    "reason": "Shoppers outside your audiences order often enough for an offer sized to their own orders.",
    "basedOn": "Based on <orders> orders from shoppers in no audience in the last <days> days"
  },
  "leaveOut": [
    {
      "audienceKey": "first-time-visitors",
      "reason": "They have placed too few orders for an offer sized to them."
    }
  ],
  "basedOn": "Based on your orders by audience in the last <days> days"
}
```

`offers` and `leaveOut` are always present, empty when nothing belongs in them. `everyoneElse` is an object or `null`. `question` is present only when you ask one.
