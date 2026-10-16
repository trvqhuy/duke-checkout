// Browser functions are source strings so TypeScript's runtime transpiler cannot
// inject closure helpers into functions serialized across the CDP boundary.
const TOKEN_RESOLVER = String.raw`function(requiredScopes) {
  let clientHint = null;
  const authCookies = (document.cookie || '').split('; ').filter(function(value) { return /^auth0\.[^.]+\.is\.authenticated=/.test(value); });
  if (authCookies.length === 1) clientHint = authCookies[0].split('.')[1];
  const candidates = [];
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('@@auth0spajs@@') || !key.includes('::https://api.bigw.com.au/api::') || key.endsWith('@@user@@')) continue;
    try {
      const cached = JSON.parse(localStorage.getItem(key));
      const client = key.split('::')[1];
      if (!cached?.body?.access_token || (clientHint && client !== clientHint)) continue;
      if (cached.body.client_id && cached.body.client_id !== client) continue;
      const scopes = String(cached.body.scope || key.split('::').slice(3).join('::')).split(/\s+/);
      if (!(requiredScopes || []).every(function(scope) { return scopes.includes(scope); })) continue;
      candidates.push({ token: cached.body.access_token, expiresAt: Number(cached.expiresAt) || 0, scopes: scopes });
    } catch {}
  }
  candidates.sort(function(a, b) { return b.expiresAt - a.expiresAt || b.scopes.length - a.scopes.length; });
  return candidates[0] || null;
}`;

export const PAGE_REQUEST = String.raw`async function(args) {
  if (!['https://api.bigw.com.au', 'https://apix.bigw.com.au'].includes(args.origin) || !args.path.startsWith('/') || args.path.startsWith('//')) {
    return { ok: false, status: 0, code: 'REQUEST_ORIGIN' };
  }
  const headers = { accept: 'application/json' };
  if (args.body !== undefined) headers['content-type'] = 'application/json';
  if (!args.publicRequest) {
    const scopes = args.path.startsWith('/profile/') ? ['account:view', 'account:pii:view']
      : args.path.includes('/saved-cards') || args.path.includes('/payment-options') ? ['payment:view']
      : /\/pay(?:\/|$)/.test(args.path) ? ['payment:manage', 'payment:authorise']
      : args.method === 'POST' ? ['cart:manage'] : ['cart:view'];
    const cached = (${TOKEN_RESOLVER})(scopes);
    if (!cached) return { ok: false, status: 401, code: 'LOGIN_REQUIRED' };
    if (cached.expiresAt && cached.expiresAt < Date.now() / 1000 + 15) return { ok: false, status: 401, code: 'SESSION_EXPIRED' };
    headers[args.path.startsWith('/profile/') ? 'authorization' : 'authorization3'] = 'Bearer ' + cached.token;
  }
  try {
    const response = await fetch(args.origin + args.path, {
      method: args.method || 'GET', credentials: args.origin.includes('apix.') ? 'omit' : 'include',
      headers: headers, body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: AbortSignal.timeout(args.timeoutMs || 20000)
    });
    if (!response.ok) return { ok: false, status: response.status, code: response.status === 401 ? 'LOGIN_REQUIRED' : response.status === 403 ? 'BROWSER_ATTENTION' : 'STORE_REQUEST' };
    if (response.status === 204) return { ok: true, status: 204, data: null };
    const data = await response.json();
    return { ok: true, status: response.status, data: data };
  } catch (error) {
    return { ok: false, status: 0, code: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'REQUEST_NETWORK' };
  }
}`;

export const PAGE_CONTEXT = String.raw`function() {
  const cached = (${TOKEN_RESOLVER})(['cart:view']);
  let cartId = null;
  try { cartId = JSON.parse(localStorage.getItem('bigw:state-cartId')); } catch {}
  function cookie(name) {
    const value = document.cookie.split('; ').find(function(part) { return part.startsWith(name + '='); });
    try { return value ? JSON.parse(decodeURIComponent(value.slice(name.length + 1))) : null; } catch { return null; }
  }
  return {
    authenticated: !!cached?.token,
    tokenSecondsRemaining: cached?.expiresAt ? Math.floor(cached.expiresAt - Date.now() / 1000) : 0,
    cartId: typeof cartId === 'string' ? cartId : null,
    storeId: cookie('bigw_location-store'),
    delivery: cookie('bigw_location-delivery')
  };
}`;

export const APPLY_CART_CONTEXT = String.raw`function(args) {
  const labels = { ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory', QLD: 'Queensland', SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia' };
  const delivery = { postcode: args.address.postcode, suburb: args.address.suburb.toUpperCase(), state: args.address.state, region: { id: 'AU-' + args.address.state, value: { isoCode: 'AU-' + args.address.state, isoCountryCode: 'AU', name: labels[args.address.state], code: args.address.state } } };
  const cookies = { 'bigw_location-store': args.storeId, 'bigw_location-delivery': delivery, 'bigw_location-state': args.address.state };
  if (args.zone) cookies['bigw_location-zone'] = args.zone;
  if (args.zoneType) cookies['bigw_location-type'] = args.zoneType.toLowerCase();
  for (const name of Object.keys(cookies)) document.cookie = name + '=' + encodeURIComponent(JSON.stringify(cookies[name])) + '; Path=/; Domain=.bigw.com.au; SameSite=Lax; Secure; Max-Age=31536000';
  localStorage.setItem('bigw:state-cartId', JSON.stringify(args.cartId));
  localStorage.setItem('bigw:state-fulfilmentIntent', JSON.stringify({ mode: 'DELIVERY' }));
  localStorage.removeItem('bigw:state-cartItems');
  localStorage.removeItem('bigw:state-pickupStoreOption');
}`;
