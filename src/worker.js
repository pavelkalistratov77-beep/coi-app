// Cloudflare Worker for the COI tracker.
// - GET  /api/sub-info?t=<token>  -> name of the sub and the contractor company
// - POST /api/upload              -> stores the certificate file and creates a DB row
// - everything else               -> static files from the "public" folder (upload.html)
//
// Secrets (set in Cloudflare, never in code):
//   SUPABASE_URL          e.g. https://abcdefgh.supabase.co
//   SUPABASE_SERVICE_KEY  your sb_secret_... key

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const authHeaders = (env) => ({
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
});

const validToken = (t) => /^[a-f0-9]{32}$/.test(t);

async function subInfo(request, env) {
  const t = new URL(request.url).searchParams.get('t') || '';
  if (!validToken(t)) return json({ error: 'Invalid link' }, 400);

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subcontractors?upload_token=eq.${t}&select=name,contractors(company_name)`,
    { headers: authHeaders(env) }
  );
  if (!res.ok) return json({ error: 'Server error' }, 500);

  const rows = await res.json();
  if (!rows.length) return json({ error: 'Link not found' }, 404);

  return json({
    subName: rows[0].name,
    companyName: rows[0].contractors.company_name,
  });
}

async function upload(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const t = String(form.get('t') || '');
  const file = form.get('file');

  if (!validToken(t)) return json({ error: 'Invalid link' }, 400);
  if (!file || typeof file === 'string' || typeof file.size !== 'number') {
    return json({ error: 'No file received' }, 400);
  }
  if (file.size === 0) return json({ error: 'The file is empty' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'File is too large (max 10 MB)' }, 400);

  const ext = ALLOWED[file.type];
  if (!ext) return json({ error: 'Please upload a PDF, JPG or PNG file' }, 400);

  const auth = authHeaders(env);

  // 1. find the subcontractor by token
  const subRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subcontractors?upload_token=eq.${t}&select=id`,
    { headers: auth }
  );
  if (!subRes.ok) return json({ error: 'Server error' }, 500);
  const subs = await subRes.json();
  if (!subs.length) return json({ error: 'Link not found' }, 404);
  const subId = subs[0].id;

  // 2. store the file in the private bucket
  const path = `${subId}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const upRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/certificates/${path}`,
    {
      method: 'POST',
      headers: { ...auth, 'Content-Type': file.type, 'x-upsert': 'false' },
      body: await file.arrayBuffer(),
    }
  );
  if (!upRes.ok) return json({ error: 'Could not store the file' }, 500);

  // 3. create the certificate record
  const rowRes = await fetch(`${env.SUPABASE_URL}/rest/v1/certificates`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      subcontractor_id: subId,
      file_path: path,
      needs_review: true,
      status: 'pending',
    }),
  });
  if (!rowRes.ok) return json({ error: 'Could not save the certificate' }, 500);

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/')) {
      try {
        // the key comes from the Cloudflare Secrets Store (binding SUPABASE_KEY_STORE);
        // if that binding is absent, fall back to a normal secret named SUPABASE_SERVICE_KEY
        const rawKey =
          env.SUPABASE_KEY_STORE && typeof env.SUPABASE_KEY_STORE.get === 'function'
            ? await env.SUPABASE_KEY_STORE.get()
            : env.SUPABASE_SERVICE_KEY;

        // clean the two settings: remove spaces/line breaks and a trailing slash
        const cleanEnv = {
          SUPABASE_URL: String(env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
          SUPABASE_SERVICE_KEY: String(rawKey || '').trim(),
        };

        if (!cleanEnv.SUPABASE_URL) {
          return json({ error: 'Setup problem: SUPABASE_URL is missing' }, 500);
        }
        if (!/^https:\/\/.+/.test(cleanEnv.SUPABASE_URL)) {
          return json({ error: 'Setup problem: SUPABASE_URL must start with https://' }, 500);
        }
        if (!cleanEnv.SUPABASE_SERVICE_KEY) {
          return json({ error: 'Setup problem: SUPABASE_SERVICE_KEY is missing' }, 500);
        }

        if (pathname === '/api/sub-info' && request.method === 'GET') {
          return await subInfo(request, cleanEnv);
        }
        if (pathname === '/api/upload' && request.method === 'POST') {
          return await upload(request, cleanEnv);
        }
        return json({ error: 'Not found' }, 404);
      } catch (e) {
        return json({ error: 'Worker error: ' + (e && e.message ? e.message : 'unknown') }, 500);
      }
    }

    // anything else: serve the static files (upload.html etc.)
    return env.ASSETS.fetch(request);
  },
};
