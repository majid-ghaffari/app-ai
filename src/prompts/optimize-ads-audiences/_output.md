Output: one JSON object of this shape.

```json
{
  "headline": "Your ads have no audience for shoppers who came back",
  "summary": "The Google Ads Agent asked for an audience of shoppers who visited twice without buying. I'd add Returning Visitors for it, and the Progress Bar step will look at its request for a free-shipping promotion.",
  "audiences": [
    {
      "templateKey": "returning-visitors",
      "reason": "The Google Ads Agent asked for shoppers who came back without buying, and no active audience covers them."
    }
  ],
  "requests": [
    {
      "noticeKey": "ads-request-1",
      "answer": "audience",
      "templateKey": "returning-visitors",
      "reason": "Returning Visitors is the audience this request asks for."
    },
    {
      "noticeKey": "ads-request-2",
      "answer": "progress-bar",
      "reason": "A free-shipping promotion belongs with the Progress Bar step."
    }
  ],
  "basedOn": "Based on your audiences and orders in the last <days> days, with the Google Ads Agent"
}
```

Rules:
1. `audiences` and `requests` are always present, empty when nothing belongs in them.
2. Each audience names a `templateKey` from `templates` and carries its `reason`.
3. Each request answer names its `noticeKey`, an `answer` of `audience`, `progress-bar`, `bundles` or `none`, and its `reason`; an `audience` answer also names the `templateKey` of an audience in `audiences`.
4. `question` is present only when you ask one.
