// GET /api/sub-info?t=<upload_token>
// Looks up a subcontractor by their secret upload token.
// Uses the Supabase service key, which lives only in Cloudflare environment secrets.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function onRequestGet({ request, env }) {
  const t = new URL(request.url).searchParams.get('t') || '';

  // Tokens are 32 hex characters. Reject anything else before it touches a query.
  if (!/^[a-f0-9]{32}$/.test(t)) {
    return json({ error: 'Invalid link' }, 400);
  }

  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subcontractors?upload_token=eq.${t}&select=name,contractors(company_name)`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      },
    }
  );

  if (!res.ok) return json({ error: 'Server error' }, 500);

  const rows = await res.json();
  if (!rows.length) return json({ error: 'Link not found' }, 404);

  return json({
    subName: rows[0].name,
    companyName: rows[0].contractors.company_name,
  });
}
