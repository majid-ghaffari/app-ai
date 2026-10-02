import { describe, expect, it } from 'vitest';

import { reviewGraderChatReply } from '../src/lib/grader-chat-output';

function review(reply: string): ReturnType<typeof reviewGraderChatReply> {
  return reviewGraderChatReply(reply, true);
}

describe('the link guard is the only check on what a reply says', () => {
  it('withholds a link to any host but limespot.com, with a scheme or bare', () => {
    for (const reply of [
      'Install it at https://apps.shopify.com/limespot.',
      'Visit www.example.com for details.',
      'Go to apps.shopline.com/detail/limespot now.',
      'Read [this](https://limespot.com.evil.example/offer).',
      'Open https://limespot.com@evil.example/login.',
      'Open [here](/demo-page).',
      'Try [this](javascript://alert).',
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
  });

  it('withholds every parser-confusion form, read as a browser parses it', () => {
    for (const reply of [
      'Go to https://evil.example\\@limespot.com/offer.',
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
      'Visit evil.example\\@limespot.com today.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
  });

  it('withholds IP literals and every non-https scheme, with or without slashes', () => {
    for (const reply of [
      'Open https://[2606:4700:4700::1111]/x now.',
      'Try http://[::1]:8080/admin now.',
      'See [2606:4700::1111]/x for details.',
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
  });

  it('withholds every mailto and plain address but one bare recipient at limespot.com', () => {
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
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
    for (const reply of [
      'Write to mailto:hello@limespot.com.',
      'Write to hello@limespot.com or sales@help.limespot.com.',
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
      'Try foo:*bar now.',
      '**Tip:** LimeSpot places widgets on product pages.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
    }
  });

  it('withholds a URI-shaped token whatever the length of its scheme', () => {
    const longScheme = `${'x'.repeat(40)}-pay+scheme`;
    for (const reply of [
      `Open ${longScheme}:?payload now.`,
      `Open ${longScheme}:*bar now.`,
      `Open ${longScheme}://anything now.`,
    ]) {
      expect(review(reply), reply).toEqual({ withheld: true, reason: 'external-link' });
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
      '**Tip**: LimeSpot places widgets on product pages.',
      'Here is what the report found:',
      'Two things matter: placement and fit.',
      'Version 1.2.3 of the widget shows bundles.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
    }
  });

  it('passes a link to limespot.com or its subdomains, in any form', () => {
    for (const reply of [
      'See [our site](https://limespot.com/demo-request) or write to mailto:hello@limespot.com.',
      'Learn more at https://limespot.com or https://www.limespot.com/pricing.',
      'Visit limespot.com.',
      'See www.limespot.com or help.limespot.com/demo for details.',
      'Open https://limespot.com./demo now.',
      'Open https://LIMESPOT.COM/demo now.',
      'Open https://limespot%2Ecom/demo now.',
    ]) {
      expect(review(reply), reply).toEqual({ withheld: false });
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

  it('withholds a reply the model did not finish or left empty', () => {
    expect(reviewGraderChatReply('LimeSpot adds recommendations.', false)).toEqual({
      withheld: true,
      reason: 'incomplete',
    });
    expect(review('   ')).toEqual({ withheld: true, reason: 'empty' });
  });
});
