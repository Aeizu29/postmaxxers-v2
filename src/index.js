import puppeteer from '@cloudflare/puppeteer';

const RANKING_URL = 'https://incels.is/members/?key=most_posts';
const ORIGIN = 'https://incels.is';
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
    if (!env.FORUM_USERNAME || !env.FORUM_PASSWORD) return json({ ok: false, error: 'Configure FORUM_USERNAME and FORUM_PASSWORD as Worker secrets.' }, 503);

    let browser;
    const started = Date.now();
    try {
      browser = await puppeteer.launch(env.MYBROWSER);
      const page = await browser.newPage();
      await page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
      let initial = await inspect(page);
      let attemptedLogin = false;
      let loginFormDetected = false;
      if (!initial.rankingLooksPresent) {
        const loginLink = await page.$('a[href*="/login"], a[href*="login/"]');
        if (loginLink) {
          const href = await page.evaluate(el => el.href, loginLink);
          if (href && new URL(href).origin === ORIGIN) await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } else {
          await page.goto(`${ORIGIN}/login/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        }
        loginFormDetected = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')));
        if (loginFormDetected) {
          attemptedLogin = true;
          const result = await page.evaluate(({ username, password }) => {
            const pass = document.querySelector('input[type="password"]');
            const form = pass?.form;
            if (!form) return { ok: false, reason: 'No login form detected' };
            const fields = [...form.querySelectorAll('input')];
            const user = fields.find(x => /^(login|username|email)$/i.test(x.name || '')) ||
                         fields.find(x => /text|email/i.test(x.type) && x !== pass);
            if (!user) return { ok: false, reason: 'Username input not found' };
            const setValue = (el, value) => {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              if (setter) setter.call(el, value); else el.value = value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setValue(user, username);
            setValue(pass, password);
            const submit = form.querySelector('button[type="submit"], input[type="submit"]');
            if (submit) submit.click(); else form.requestSubmit();
            return { ok: true };
          }, { username: env.FORUM_USERNAME, password: env.FORUM_PASSWORD });
          if (result.ok) {
            await new Promise(resolve => setTimeout(resolve, 1800));
            await page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
          }
        }
      }
      const outcome = await inspect(page);
      return json({
        ok: outcome.rankingLooksPresent,
        attemptedLogin, loginFormDetected,
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
