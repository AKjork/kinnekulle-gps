/* RailTimer – webbpush från bevakningen (GitHub Actions), utan beroenden.
   Krypterar meddelandet till telefonen (RFC 8291, aes128gcm enligt RFC 8188) och signerar
   VAPID-huvudet (RFC 8292, ES256). VAPID-nyckeln skapas på telefonen och skickas med i bevakningen
   som JWK, så att inga hemligheter behöver läggas in i GitHub. Körs med Node 18 eller senare. */
'use strict';
const crypto = require('node:crypto');

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

const RECORD_SIZE = 4096;
// Längsta meddelande som får plats i en post (rs − tagg 16 − avgränsare 1). Push-tjänsterna tar ca 4 kB.
const MAX_PLAINTEXT = RECORD_SIZE - 17;

/* Krypterar `plaintext` till prenumerationen (keys.p256dh, keys.auth).
   opts.salt och opts.senderKeys (ECDH-par från crypto.createECDH) bara i tester. Ger kroppen till POST. */
function encrypt(subscription, plaintext, opts) {
  const o = opts || {};
  const keys = subscription && subscription.keys;
  if (!keys || !keys.p256dh || !keys.auth) throw new Error('Prenumerationen saknar nycklar');
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Ogiltig p256dh');
  if (authSecret.length < 16) throw new Error('Ogiltig auth');
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  if (data.length > MAX_PLAINTEXT) throw new Error(`Meddelandet är för långt (${data.length} byte)`);

  const sender = o.senderKeys || (() => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e; })();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const salt = o.salt ? Buffer.from(o.salt) : crypto.randomBytes(16);

  // RFC 8291 3.4: IKM ur ECDH-hemligheten och auth
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  // RFC 8188 2.2–2.3: innehållsnyckel och nonce
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);

  // En enda post: data + avgränsaren 0x02 (sista posten)
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/* Dekrypterar (för testerna): uaKeys är telefonens ECDH-par, auth dess hemlighet. */
function decrypt(body, uaKeys, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const uaPublic = uaKeys.getPublicKey();
  const ecdhSecret = uaKeys.computeSecret(asPublic);
  const prkKey = hmac(Buffer.from(auth), ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const ct = body.subarray(21 + idlen);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('Saknar avgränsare');
  return plain.subarray(0, end);
}

/* VAPID: JWT signerat med telefonens nyckel (JWK med d, x, y) för push-tjänstens ursprung.
   Apple kräver sub (mailto: eller https:). Giltigt i 12 h (högst 24 h är tillåtet). */
function vapidHeaders(endpoint, jwk, opts) {
  const o = opts || {};
  if (!jwk || !jwk.d || !jwk.x || !jwk.y) throw new Error('VAPID-nyckeln saknas');
  const aud = new URL(endpoint).origin;
  const now = Math.floor((o.now != null ? o.now : Date.now()) / 1000);
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp: now + 12 * 3600, sub: o.subject || 'https://akjork.github.io/kinnekulle-gps/' }));
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]));
  return { Authorization: `vapid t=${head}.${claims}.${b64url(sig)}, k=${publicKey}`, jwt: `${head}.${claims}.${b64url(sig)}`, publicKey };
}

/* Skickar ett meddelande (objekt, skickas som JSON). opts: { ttl (s), urgency, topic, fetch, now }.
   Ger { ok, status, gone } – gone när prenumerationen inte finns längre (404/410). */
async function send(subscription, jwk, message, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || globalThis.fetch;
  const body = encrypt(subscription, JSON.stringify(message));
  const v = vapidHeaders(subscription.endpoint, jwk, o);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'TTL': String(o.ttl != null ? o.ttl : 900),
    'Urgency': o.urgency || 'high',
    'Authorization': v.Authorization
  };
  if (o.topic) headers.Topic = o.topic;
  let res;
  try {
    res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body });
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String(e && e.message || e) };
  }
  let text = '';
  try { text = await res.text(); } catch (e) { /* inget */ }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410, text: text.slice(0, 300) };
}

module.exports = { encrypt, decrypt, vapidHeaders, send, b64url, fromB64url, MAX_PLAINTEXT };
