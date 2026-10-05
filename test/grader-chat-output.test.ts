import { describe, expect, it } from 'vitest';

import { GRADER_CHAT_CHOICE_ACTIONS, reviewGraderChatReply } from '../src/lib/grader-chat-output';

const PROSE = 'Your report found gaps on your home page, and LimeSpot covers them.';

function review(reply: string): ReturnType<typeof reviewGraderChatReply> {
  return reviewGraderChatReply(reply, true);
}

function withButtons(envelope: string): string {
  return `${PROSE}\n\n\`\`\`json\n${envelope}\n\`\`\``;
}

function openLink(href: string): string {
  return `{ "choices": [ { "label": "See the page", "action": "grader.open-link", "args": { "href": "${href}" } } ] }`;
}

describe('the link guard is the only check on what a reply says', () => {
  it('withholds a link to any host but limespot.com, with a scheme or bare', () => {
    for (const reply of [
      'Install it at https://apps.shopify.com/limespot.',
      'Visit www.example.com for details.',
      'Go to apps.shopline.com/detail/limespot now.',
      'Open https://limespot.com@evil.example/login.',
      'Email mailto:help@evil.example.',
      'Visit ｗｗｗ.example.com today.',
      'Visit competitor.com.',
      'See example.org.',
      'Compare us with shop.example.co.uk/deals.',
      'Open example.io:8080/demo instead.',
      'Ask at limespot.com.evil.example today.',
      'See https://ex\u200bample.com/offer.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [
      'Read [this](https://limespot.com.evil.example/offer).',
      'Open [here](/demo-page).',
      'Try [this](javascript://alert).',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('withholds every parser-confusion form, read as a browser parses it', () => {
    for (const reply of [
      'Go to https://evil.example@limespot.com/offer.',
      'Open https://user:secret@limespot.com/demo.',
      'Open https://evil%2Eexample/offer.',
      'Open https://limespot.com%2F@evil.example/x.',
      'Open https://evil.example%2F%2Flimespot.com/x.',
      'Open https://lim\u0435spot.com/demo.',
      'Visit lim\u0435spot.com today.',
      'Open https://xn--limespt-7fg.com/demo.',
      'Visit xn--limespot-9ya.com today.',
      'Open https://evil.example./offer.',
      'Visit evil.example./offer today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [
      'Go to https://evil.example\\@limespot.com/offer.',
      'Visit evil.example\\@limespot.com today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('withholds IP literals and every non-https scheme, with or without slashes', () => {
    for (const reply of [
      'Visit 1.1.1.1 today.',
      'Open 1.1.1.1:8080/admin now.',
      'Open https://0x7f.1/admin now.',
      'Call tel:+15551234567 for help.',
      'Text sms:+15551234567 for help.',
      'Run javascript:alert(1) now.',
      'Open data:text/html,hello now.',
      'Join whatsapp:send?phone=15551234567 now.',
      'Open intent:#Intent;scheme=x;end now.',
      'Use magnet:?xt=urn:btih:abc now.',
      'Open file:///etc/passwd now.',
      'Open ftp://example.com/file now.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [
      'Open https://[2606:4700:4700::1111]/x now.',
      'Try http://[::1]:8080/admin now.',
      'See [2606:4700::1111]/x for details.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('withholds every mailto link and every plain address but one bare recipient at limespot.com', () => {
    for (const reply of [
      'Write to mailto:sales@limespot.com?bcc=attacker@evil%2Eexample now.',
      'Write to mailto:attacker@evil%2Eexample,sales@limespot.com now.',
      'Write to mailto:sales%40limespot.com now.',
      'Write to mailto:sales@limespot.com,attacker@evil.example now.',
      'Write to mailto:sales@limespot.com;attacker@evil.example now.',
      'Write to mailto:?to=attacker@evil.example now.',
      'Write to mailto:sales@limespot.com?subject=hello now.',
      'Write to attacker@evil%2Eexample today.',
      'Write to sales%40limespot.com today.',
      'Write to sales@limespot%2Ecom today.',
      'Write to attacker@evil.example today.',
      'Write to mailto:hello@limespot.com.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [
      'Write to hello@limespot.com or sales@help.limespot.com.',
      'Write to sales_team@limespot.com today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('withholds any four dot-separated octets, whatever follows them', () => {
    for (const reply of [
      'Visit 1.1.1.1.',
      'Try it (1.1.1.1) today.',
      'Try 1.1.1.1, it is fast.',
      'Use 10.0.0.255; it answers.',
      'Is it 192.168.001.010?',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of ['Widget v1.2.3 shows bundles.', 'Release 2.10.4 adds a carousel.']) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('withholds any URI-shaped token by its structure, not by a list of schemes', () => {
    for (const reply of [
      'Pay to bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq now.',
      'Chat at xmpp:user@example.com now.',
      'Join matrix:r/room:example.org now.',
      'Scan otpauth://totp/LimeSpot?secret=JBSWY3DPEHPK3PXP now.',
      'Try foo:bar now.',
      'Open localhost:8080/admin now.',
      'Open http:limespot.com now.',
      'Tip:LimeSpot places widgets on product pages.',
      'Write to mailto:?to=attacker%40evil%2Eexample now.',
      'Open data:,hello now.',
      'Try foo:?bar now.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [
      'Try foo:*bar now.',
      '**Tip:** LimeSpot places widgets on product pages.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('withholds a URI-shaped token whatever the length of its scheme', () => {
    const longScheme = `${'x'.repeat(40)}-pay+scheme`;
    for (const reply of [
      `Open ${longScheme}:?payload now.`,
      `Open ${longScheme}://anything now.`,
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [`Open ${longScheme}:*bar now.`]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('reads tens of kilobytes of adversarial text in linear time', () => {
    const inputs = [
      `${'a'.repeat(60_000)}:?payload`,
      'a'.repeat(60_000),
      'a.'.repeat(30_000),
      'aa-'.repeat(20_000),
      `](${'y'.repeat(60_000)}`,
      '](a '.repeat(15_000),
      `[${'a'.repeat(60_000)}`,
      'a@'.repeat(30_000),
      'a:'.repeat(30_000),
      'ab.cd-ef:gh@ij '.repeat(4_000),
      `${'a'.repeat(30_000)}.${'b'.repeat(30_000)}`,
      '{'.repeat(60_000),
      `{${' '.repeat(60_000)}`,
      '{ '.repeat(30_000),
      '```'.repeat(20_000),
      `\`\`\`json${' '.repeat(60_000)}`,
      '{ "choices": '.repeat(5_000),
      `{ "choices": [${'{ "label": "Go" },'.repeat(3_000)}] }`,
      '['.repeat(60_000),
      `[${' '.repeat(60_000)}`,
      `[${'1'.repeat(60_000)}`,
      '[1'.repeat(30_000),
      `[${'a'.repeat(60_000)}](`,
      '~'.repeat(60_000),
      '<'.repeat(60_000),
      `&${'a'.repeat(60_000)}`,
      '- '.repeat(30_000),
      '\n#'.repeat(30_000),
    ];
    const started = performance.now();
    for (const text of inputs) reviewGraderChatReply(text, true);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(review(`${'a'.repeat(60_000)}:?payload`)).toEqual({
      withheld: true,
      reason: 'external-link',
    });
  });

  it('maps every WHATWG dot equivalent to a dot before reading links', () => {
    for (const reply of [
      'Visit evil\u3002example today.',
      'Visit evil\uFF61example today.',
      'Visit evil\uFF0Eexample today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    expect(review('Visit limespot\u3002com today.')).toEqual({ withheld: false });
  });

  it('passes ordinary prose with colons, times and ratios', () => {
    for (const reply of [
      'Note: LimeSpot adds recommendations below your hero.',
      'At 10:30 the report ran, and the ratio was 3:1.',
      'Re: your question, LimeSpot adds a bundle widget.',
      'Data: the report covers your home page.',
      'Here is what the report found:',
      'Two things matter: placement and fit.',
      'Version 1.2.3 of the widget shows bundles.',
      'Tip: LimeSpot places widgets on product pages.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('passes limespot.com named as a bare site and withholds every URL, limespot.com included', () => {
    for (const reply of [
      'Visit limespot.com.',
      'The LimeSpot team at limespot.com can help.',
      'See help.limespot.com for details.',
      'Visit LIMESPOT.COM today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
    for (const reply of [
      'Learn more at https://limespot.com or https://www.limespot.com/pricing.',
      'Learn more at https://limespot.com today.',
      'See www.limespot.com for details.',
      'See help.limespot.com/demo for details.',
      'Open limespot.com:443 now.',
      'Open limespot.com?ref=chat now.',
      'Open limespot.com#pricing now.',
      'Open https://limespot.com./demo now.',
      'Open https://LIMESPOT.COM/demo now.',
      'Open https://limespot%2Ecom/demo now.',
      'Write to mailto:hello@limespot.com today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    expect(review('See [our site](https://limespot.com/demo-request) for details.')).toEqual({
      withheld: true,
      reason: 'malformed-choices',
    });
  });

  it('passes a listed brand shaped like a hostname when it stands as a plain word', () => {
    for (const reply of [
      'LimeSpot works with Judge.me',
      'LimeSpot works with Judge.me.',
      'Yotpo, Okendo, Loox, Judge.me, Stamped and Ryviu are all included.',
      'Do you use Judge.me?',
      'It works with JUDGE.ME and judge.me alike!',
      'Reviews come from Judge.me: LimeSpot shows them in widgets.',
      'Pick a review app (Judge.me) and connect it.',
      'Pick a review app (Yotpo or Judge.me), then connect it.',
      'Connect “Judge.me” or "Judge.me" or ‘Judge.me’ in a minute.',
      "LimeSpot shows Judge.me’s reviews and Judge.me's ratings.",
      'Reviews from Judge.me...',
      '- Judge.me\n- Yotpo',
      'Connect Ｊｕｄｇｅ．ｍｅ today.',
      'Connect Judge\u3002me today.',
      'Connect Jud\u200Bge.me today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
    for (const reply of [
      'Connect **Judge.me** or _Judge.me_ in a minute.',
      'Connect Judge.me and see [our site](https://limespot.com/integrations).',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('withholds a listed brand written as a link: scheme, path, port, query, fragment, subdomain, address or Markdown target', () => {
    for (const reply of [
      'See judge.me/apps for reviews.',
      'See judge.me/ for reviews.',
      'See Judge.me\\apps for reviews.',
      'Open https://judge.me now.',
      'Open http://Judge.me today.',
      'Open //judge.me now.',
      'Open judge.me:443 now.',
      'Open judge.me:443/apps now.',
      'Open judge.me?ref=limespot now.',
      'Open judge.me#install now.',
      'Visit www.judge.me today.',
      'Visit apps.judge.me today.',
      'Visit judge.me.evil.example today.',
      'Visit judge.me./apps today.',
      'Write to x@judge.me today.',
      'Write to mailto:x@judge.me today.',
      'Visit evil_judge.me today.',
      'Visit judge.me.com today.',
      'Visit judge.me-reviews.com today.',
      'Visit judgeme.com today.',
      'Open judge.me\u200B/apps now.',
      'Open judge.me／apps now.',
      'Open https://judge\u3002me now.',
      'Open ｈｔｔｐｓ://judge.me now.',
      'Open judge.me:４４３ now.',
      'Open judge\uFF0Eme/apps now.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [
      'Read [reviews](judge.me) today.',
      'Read [reviews]( judge.me ) today.',
      'Read [reviews](judge.me "Judge.me") today.',
      'Read [reviews](https://judge.me) today.',
      'Read [Judge.me](https://limespot.com/integrations) today.',
      'Read <judge.me> today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('never withholds a reply for its wording: claims are the prompt’s to govern', () => {
    for (const reply of [
      'LimeSpot can add Trending products below your home page hero.',
      'LimeSpot plans include a 15-day free trial.',
      'Your report names 3 gaps across 2 pages.',
      'Recommendations help shoppers find related products.',
      'No one can promise a specific result.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('delivers a reply ending in a buttons block that names only the listed actions', () => {
    for (const envelope of [
      '{ "choices": [ { "label": "Talk to our team", "action": "grader.book-call" }, { "label": "Install LimeSpot", "action": "grader.install" }, { "label": "Which page should I start with?" } ] }',
      '{"choices":[{"label":"Talk to our team","action":"grader.book-call"},{"label":"Install LimeSpot","action":"grader.install"}]}',
      JSON.stringify(
        {
          choices: [
            { label: 'Install LimeSpot', action: 'grader.install' },
            { label: 'Does LimeSpot work with Judge.me?' },
          ],
        },
        null,
        2,
      ),
      '{ "choices": [ { "label": "Talk to our team", "action" : "grader.book-call" }, { "label": "Install", "action":\n  "grader.install" } ] }',
      '{ "choices": [ { "label": "What does LimeSpot cost for my store?" } ] }',
    ]) {
      expect(review(withButtons(envelope)), envelope).toEqual({ withheld: false });
    }
    expect(GRADER_CHAT_CHOICE_ACTIONS).toEqual([
      'grader.book-call',
      'grader.install',
      'grader.open-link',
    ]);
  });

  it('delivers a link button to limespot.com or a subdomain, however its JSON is spaced', () => {
    for (const reply of [
      withButtons(openLink('https://limespot.com/pricing')),
      withButtons(openLink('https://support.limespot.com')),
      withButtons(openLink('https://www.limespot.com/integrations')),
      withButtons(
        '{"choices":[{"label":"Help center","action":"grader.open-link","args":{"href":"https://support.limespot.com"}}]}',
      ),
      withButtons(
        '{ "choices": [ { "label": "Pricing", "action": "grader.open-link", "args": { "href": "https://limespot.com/pricing"} } ] }',
      ),
      withButtons(
        '{"choices":[{"label":"Home","action":"grader.open-link","args":{"href":"https://limespot.com"}},{"label":"Install","action":"grader.install"}]}',
      ),
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('withholds a link button whose href is not an https address on limespot.com', () => {
    for (const href of [
      'https://evil.example',
      'https://evil.example/limespot',
      'https://limespot.com.evil.example',
      'http://user@limespot.com',
      'http://limespot.com/pricing',
      'https://user:secret@limespot.com/demo',
      'https://evil.example\\\\@limespot.com',
      'javascript:alert(1)',
      'evil.example/offer',
      'support.limespot.com',
      '/pricing',
      'grader.install',
    ]) {
      expect(review(withButtons(openLink(href))), href).toEqual({
        withheld: true,
        reason: 'external-link',
      });
    }
    expect(
      review(
        withButtons(
          '{"choices":[{"label":"Deal","action":"grader.open-link","args":{"href":"https://evil.example"}}]}',
        ),
      ),
    ).toEqual({ withheld: true, reason: 'external-link' });
  });

  it('reads every label and href as JSON.parse decodes it, so an escaped character cannot hide a link', () => {
    for (const reply of [
      withButtons('{ "choices": [ { "label": "evil\\u002eexample" } ] }'),
      withButtons('{ "choices": [ { "label": "Visit \\u0065vil\\u002Eexample today" } ] }'),
      withButtons(
        '{ "choices": [ { "label": "Install", "action": "grader.install" }, { "label": "Try foo\\u003abar" } ] }',
      ),
      withButtons('{ "choices": [ { "label": "Open https:\\/\\/evil.example" } ] }'),
      withButtons('{ "choices": [ { "label": "Visit evil\\u3002example" } ] }'),
      withButtons(openLink('https://evil\\u002eexample/offer')),
      withButtons(openLink('https:\\/\\/evil.example')),
      withButtons(openLink('https://limespot.com\\u002eevil.example')),
      withButtons(openLink('https://evil\\uFF0Eexample')),
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    expect(review(withButtons(openLink('https://support\\u002elimespot.com')))).toEqual({
      withheld: false,
    });
  });

  it('withholds a buttons block lib cannot parse, rather than let it render as chat text', () => {
    for (const envelope of [
      '{ "choices": [ { "label": "Install", "action": "grader.install", } ] }',
      '{ "choices": [ { "label": "What does it cost?" } ], }',
      '{ "choices": [ { "label": "Go", "action": grader.install } ] }',
      "{ 'choices': [ { 'label': 'What does it cost?' } ] }",
      '{ choices: [ { label: "What does it cost?" } ] }',
      '{ note: "next", choices: [ { label: "Install LimeSpot" } ] }',
      '{ "note": "next", choices: [ { "label": "Install LimeSpot" } ] }',
      '{ "choices": [ { "label": "What does it cost?" } ]',
      '{ "choices": [ { "label": "What does it cost?" }\n',
    ]) {
      expect(review(withButtons(envelope)), envelope).toEqual({
        withheld: true,
        reason: 'malformed-choices',
      });
    }
  });

  it('lets the one valid buttons block be the only structure in a reply: any other fence or brace is withheld', () => {
    const valid = withButtons(
      '{ "choices": [ { "label": "Install", "action": "grader.install" } ] }',
    );
    for (const reply of [
      `${valid}\n\n\`\`\`json\n{ note: "next", choices: [ { label: "Install LimeSpot" } ] }\n\`\`\``,
      `${valid}\n\n\`\`\`json\n{ "choices": [ { "label": "What does it cost?" } ] }\n\`\`\``,
      `${valid}\n\n{ "choices": [ { "label": "What does it cost?" } ] }`,
      `Run this first:\n\n\`\`\`\nnpm install limespot\n\`\`\`\n\n${valid}`,
      `${PROSE}\n\n\`\`\`html\n<div class="limespot-box"></div>\n\`\`\``,
      `${PROSE}\n\n\`\`\`\nInstall LimeSpot from your app store.\n\`\`\``,
      `${PROSE}\n\n\`\`\`json\n{ "label": "Install" }\n\`\`\``,
      `${PROSE}\n\n\`\`\`JSON\n{ "choices": [ { "label": "What does it cost?" } ] }\n\`\`\``,
      `${PROSE}\n\n\`\`\`json\n{ "choices": [ { "label": "What does it cost?" } ] }`,
      `Use {curly} braces. { "choices": [ { "label": "What does it cost?" } ] }`,
      `${PROSE} Your widget reads {product.title}.`,
      `${PROSE} Pick a layout {grid or carousel`,
      `${PROSE} Pick a layout grid or carousel}`,
      `Pick a layout {grid or carousel\n\n${valid}`,
      `${valid}\n\nThat covers it }`,
      `${PROSE} Pick a layout ｛grid｝ today.`,
      `${PROSE}\n\n｀｀｀\nnpm install limespot\n｀｀｀`,
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
    for (const reply of [
      valid,
      `${PROSE} Ask about your choices: install or a call.`,
      `${valid}\n\nThe "choices": above are yours.`,
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('withholds a whole reply that is JSON of any kind but the one valid block, and passes plain prose', () => {
    for (const reply of [
      '["Install LimeSpot", "What should I do next?"]',
      '[{ "label": "Install LimeSpot", "action": "grader.install" }]',
      '[]',
      '"Install LimeSpot"',
      '  "LimeSpot covers your home page."  ',
      '42',
      '-1.5e3',
      'true',
      'false',
      'null',
      '{ "label": "Install LimeSpot" }',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
    const valid = '{ "choices": [ { "label": "Install LimeSpot", "action": "grader.install" } ] }';
    for (const reply of [
      'See [our pricing](https://limespot.com/pricing) for the plans.',
      '[our pricing](https://limespot.com/pricing)',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
    for (const reply of [
      valid,
      `The pricing page is one click away.\n\n\`\`\`json\n${valid}\n\`\`\``,
      'True, LimeSpot covers that.',
      '42 products is plenty.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('withholds every reply shape the plain-text chat would show as raw code, JSON or markup', () => {
    const valid = withButtons(
      '{ "choices": [ { "label": "Install", "action": "grader.install" } ] }',
    );
    for (const reply of [
      '["Install LimeSpot",]',
      `${PROSE} LimeSpot adds **bundles** to your product pages.`,
      `${PROSE} LimeSpot adds __bundles__ to your product pages.`,
      `${PROSE} LimeSpot adds *bundles* to your product pages.`,
      `${PROSE} LimeSpot adds _bundles_ to your product pages.`,
      `${PROSE} Turn on \`Bundles\` once LimeSpot is installed.`,
      `${PROSE} See [our pricing](https://limespot.com/pricing).`,
      '[our pricing](https://limespot.com/pricing) has every plan.',
      '- [Pricing](https://limespot.com/pricing)',
      '* Upsells in the cart\n* Cross-sells after checkout',
      '+ Upsells in the cart\n+ Cross-sells after checkout',
      `${PROSE}\n\n---\n\nLimeSpot covers both.`,
      `${PROSE}\n\n***`,
      `${PROSE}\n\n    npm install limespot`,
      `${PROSE}\n\n\tnpm install limespot`,
      `${PROSE} Use \`inline code\` freely.`,
      `${PROSE}\n\n~~~json\n{ "choices": [ { "label": "What does it cost?" } ] }\n~~~`,
      '[\n  "Install LimeSpot",\n  "Talk to our team"\n]',
      `${PROSE}\n\n["Install LimeSpot", "Talk to our team"]`,
      `${PROSE} Your options are ["Install", "Call"].`,
      `${PROSE} Pick from [ 'Install' ].`,
      `${PROSE} Totals were [1, 2, 3].`,
      `${PROSE} Flags were [true, false].`,
      `${PROSE} Nothing here: [].`,
      `${PROSE} Nested [[1]] arrays.`,
      '[Install LimeSpot] on your store today.',
      `${PROSE}\n\n[1]: https://limespot.com/pricing`,
      '- [ ] Install LimeSpot\n- [x] Run the Grader',
      `${PROSE}\n\n~~~\nnpm install limespot\n~~~`,
      `${PROSE}\n\n~~~~python\nprint(1)\n~~~~`,
      `${PROSE}\n\n\`\`\`\`\nnpm install limespot\n\`\`\`\``,
      `${PROSE}\n\n～～～\nnpm install limespot\n～～～`,
      `${PROSE}\n\n~\u200B~~\nnpm install limespot\n~~~`,
      `${PROSE}\n\n<div class="limespot-box">Bundles</div>`,
      `${PROSE} Add <br/> between lines.`,
      `${PROSE} <!-- hidden note -->`,
      '<?xml version="1.0"?><choices/>',
      `${PROSE} See <https://limespot.com/pricing>.`,
      `${PROSE} Use ＜script＞ tags.`,
      `${PROSE} Bundles &amp; upsells.`,
      `${PROSE} It&#39;s ready.`,
      `# Your report\n\n${PROSE}`,
      `${PROSE}\r\n\r\n## Next steps`,
      `Your report\n===\n\n${PROSE}`,
      `> ${PROSE}`,
      '| Page | Gap |\n| --- | --- |\n| Home | Recommendations |',
      `${PROSE} ![LimeSpot](https://limespot.com/logo.png)`,
      '- # A heading in a list',
      '1. > A quote in a list',
      '- - [x] A nested task box',
      `${PROSE} Use ［"Install"］ now.`,
      `${PROSE} ﹛"choices": 1﹜`,
      `＃ Your report\n\n${PROSE}`,
      withButtons('{ "choices": [ { "label": "What is {store}?" } ] }'),
      withButtons('{ "choices": [ { "label": "<b>Install</b>", "action": "grader.install" } ] }'),
      withButtons('{ "choices": [ { "label": "[Install]", "action": "grader.install" } ] }'),
      withButtons('{ "choices": [ { "label": "Is **Pro** right for me?" } ] }'),
      withButtons('{ "choices": [ { "label": "What does `Bundles` do?" } ] }'),
      withButtons('{ "choices": [ { "label": "Is _Pro_ right for me?" } ] }'),
      `${valid}\n\n~~~\nnpm install limespot\n~~~`,
      `${valid}\n\n<p>Thanks</p>`,
      `${valid}\n\n["Install LimeSpot"]`,
      `# Next steps\n\n${valid}`,
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
  });

  it('withholds every GitHub Flavored Markdown construct a plain-text bubble would show raw, section by section', () => {
    const sections: readonly (readonly [string, readonly string[]])[] = [
      ['thematic breaks', ['---', '***', '___', '- - -', '* * *', '_ _ _', '  ----']],
      ['ATX headings', ['# Plans', '###### Plans', '   ## Plans']],
      ['setext headings', ['Plans\n=====', 'Plans\n-----', 'Plans\n=']],
      [
        'indented code',
        ['    npm install limespot', '\tnpm install limespot', 'Run it:\n\n        npm install'],
      ],
      [
        'fenced code',
        [
          '```\nnpm install\n```',
          '~~~\nnpm install\n~~~',
          '````json\n{}\n````',
          '~~~~ python\nprint(1)\n~~~~',
        ],
      ],
      [
        'HTML blocks',
        [
          '<script>alert(1)</script>',
          '<pre>npm install</pre>',
          '<style>p{}</style>',
          '<textarea>x</textarea>',
          '<!-- note -->',
          '<?php echo 1; ?>',
          '<!DOCTYPE html>',
          '<![CDATA[x]]>',
          '<div>Bundles</div>',
          '</div>',
        ],
      ],
      [
        'link reference definitions',
        ['[pricing]: https://limespot.com/pricing', '[1]: /pricing "Pricing"'],
      ],
      [
        'tables',
        [
          '| Plan | Price |\n| --- | --- |\n| Studio | $50 |',
          'Plan | Price\n--- | ---\nStudio | $50',
          'Plan | Price\n:--- | ---:\nStudio | $50',
          '| :---: |',
          'Plan|Price',
        ],
      ],
      [
        'block quotes',
        ['> LimeSpot adds bundles.', '>LimeSpot adds bundles.', '> > nested', '- > quoted item'],
      ],
      ['task list items', ['- [ ] Install LimeSpot', '- [x] Run the Grader', '1. [X] Done']],
      [
        'backslash escapes and hard line breaks',
        ['\\*not bold\\*', 'Price \\$50', 'Line one\\\nline two', 'Ends with a break\\'],
      ],
      [
        'entity and numeric character references',
        ['Bundles &amp; upsells', 'It&#39;s ready', 'It&#x27;s ready', 'It&#X27;s ready', '&nbsp;'],
      ],
      ['code spans', ['Turn on `Bundles`', 'Use ``code``']],
      [
        'emphasis and strong emphasis',
        [
          '**bold**',
          '__bold__',
          '*italic*',
          '_italic_',
          '***both***',
          'mid*word*emphasis',
          '_leading underscore',
        ],
      ],
      ['strikethrough', ['~old~ price', '~~old~~ price', 'About ~50 products']],
      [
        'links, images and footnotes',
        [
          '[pricing](https://limespot.com/pricing)',
          '[pricing][1]',
          '[pricing][]',
          '[pricing]',
          '![logo](https://limespot.com/logo.png)',
          'As noted[^1].',
          '[^1]: A footnote.',
        ],
      ],
      ['autolinks', ['<https://limespot.com>', '<hello@limespot.com>']],
      [
        'raw HTML inline',
        ['Add <br> here', 'An <span class="x">inline</span> tag', 'a </b> close'],
      ],
      [
        'fullwidth and invisible forms',
        ['～～old～～', 'Plan ｜ Price', '＼＊x＼＊', '*​*bold*​*'],
      ],
    ];
    for (const [section, replies] of sections) {
      for (const reply of replies) {
        expect(review(reply), `${section}: ${reply}`).toEqual({
          withheld: true,
          reason: 'malformed-choices',
        });
      }
    }
    for (const reply of [
      'See www.limespot.com for details.',
      'Open https://limespot.com/pricing now.',
      'Visit evil.example today.',
      'Write to someone@evil.example today.',
    ]) {
      expect(review(reply), `extended autolinks: ${reply}`).toEqual({
        withheld: true,
        reason: 'external-link',
      });
    }
  });

  it('delivers what GitHub Flavored Markdown leaves as plain text: paragraphs, simple list lines, soft and two-space breaks, bare site names and emails', () => {
    for (const reply of [
      'LimeSpot adds bundles.\nIt also adds upsells.',
      'Line one  \nline two after a two-space break',
      'LimeSpot adds:\n- Bundles\n- Upsells',
      '1. Install LimeSpot\n2) Let it set up',
      'The team at limespot.com can help, or write to hello@limespot.com.',
      'Your store_name field and snake_case words stay plain.',
      'A whitespace-only line\n    \nstays blank.',
      'Rates: 3:1, 10:30, #1 and +1 stay prose.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('delivers the plain text the chat shows as written: sentences, paragraphs and simple list lines', () => {
    const valid = withButtons(
      '{ "choices": [ { "label": "Install", "action": "grader.install" } ] }',
    );
    for (const reply of [
      PROSE,
      'Your report found two gaps.\n\nLimeSpot covers both.',
      'LimeSpot adds:\n\n- Recommendations on your home page\n- Bundles on product pages\n\n1. Install LimeSpot\n2. Let the Onboarding Agent set it up',
      '1) Install LimeSpot\n2) Let it set up what the report found',
      '  - A line indented less than four spaces still reads as plain text.',
      'The LimeSpot team at limespot.com can walk you through it.',
      'Write to hello@limespot.com or sales_team@limespot.com.',
      'Smaller carts < bigger ones, and shoppers <3 bundles.',
      'LimeSpot ❴Pro❵ and ⟨Plus⟩ are just words here.',
      'Ratios like 3:1 at 10:30 stay prose, and so does +1 for bundles.',
      '#1 tip: add bundles to your product pages.',
      '-> Next: install LimeSpot.',
      'Pick a layout (grid or carousel) and LimeSpot fills it.',
      `LimeSpot adds:\n\n- Bundles\n- Upsells\n\nThe Install LimeSpot button below sets it up.\n\n\`\`\`json\n{ "choices": [ { "label": "Install", "action": "grader.install" } ] }\n\`\`\``,
      valid,
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('withholds a parsed buttons block of any shape but the one the buttons block teaches', () => {
    for (const envelope of [
      '{ "choices": [] }',
      '{ "choices": { "label": "Install", "action": "grader.install" } }',
      '{ "choices": [ "Install" ] }',
      '{ "choices": [ null ] }',
      '{ "choices": [ [ "Install" ] ] }',
      '{ "choices": [ { "action": "grader.install" } ] }',
      '{ "choices": [ { "label": "  ", "action": "grader.install" } ] }',
      '{ "choices": [ { "label": 7 } ] }',
      '{ "choices": [ { "label": "Go", "action": null } ] }',
      '{ "choices": [ { "label": "Go", "action": "evil.com" } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.fly" } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.installer" } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.install.evil.example" } ] }',
      '{ "choices": [ { "label": "Go", "action": "Grader.Install" } ] }',
      '{ "choices": [ { "label": "Go", "action": " grader.install" } ] }',
      '{ "choices": [ { "label": "Go", "actions": "grader.install" } ] }',
      '{ "choices": [ { "label": "Go", "href": "https://limespot.com" } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.install", "args": { "href": "https://limespot.com" } } ] }',
      '{ "choices": [ { "label": "What does it cost?", "args": { "href": "https://limespot.com" } } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.open-link" } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.open-link", "args": "https://limespot.com" } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.open-link", "args": { "href": 7 } } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.open-link", "args": { "url": "https://limespot.com" } } ] }',
      '{ "choices": [ { "label": "Go", "action": "grader.open-link", "args": { "href": "https://limespot.com", "target": "_blank" } } ] }',
      '{ "reply": "Install LimeSpot.", "choices": [ { "label": "Install", "action": "grader.install" } ] }',
      '{ "choices": [ { "label": "Install", "action": "grader.install" } ], "directives": [] }',
      '{ "directives": [ { "action": "grader.install" } ] }',
      '{ "reply": "Install LimeSpot." }',
    ]) {
      expect(review(withButtons(envelope)), envelope).toEqual({
        withheld: true,
        reason: 'malformed-choices',
      });
    }
  });

  it('matches an action exactly as JSON.parse decodes it, folding nothing', () => {
    expect(
      review(withButtons('{ "choices": [ { "label": "Go", "action": "grader\\u002einstall" } ] }')),
    ).toEqual({ withheld: false });
    for (const action of ['grader。install', 'grader．install', 'grader.in\u200Bstall']) {
      expect(
        review(withButtons(`{ "choices": [ { "label": "Go", "action": "${action}" } ] }`)),
        action,
      ).toEqual({ withheld: true, reason: 'malformed-choices' });
    }
    expect(
      review(
        withButtons(
          '{ "choices": [ { "label": "Go", "action": "grader.install" }, { "label": "Visit evil．example" } ] }',
        ),
      ),
    ).toEqual({ withheld: true, reason: 'external-link' });
  });

  it('reads a listed action name anywhere but a valid block’s action as a hostname', () => {
    for (const reply of [
      withButtons('{ "choices": [ { "label": "grader.install" } ] }'),
      `Tap grader.install below.\n\n\`\`\`json\n{ "choices": [ { "label": "Install", "action": "grader.install" } ] }\n\`\`\``,
      'Tap grader.install below to add LimeSpot.',
      'Use grader.book-call or grader.open-link to reach us.',
      'Press "grader.install" now.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
  });

  it('finds the buttons block wherever lib finds it, and reads the prose on both sides of it', () => {
    const envelope = '{ "choices": [ { "label": "Install", "action": "grader.install" } ] }';
    for (const reply of [
      envelope,
      `${PROSE}\n\n${envelope}`,
      `${PROSE}\n\n\`\`\`\n${envelope}\n\`\`\``,
      `${PROSE}\n\n\`\`\`json${envelope}\`\`\``,
      `${withButtons(envelope)}\n\nAsk me anything else.`,
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
    expect(review(`${withButtons(envelope)}\n\nOr visit evil.example.`)).toEqual({
      withheld: true,
      reason: 'external-link',
    });
  });

  it('withholds a reply the model did not finish or left empty', () => {
    expect(reviewGraderChatReply('LimeSpot adds recommendations.', false)).toEqual({
      withheld: true,
      reason: 'incomplete',
    });
    expect(review('   ')).toEqual({ withheld: true, reason: 'empty' });
  });
});
