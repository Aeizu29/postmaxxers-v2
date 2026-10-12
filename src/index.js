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
    // Safe browser reuse diagnostic against example.com only.
    // The browser process may persist, but a fresh isolated context is used each time.
    if (url.pathname === '/session-check') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ ok: false, error: 'Unauthorized' }, 401);
      let browser, context;
      let reused = false;
      try {
        const active = await bounded(puppeteer.sessions(env.MYBROWSER), 7000, 'list_sessions');
        for (const session of active) {
          try {
            browser = await bounded(puppeteer.connect(env.MYBROWSER, session.sessionId), 7000, 'connect_session');
            reused = true;
            break;
          } catch { /* Session may expire between listing and connecting. */ }
        }
        if (!browser) browser = await bounded(puppeteer.launch(env.MYBROWSER, { keep_alive: 120000 }), 12000, 'launch_session');
        context = await bounded(browser.createBrowserContext(), 7000, 'create_context');
        const page = await bounded(context.newPage(), 7000, 'new_page');
        const response = await bounded(page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }), 18000, 'test_navigation');
        return json({
          ok: response?.status() === 200,
          browserReused: reused,
          httpStatus: response?.status() ?? null,
          pageTitle: (await page.title()).slice(0, 80),
          note: 'Tested browser-process reuse only. Forum access and login persistence are not tested.'
        });
      } catch (e) {
        return json({ ok: false, errorType: String(e?.name || 'Error'), note: 'Browser reuse diagnostic failed; no secrets logged.' }, 502);
      } finally {
        try { if (context) await bounded(context.close(), 5000, 'close_context'); } catch {}
        try { if (browser) await bounded(browser.disconnect(), 5000, 'disconnect_browser'); } catch {}
      }
    }
    // Benign persistence test: example.com only, no forum cookies.
    if (url.pathname === '/state-check') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ ok: false, error: 'Unauthorized' }, 401);
      let browser, page;
      let browserReused = false;
      try {
        const active = await bounded(puppeteer.sessions(env.MYBROWSER), 7000, 'list_sessions');
        for (const session of active) {
          try {
            browser = await bounded(puppeteer.connect(env.MYBROWSER, session.sessionId), 7000, 'connect_session');
            browserReused = true;
            break;
          } catch { /* Session expired. */ }
        }
        if (!browser) browser = await bounded(puppeteer.launch(env.MYBROWSER, { keep_alive: 120000 }), 12000, 'launch_session');
        // Use the default context deliberately; isolated contexts don't share cookies.
        page = await bounded(browser.newPage(), 7000, 'new_page');
        const response = await bounded(page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }), 18000, 'test_navigation');
        const cookieName = 'postmaxxers_state_test';
        const cookieValue = 'harmless_v2_marker';
        const cookies = await bounded(page.cookies('https://example.com/'), 7000, 'read_cookies');
        const statePersisted = cookies.some(c => c.name === cookieName && c.value === cookieValue);
        await bounded(page.setCookie({ name: cookieName, value: cookieValue, url: 'https://example.com/', secure: true, expires: Math.floor(Date.now() / 1000) + 3600 }), 7000, 'set_test_cookie');
        return json({
          ok: response?.status() === 200,
          browserReused,
          httpStatus: response?.status() ?? null,
          statePersisted,
          testCookieWritten: true,
          note: 'Only a harmless example.com cookie is used. Does not establish forum access.'
        });
      } catch (e) {
        return json({ ok: false, errorType: String(e?.name || 'Error'), note: 'State diagnostic failed; no credentials logged.' }, 502);
      } finally {
        try { if (page) await bounded(page.close(), 5000, 'close_page'); } catch {}
        try { if (browser) await bounded(browser.disconnect(), 5000, 'disconnect_browser'); } catch {}
      }
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
      // Aggregate browser events only; never record URLs, headers, script content or errors.
      const browserEvents = { pageErrors: 0, consoleErrors: 0, failedRequests: 0, http4xx: 0, http5xx: 0, challengeResponses: 0 };
      page.on('pageerror', () => { browserEvents.pageErrors++; });
      page.on('console', msg => { if (msg.type() === 'error') browserEvents.consoleErrors++; });
      page.on('requestfailed', () => { browserEvents.failedRequests++; });
      page.on('response', response => {
        const status = response.status();
        if (status >= 400 && status < 500) browserEvents.http4xx++;
        if (status >= 500) browserEvents.http5xx++;
        if (status === 403) browserEvents.challengeResponses++;
      });
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
      let outcome = await bounded(inspect(page), deadlines.inspection, stage);
      const initialHttpStatus = navigationResponse?.status() ?? null;
      const challengeAtStart = /just a moment/i.test(outcome.pageTitle || '');
      let waitedMs = 0;
      // A challenge page can transition automatically; give it up to 20 seconds.
      // Only observe the current page: no challenge-solving or repeated requests.
      if (challengeAtStart) {
        logStage('automatic_challenge_wait');
        const waitStart = Date.now();
        while (Date.now() - waitStart < 20000) {
          await new Promise(resolve => setTimeout(resolve, Math.min(2000, 20000 - (Date.now() - waitStart))));
          outcome = await bounded(inspect(page), deadlines.inspection, 'challenge_reinspection');
          if (!/just a moment/i.test(outcome.pageTitle || '')) break;
        }
        waitedMs = Date.now() - waitStart;
      }
      outcome.browserEvents = browserEvents;
      outcome.javascriptEnabled = await bounded(page.evaluate(() => 6 * 7 === 42), deadlines.inspection, 'javascript_check');
      outcome.httpStatus = initialHttpStatus;
      outcome.waitedMs = waitedMs;
      outcome.challengeAtStart = challengeAtStart;
      outcome.challengeStillPresent = /just a moment/i.test(outcome.pageTitle || '');
      logStage('completed');
      return json({
        ok: outcome.rankingLooksPresent,
        authenticationMethod: 'cookie',
        stagesCompleted: 'browser launch, cookie setup, navigation, inspection',
        rankingLooksPresent: outcome.rankingLooksPresent,
        sample: outcome.sample,
        pageCategory: outcome.pageCategory,
        httpStatus: outcome.httpStatus,
        waitedMs: outcome.waitedMs,
        challengeAtStart: outcome.challengeAtStart,
        challengeStillPresent: outcome.challengeStillPresent,
        finalPage: outcome.finalPage,
        pageTitle: outcome.pageTitle,
        diagnostics: outcome.diagnostics,
        browserEvents: outcome.browserEvents,
        javascriptEnabled: outcome.javascriptEnabled,
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
