// POST /api/upload  (multipart form: t = upload token, file = certificate)
// 1. validates the token and the file
// 2. stores the file in the private Supabase Storage bucket "certificates"
// 3. creates a row in the certificates table (status "pending", needs_review true)
// AI extraction is added in the next step and will fill in the details later.

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

export async function onRequestPost({ request, env }) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  const t = String(form.get('t') || '');
  const file = form.get('file');

  if (!/^[a-f0-9]{32}$/.test(t)) return json({ error: 'Invalid link' }, 400);
  if (!file || typeof file === 'string' || typeof file.size !== 'number') {
    return json({ error: 'No file received' }, 400);
  }
  if (file.size === 0) return json({ error: 'The file is empty' }, 400);
  if (file.size > MAX_BYTES) return json({ error: 'File is too large (max 10 MB)' }, 400);

  const ext = ALLOWED[file.type];
  if (!ext) return json({ error: 'Please upload a PDF, JPG or PNG file' }, 400);

  const auth = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };

  // 1. find the subcontractor by token
  const subRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subcontractors?upload_token=eq.${t}&select=id`,
    { headers: auth }
  );
  if (!subRes.ok) return json({ error: 'Server error' }, 500);
  const subs = await subRes.json();
  if (!subs.length) return json({ error: 'Link not found' }, 404);
  const subId = subs[0].id;

  // 2. store the file (private bucket)
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
