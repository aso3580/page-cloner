const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cheerio = require('cheerio');
const { URL } = require('url');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
};

async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    console.warn(`[WARN] fetchText ${url}: ${e.message}`);
    return null;
  }
}

async function fetchBytes(url) {
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ct = (r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const buf = await r.arrayBuffer();
    return { data: Buffer.from(buf), ct };
  } catch (e) {
    console.warn(`[WARN] fetchBytes ${url}: ${e.message}`);
    return { data: null, ct: null };
  }
}

async function toDataUri(url) {
  const { data, ct } = await fetchBytes(url);
  if (data) return `data:${ct};base64,${data.toString('base64')}`;
  return url;
}

function resolveUrl(base, rel) {
  try { return new URL(rel, base).href; } catch { return rel; }
}

async function inlineCssUrls(css, base) {
  const matches = [...css.matchAll(/url\(([^)]+)\)/g)];
  for (const m of matches) {
    const raw = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (raw.startsWith('data:') || raw.startsWith('#')) continue;
    const abs = resolveUrl(base, raw);
    const uri = await toDataUri(abs);
    css = css.replace(m[0], `url('${uri}')`);
  }
  return css;
}

async function resolveImports(css, base) {
  const matches = [...css.matchAll(/@import\s+(?:url\(['"']?([^'")\s]+)['"']?\)|['"]([^'"]+)['"])\s*;?/g)];
  for (const m of matches) {
    const raw = m[1] || m[2];
    const absUrl = resolveUrl(base, raw);
    let imported = await fetchText(absUrl);
    if (imported) {
      imported = await resolveImports(imported, absUrl);
      imported = await inlineCssUrls(imported, absUrl);
    }
    css = css.replace(m[0], imported || '');
  }
  return css;
}

async function processPage(pageUrl) {
  const html = await fetchText(pageUrl);
  if (!html) return { error: '無法取得頁面內容，請確認網址是否正確' };

  const $ = cheerio.load(html);
  let baseUrl = pageUrl;

  const baseTag = $('base[href]').first();
  if (baseTag.length) {
    baseUrl = resolveUrl(pageUrl, baseTag.attr('href'));
    baseTag.remove();
  }

  // CSS（含 SCSS 動態 hash：直接讀 HTML 最新的 <link href>）
  const cssLinks = $('link[rel~="stylesheet"]').toArray();
  for (const el of cssLinks) {
    const href = $(el).attr('href');
    if (!href) continue;
    const absHref = resolveUrl(baseUrl, href);
    let css = await fetchText(absHref);
    if (css) {
      css = await resolveImports(css, absHref);
      css = await inlineCssUrls(css, absHref);
      $(el).replaceWith(`<style>${css}</style>`);
    } else {
      $(el).attr('href', absHref);
    }
  }

  // <style> 內的 @import
  const styleEls = $('style').toArray();
  for (const el of styleEls) {
    let css = $(el).html() || '';
    css = await resolveImports(css, baseUrl);
    css = await inlineCssUrls(css, baseUrl);
    $(el).html(css);
  }

  // JS
  const scripts = $('script[src]').toArray();
  for (const el of scripts) {
    const src = $(el).attr('src');
    const absSrc = resolveUrl(baseUrl, src);
    const js = await fetchText(absSrc);
    if (js) {
      const type = $(el).attr('type') || '';
      $(el).removeAttr('src');
      if (type) $(el).attr('type', type);
      $(el).html(js);
    } else {
      $(el).attr('src', absSrc);
    }
  }

  // 圖片
  const imgs = $('img[src]').toArray();
  for (const el of imgs) {
    const src = $(el).attr('src');
    if (src.startsWith('data:')) continue;
    const uri = await toDataUri(resolveUrl(baseUrl, src));
    $(el).attr('src', uri).removeAttr('srcset');
  }

  // 相對路徑 → 絕對路徑
  $('[href],[action]').each((_, el) => {
    for (const attr of ['href', 'action']) {
      const val = $(el).attr(attr);
      if (val && !val.match(/^(https?:|data:|#|javascript:|mailto:|tel:)/)) {
        $(el).attr(attr, resolveUrl(baseUrl, val));
      }
    }
  });

  // Favicon
  $('link[rel*="icon"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('data:')) {
      toDataUri(resolveUrl(baseUrl, href)).then(uri => $(el).attr('href', uri));
    }
  });

  return { html: $.html() };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let url = (req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: '請提供網址' });
  if (!url.startsWith('http')) url = 'https://' + url;

  const result = await processPage(url);
  if (result.error) return res.status(500).json({ error: result.error });

  const hostname = new URL(url).hostname.replace(/\./g, '_');
  const filename = `${hostname}.html`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(result.html);
};
