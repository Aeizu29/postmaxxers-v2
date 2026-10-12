import puppeteer from '@cloudflare/puppeteer';

const RANKING_URL = 'https://incels.is/members/?key=most_posts';
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

// Deliberately NOT a production scraper: a bounded, read-only compatibility probe.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'postmaxxers-v2-probe', ready: Boolean(env.MYBROWSER) });
    if (url.pathname !== '/probe' || request.method !== 'POST') return json({ ok: false, error: 'Use POST /probe or GET /health.' }, 404);
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    if (!env.ADMIN_TOKEN || !token || token !== env.ADMIN_TOKEN) return json({ ok: false, error: 'Unauthorized' }, 401);
    if (!env.FORUM_COOKIE) return json({ ok: false, error: 'Configure FORUM_COOKIE as a Worker secret.' }, 503);

    let browser;
    const started = Date.now();
    try {
      browser = await puppeteer.launch(env.MYBROWSER);
      const page = await browser.newPage();
      // Create only first-party cookies for the forum before making any request.
      // Keep session values in Cloudflare secrets, never in source code or logs.
      const cookies = String(env.FORUM_COOKIE).split(';').map(part => {
        const i = part.indexOf('=');
        if (i <= 0) return null;
        const name = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z_-]+$/.test(name) || !value) return null;
        return { name, value, url: 'https://incels.is/', secure: true };
      }).filter(Boolean);
      if (!cookies.length) return json({ ok: false, error: 'FORUM_COOKIE has no valid name=value entries.' }, 422);
      await page.setCookie(...cookies);
      await page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      const outcome = await inspect(page);
      return json({
        ok: outcome.rankingLooksPresent,
        authenticationMethod: 'cookie',
        rankingLooksPresent: outcome.rankingLooksPresent,
        sample: outcome.sample,
        pageCategory: outcome.pageCategory,
        elapsedMs: Date.now() - started,
        note: 'Read-only test. Samples are not uploaded. A positive result is not proof the full ranking parser works.'
      }, outcome.rankingLooksPresent ? 200 : 422);
    } catch (e) {
      return json({ ok: false, stage: 'browser_probe', errorType: String(e?.name || 'Error'), note: 'Check wrangler tail for a sanitized error; no credentials are logged.', elapsedMs: Date.now() - started }, 502);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }
};

async function inspect(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const sample = [...document.querySelectorAll('a[href*="/members/"]')]
      .filter(a => /\/members\/[^/?#]+\.[0-9]+\/?/.test(a.getAttribute('href') || ''))
      .slice(0, 8)
      .map(a => ({ name: (a.textContent || '').trim().slice(0, 80), href: new URL(a.getAttribute('href'), location.href).pathname }));
    const unique = [...new Set(sample.map(x => x.href))];
    return {
      rankingLooksPresent: unique.length >= 3 && /most posts|messages|posts/i.test(text),
      sample,
      pageCategory: /captcha|verify you are human|checking your browser/i.test(text) ? 'verification' :
        document.querySelector('input[type="password"]') ? 'login' : unique.length >= 3 ? 'members-list' : 'unknown'
    };
  });
}
