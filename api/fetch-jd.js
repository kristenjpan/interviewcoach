// Vercel serverless function: fetch a public job-posting URL and return its text.
// The browser cannot fetch other sites directly (CORS), so the page calls this instead.
// GET /api/fetch-jd?url=https://...

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_CHARS = 30000;
const TIMEOUT_MS = 12000;

const BLOCK_TAGS = 'p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|main|nav|aside|blockquote|pre|dt|dd|table|form|fieldset|hr';

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™' };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] != null ? named[n.toLowerCase()] : m));
}

function htmlToText(html) {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi, '')
    .replace(new RegExp(`<\\/?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tidy(text) {
  return text.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Many job sites embed a schema.org JobPosting block, which is the cleanest source.
function fromJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (_) { continue; }
    const nodes = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      nodes.push(n);
      if (n['@graph']) walk(n['@graph']);
    };
    walk(data);
    const job = nodes.find((n) => String(n['@type'] || '').toLowerCase().includes('jobposting'));
    if (!job) continue;
    const org = job.hiringOrganization && (job.hiringOrganization.name || job.hiringOrganization);
    const loc = job.jobLocation && (Array.isArray(job.jobLocation) ? job.jobLocation[0] : job.jobLocation);
    const addr = loc && loc.address && (typeof loc.address === 'string' ? loc.address : [loc.address.addressLocality, loc.address.addressRegion, loc.address.addressCountry].filter(Boolean).join(', '));
    const head = [job.title, typeof org === 'string' ? org : null, addr].filter(Boolean).join(' — ');
    const body = job.description ? (/<[a-z][\s\S]*>/i.test(job.description) ? htmlToText(job.description) : decodeEntities(job.description)) : '';
    if (body && body.length > 200) return { title: job.title || '', text: tidy(head ? head + '\n\n' + body : body), source: 'jsonld' };
  }
  return null;
}

// Career sites open with a run of short menu labels. Drop them, keeping the few
// short lines right before the first real paragraph (usually title and location).
function trimLeadingNav(text) {
  const lines = text.split('\n');
  const firstLong = lines.findIndex((l) => l.trim().split(/\s+/).length >= 12);
  if (firstLong <= 6) return text;
  return lines.slice(firstLong - 4).join('\n').replace(/^\n+/, '');
}

function fromHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? tidy(decodeEntities(titleMatch[1].replace(/\s+/g, ' '))) : '';
  // Prefer the main content region when there is one.
  const regions = [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<article\b[^>]*>([\s\S]*?)<\/article>/i, /<body\b[^>]*>([\s\S]*?)<\/body>/i];
  let text = '';
  for (const r of regions) {
    const m = html.match(r);
    if (m) { text = htmlToText(m[1]); if (text.length > 400) break; }
  }
  if (!text) text = htmlToText(html);
  text = trimLeadingNav(text);
  return { title, text: tidy(title ? title + '\n\n' + text : text), source: 'html' };
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
  }
  if (h.includes(':')) return true; // IPv6 literals
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Use GET with a url query parameter.' }); return; }

  let target;
  try {
    target = new URL(String(req.query.url || ''));
    if (!/^https?:$/.test(target.protocol)) throw new Error('bad protocol');
  } catch (_) {
    res.status(400).json({ error: 'Enter a full http(s) URL, for example https://company.com/jobs/123.' }); return;
  }
  if (isBlockedHost(target.hostname)) { res.status(400).json({ error: 'That host is not allowed.' }); return; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && err.name === 'AbortError';
    res.status(502).json({ error: timedOut ? 'The site took too long to respond.' : 'Could not reach that URL.' }); return;
  }
  clearTimeout(timer);

  if (!resp.ok) {
    res.status(502).json({ error: `The site returned HTTP ${resp.status}. Some job boards block automated fetching; paste the text instead.` }); return;
  }
  const ctype = resp.headers.get('content-type') || '';
  if (!/html|xml|text\/plain/i.test(ctype)) {
    res.status(415).json({ error: `That URL returned ${ctype.split(';')[0] || 'a non-HTML file'}, not a web page.` }); return;
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  const html = buf.subarray(0, MAX_BYTES).toString('utf8');
  let out = fromJsonLd(html) || fromHtml(html);
  if (!out.text || out.text.length < 200) {
    res.status(422).json({ error: 'The page did not contain readable job text. It may load its content with JavaScript or require a login; paste the text instead.' }); return;
  }
  const truncated = out.text.length > MAX_CHARS;
  res.status(200).json({ title: out.title, text: truncated ? out.text.slice(0, MAX_CHARS) : out.text, truncated, source: out.source, finalUrl: resp.url || target.toString() });
};
