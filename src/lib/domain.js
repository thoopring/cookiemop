// Domain utilities: hostname extraction, registrable-domain (eTLD+1)
// computation, and rule matching. No external dependencies — a compact
// list of common multi-part public suffixes covers the practical cases.

// Common two-part public suffixes. A hostname ending in one of these needs
// three labels to form a registrable domain (e.g. "example.co.uk").
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 're.kr', 'pe.kr', 'kg.kr', 'hs.kr', 'ms.kr', 'es.kr', 'sc.kr',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk',
  'com.sg', 'org.sg', 'net.sg', 'edu.sg', 'gov.sg',
  'com.my', 'org.my', 'net.my', 'edu.my', 'gov.my',
  'com.mx', 'org.mx', 'net.mx', 'edu.mx', 'gob.mx',
  'com.ar', 'org.ar', 'net.ar', 'edu.ar', 'gob.ar',
  'com.tr', 'org.tr', 'net.tr', 'edu.tr', 'gov.tr',
  'com.sa', 'org.sa', 'net.sa', 'edu.sa', 'gov.sa',
  'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'edu.in', 'firm.in', 'gen.in', 'ind.in',
  'co.za', 'org.za', 'net.za', 'ac.za', 'gov.za', 'web.za',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz', 'school.nz',
  'com.vn', 'net.vn', 'org.vn', 'edu.vn', 'gov.vn',
  'co.th', 'or.th', 'ac.th', 'go.th', 'in.th', 'net.th',
  'com.ph', 'org.ph', 'net.ph', 'edu.ph', 'gov.ph',
  'com.pk', 'org.pk', 'net.pk', 'edu.pk', 'gov.pk',
  'com.eg', 'org.eg', 'net.eg', 'edu.eg', 'gov.eg',
  'com.ng', 'org.ng', 'net.ng', 'edu.ng', 'gov.ng',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'sch.id', 'my.id',
  'co.il', 'org.il', 'ac.il', 'gov.il', 'net.il', 'muni.il',
  'com.co', 'org.co', 'net.co', 'edu.co', 'gov.co',
  'com.pe', 'org.pe', 'net.pe', 'edu.pe', 'gob.pe',
  'com.ve', 'org.ve', 'net.ve', 'edu.ve', 'gob.ve',
  'com.ec', 'org.ec', 'net.ec', 'edu.ec', 'gob.ec',
  'com.uy', 'org.uy', 'net.uy', 'edu.uy', 'gub.uy',
  'com.py', 'org.py', 'net.py', 'edu.py', 'gov.py',
  'com.bo', 'org.bo', 'net.bo', 'edu.bo', 'gob.bo',
  'com.gt', 'org.gt', 'net.gt', 'edu.gt', 'gob.gt',
  'com.do', 'org.do', 'net.do', 'edu.do', 'gob.do',
  'com.pa', 'org.pa', 'net.pa', 'edu.pa', 'gob.pa',
  'com.sv', 'org.sv', 'edu.sv', 'gob.sv',
  'com.ni', 'org.ni', 'edu.ni', 'gob.ni',
  'com.hn', 'org.hn', 'edu.hn', 'gob.hn',
  'com.pr', 'org.pr', 'net.pr',
  'com.ua', 'org.ua', 'net.ua', 'edu.ua', 'gov.ua', 'in.ua', 'kiev.ua',
  'com.ru', 'org.ru', 'net.ru', 'msk.ru', 'spb.ru',
  'com.pl', 'org.pl', 'net.pl', 'edu.pl', 'gov.pl', 'waw.pl',
  'com.gr', 'org.gr', 'net.gr', 'edu.gr', 'gov.gr',
  'com.pt', 'org.pt', 'edu.pt', 'gov.pt',
  'com.ro', 'org.ro', 'nt.ro',
  'co.at', 'or.at', 'ac.at', 'gv.at',
  'co.hu', 'org.hu', 'info.hu',
  'com.es', 'org.es', 'nom.es', 'edu.es', 'gob.es'
]);

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Extract a hostname from a URL. Returns null for URLs that cannot carry
 * cookies we should manage (chrome://, about:, file:, extension pages, ...).
 */
export function getHostname(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname.replace(/^\./, '').toLowerCase();
}

/**
 * Compute the registrable domain (eTLD+1) for a hostname.
 * "mail.google.com" -> "google.com", "a.b.example.co.uk" -> "example.co.uk".
 * IP addresses and single-label hosts (localhost) are returned unchanged.
 */
export function getRegistrableDomain(hostname) {
  if (!hostname) return null;
  const host = hostname.replace(/^\./, '').toLowerCase();
  if (IPV4_RE.test(host) || host.includes(':')) return host; // IPv4 / IPv6
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (TWO_PART_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

/**
 * True if `hostname` is covered by rule domain `ruleDomain`
 * (exact match or subdomain of it).
 */
export function hostMatchesRule(hostname, ruleDomain) {
  if (!hostname || !ruleDomain) return false;
  return hostname === ruleDomain || hostname.endsWith('.' + ruleDomain);
}

/**
 * Find the rule ("white" | "grey" | null) that applies to a hostname.
 * The most specific (longest) matching rule domain wins.
 * `rules` shape: { "example.com": { list: "white", addedAt: 123 }, ... }
 */
export function getRuleFor(hostname, rules) {
  if (!hostname || !rules) return null;
  let best = null;
  let bestLen = -1;
  for (const [domain, rule] of Object.entries(rules)) {
    if (hostMatchesRule(hostname, domain) && domain.length > bestLen) {
      best = rule.list;
      bestLen = domain.length;
    }
  }
  return best;
}

/**
 * Normalize user input into a bare domain: strips scheme, path, port,
 * leading dot and "www.". Returns null if it doesn't look like a domain.
 */
export function normalizeDomainInput(input) {
  if (!input) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/^\./, '');
  if (!s || !/^[a-z0-9*]([a-z0-9.*-]*[a-z0-9*])?$/.test(s)) return null;
  if (!s.includes('.') && s !== 'localhost') return null;
  return s;
}
