import puppeteer from '@cloudflare/puppeteer';

const RANKING_URL = 'https://incels.is/members/?key=most_posts';
const deadlines = { launch: 12000, cookies: 7000, navigation: 18000, inspection: 7000, cleanup: 5000 };
function bounded(promise, ms, stage) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out at ' + stage)), ms); })
  ]).finally(() => clearTimeout(timer));
}
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

// Deliberately NOT a production scraper: a bounded, read-only compatibility probe.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'postmaxxers-v2-probe', ready: Boolean(env.MYBROWSER) });
    // Fast authentication-only diagnostic. Never echoes tokens or secrets.
    if (url.pathname === '/auth-check') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
      const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i);
      const supplied = bearer?.[1] || '';
      if (!env.ADMIN_TOKEN) return json({ ok: false, error: 'ADMIN_TOKEN secret is missing from this deployment' }, 503);
      if (!supplied || supplied !== env.ADMIN_TOKEN) return json({ ok: false, error: 'Unauthorized', tokenReceived: Boolean(supplied) }, 401);
      return json({ ok: true, authenticated: true, browserStarted: false });
    }
    if (url.pathname !== '/probe' || request.method !== 'POST') return json({ ok: false, error: 'Use POST /probe or GET /health.' }, 404);
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    if (!env.ADMIN_TOKEN || !token || token !== env.ADMIN_TOKEN) return json({ ok: false, error: 'Unauthorized' }, 401);
    if (!env.FORUM_COOKIE) return json({ ok: false, error: 'Configure FORUM_COOKIE as a Worker secret.' }, 503);

    let browser;
    const started = Date.now();
    let stage = 'initializing';
    const logStage = (name) => { stage = name; console.log('[probe]', name, 'elapsedMs=' + (Date.now() - started)); };
    let cookieCount = 0;
    try {
      logStage('browser_launch');
      browser = await bounded(puppeteer.launch(env.MYBROWSER), deadlines.launch, stage);
      logStage('new_page');
      const page = await bounded(browser.newPage(), deadlines.cookies, stage);
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
      cookieCount = cookies.length;
      logStage('cookies');
      await bounded(page.setCookie(...cookies), deadlines.cookies, stage);
      logStage('forum_navigation');
      const navigationResponse = await bounded(page.goto(RANKING_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }), deadlines.navigation, stage);
      logStage('ranking_inspection');
      const outcome = await bounded(inspect(page), deadlines.inspection, stage);
      outcome.httpStatus = navigationResponse?.status() ?? null;
      logStage('completed');
      return json({
        ok: outcome.rankingLooksPresent,
        authenticationMethod: 'cookie',
        stagesCompleted: 'browser launch, cookie setup, navigation, inspection',
        rankingLooksPresent: outcome.rankingLooksPresent,
        sample: outcome.sample,
        pageCategory: outcome.pageCategory,
        httpStatus: outcome.httpStatus,
        finalPage: outcome.finalPage,
        pageTitle: outcome.pageTitle,
        diagnostics: outcome.diagnostics,
        elapsedMs: Date.now() - started,
        note: 'Read-only test. Samples are not uploaded. A positive result is not proof the full ranking parser works.'
      }, outcome.rankingLooksPresent ? 200 : 422);
    } catch (e) {
      console.error('[probe] failed', { stage, errorType: String(e?.name || 'Error'), elapsedMs: Date.now() - started });
      return json({ ok: false, stage, errorType: String(e?.name || 'Error'), timeout: /Timed out/.test(String(e?.message)), elapsedMs: Date.now() - started, note: 'No cookies or tokens logged. Inspect Observability logs for the last completed stage.' }, 502);
    } finally {
      if (browser) {
        try { await bounded(browser.close(), deadlines.cleanup, 'browser_cleanup'); }
        catch { console.warn('[probe] browser cleanup did not complete within 5s'); }
      }
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
      finalPage: location.origin + location.pathname,
      pageTitle: (document.title || '').slice(0, 120),
      diagnostics: {
        memberProfileLinks: document.querySelectorAll('a[href*="/members/"]').length,
        uniqueSampleProfiles: unique.length,
        pageTextLength: text.length,
        hasChallengeKeywords: /captcha|verify you are human|checking your browser|just a moment/i.test(text),
        hasPasswordInput: Boolean(document.querySelector('input[type="password"]')),
        hasMemberListKeywords: /most posts|notable members|members/i.test(text),
      },
      sample,
      pageCategory: /captcha|verify you are human|checking your browser/i.test(text) ? 'verification' :
        document.querySelector('input[type="password"]') ? 'login' : unique.length >= 3 ? 'members-list' : 'unknown'
    };
  });
}
