const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/038b9fea-d4e0-403b-bb17-2f6df3d56038/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sql: "SELECT external_id, length(json_extract(raw_json,'$.image_data')) AS photo_bytes FROM listings WHERE length(json_extract(raw_json,'$.image_data')) > 0 LIMIT 1" }),
});
const data = await response.json();
if (!response.ok || !data.success) throw new Error('Storage verification failed');
const row = data.result[0].results[0];
if (!row) throw new Error('No stored listing photos');
const photo = await fetch(`${process.env.WORKER_URL.trim().replace(/\/$/, '')}/photo?id=${encodeURIComponent(row.external_id)}`);
const bytes = new Uint8Array(await photo.arrayBuffer());
console.log(JSON.stringify({ external_id: row.external_id, stored_base64_length: row.photo_bytes, http_status: photo.status, content_type: photo.headers.get('content-type'), bytes: bytes.length, jpeg: bytes[0] === 255 && bytes[1] === 216 }));
if (!photo.ok || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('Photo delivery failed');
