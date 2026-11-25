/* RailTimer – egen liten server för Västtrafiks API (Cloudflare Worker, gratis).

   Behövs bara om appen eller provsidan (vasttrafik-koll.html) säger att Västtrafik inte tillåter att token
   hämtas från webbläsaren. Servern har nyckeln och hemligheten, hämtar token och skickar frågorna vidare till
   https://ext-api.vasttrafik.se/pr/v4/… med token. Den svarar bara på GET till /pr/v4/ och bara till appens
   adress (ALLOWED_ORIGINS). Nyckeln och hemligheten finns aldrig i appen eller i repot.

   Så här:
   1. Skapa ett gratis konto på dash.cloudflare.com.
   2. Workers & Pages → Create → Create Worker. Namn: railtimer-vt. Deploy.
   3. Edit code: ersätt allt med den här filen. Deploy.
   4. Settings → Variables and Secrets → Add: VT_KEY och VT_SECRET, typ Secret, med nyckeln och hemligheten
      från Västtrafiks utvecklarportal.
   5. I appen: ⋮ → Inställningar → Västtrafik (bussar) → Egen nyckel → Egen server: https://railtimer-vt.<ditt-konto>.workers.dev → Testa.

   Testas med node --test (tests/vasttrafik-worker.test.js). */

const ALLOWED_ORIGINS = ['https://akjork.github.io'];
const VT = 'https://ext-api.vasttrafik.se';
let cached = null; // { token, expiresAt }

async function vtToken(env, force) {
  if (!force && cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const resp = await fetch(VT + '/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.VT_KEY}:${env.VT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=device_railtimer-vt'
  });
  if (!resp.ok) throw new Error(`Västtrafik godtog inte nyckeln och hemligheten (HTTP ${resp.status})`);
  const json = await resp.json();
  cached = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return cached.token;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = allowed ? corsHeaders(origin) : {};
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    const url = new URL(request.url);
    if (request.method !== 'GET' || !url.pathname.startsWith('/pr/v4/')) return new Response('Finns inte', { status: 404, headers: cors });
    if (!allowed) return new Response('Bara för RailTimer', { status: 403 });
    try {
      let resp = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await vtToken(env, attempt > 0);
        resp = await fetch(VT + url.pathname + url.search, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
        if (resp.status !== 401) break;
      }
      return new Response(resp.body, {
        status: resp.status,
        headers: Object.assign({}, cors, { 'Content-Type': resp.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' })
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
        status: 502, headers: Object.assign({}, cors, { 'Content-Type': 'application/json' })
      });
    }
  }
};
