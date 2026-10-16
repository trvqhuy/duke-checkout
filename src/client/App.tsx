import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Address, ArmedCheckout, Bootstrap, CheckoutRun, ConnectionState, PaymentInput, ProductInfo, Profile, RunMode, SavedCard } from '../shared/types.ts';
import { api, bootstrap, RequestError } from './api.ts';
import { DeliveryFields, Field, Icon, PaymentFields, RunHistory, RunSummary, type CardForm } from './components.tsx';
import { activeRunId, mergeRuns } from './run-state.ts';

const emptyAddress = (): Address => ({ line1: '', line2: '', suburb: '', postcode: '', state: 'VIC', country: 'AU' });
const emptyProfile = (): Profile => ({ name: 'Home delivery', firstName: '', lastName: '', phone: '', deliveryAddress: emptyAddress(), billingSame: true });
const emptyCard = (): CardForm => ({ kind: 'new', number: '', expiry: '', cvv: '', cardId: '' });

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [deliveryOpen, setDeliveryOpen] = useState(true);
  const [productUrl, setProductUrl] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [maxTotal, setMaxTotal] = useState('');
  const [mode, setMode] = useState<RunMode>('prepare');
  const [product, setProduct] = useState<ProductInfo>();
  const [card, setCard] = useState<CardForm>(emptyCard);
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [runs, setRuns] = useState<CheckoutRun[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>({ status: 'disconnected', message: 'Connect the Chrome you already use.' });
  const [busy, setBusy] = useState('boot');
  const [error, setError] = useState<RequestError | null>(null);
  const [notice, setNotice] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [localOnline, setLocalOnline] = useState(false);
  const [armed, setArmed] = useState<ArmedCheckout | null>(null);
  const runsRef = useRef<CheckoutRun[]>([]);
  const requestId = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let closed = false;
    let source: EventSource | undefined;
    void bootstrap().then((data: Bootstrap) => {
      if (closed) return;
      setProfiles(data.profiles); receiveRuns(data.runs, data.activeRunId); setConnection(data.connection); setLocalOnline(true);
      setArmed(data.armed);
      if (data.profiles[0]) { setProfile(data.profiles[0]); setSelectedProfile(data.profiles[0].id!); setDeliveryOpen(false); }
      if (data.activeRunId) setFocusedId(data.activeRunId);
      setBusy('');
      source = new EventSource('/api/events');
      source.onmessage = event => {
        try {
          const update = JSON.parse(event.data);
          if (update.type === 'snapshot') { receiveRuns(update.runs, update.activeRunId); setConnection(update.connection); }
          if (update.type === 'connection') setConnection(update.connection);
          if (update.type === 'run') {
            receiveRuns([update.run as CheckoutRun], update.activeRunId);
          }
        } catch { /* EventSource reconnects automatically; incomplete messages are ignored. */ }
      };
      let resyncing = false;
      source.onerror = () => {
        setLocalOnline(false); setNotice('Progress connection interrupted. Reconnecting to the local server…');
        if (resyncing) return;
        resyncing = true;
        void bootstrap().then(fresh => {
          if (!closed) { receiveRuns(fresh.runs, fresh.activeRunId); setConnection(fresh.connection); setLocalOnline(true); }
        }).catch(() => undefined).finally(() => { resyncing = false; });
      };
      source.onopen = () => { setLocalOnline(true); setNotice(current => current.startsWith('Progress connection interrupted') ? '' : current); };
    }).catch(failure => { if (!closed) { setError(asError(failure)); setBusy(''); } });
    return () => { closed = true; source?.close(); };
  }, []);

  function asError(value: unknown) { return value instanceof RequestError ? value : new RequestError('This action could not finish. Please try again.', 'REQUEST'); }
  function receiveRuns(incoming: CheckoutRun[], proposedActive: string | null) {
    const next = mergeRuns(runsRef.current, incoming);
    runsRef.current = next; setRuns(next); setActiveId(activeRunId(next, proposedActive));
  }
  const fields = Object.fromEntries(Object.entries(error?.fields ?? {}).map(([key, message]) => [key.replace(/^profile\./, ''), message]));
  const active = !!activeId;
  const displayedRun = runs.find(run => run.id === (activeId ?? focusedId));
  const payloadProfile = () => ({ ...profile, billingAddress: profile.billingSame ? undefined : profile.billingAddress });

  async function operation<T>(name: string, callback: () => Promise<T>): Promise<T | undefined> {
    setBusy(name); setError(null); setNotice('');
    try { return await callback(); }
    catch (failure) {
      const issue = asError(failure); setError(issue);
      if (Object.keys(issue.fields).some(key => /firstName|lastName|phone|Address/.test(key))) setDeliveryOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return undefined;
    } finally { setBusy(''); }
  }

  async function connect() {
    // Live events own connection state. The accepted HTTP response can arrive
    // after a newer "connected" event and must not put the UI back in "waiting".
    await operation('connect', () => api('/browser/connect', 'POST', {}));
  }
  async function importProfile() {
    await operation('import', async () => {
      const result = await api<{ profile: Profile; savedCards: SavedCard[] }>('/browser/import-profile', 'POST', {});
      setProfile(result.profile); setSelectedProfile(''); setCards(result.savedCards); setCard(current => ({ ...current, cardId: result.savedCards[0]?.id ?? '' }));
      setDeliveryOpen(!result.profile.deliveryAddress.line1 || !result.profile.phone); setNotice('Contact details imported from your current BIG W checkout.');
    });
  }
  async function saveProfile() {
    await operation('save', async () => {
      const result = await api<{ profile: Profile }>('/profiles', 'POST', payloadProfile());
      setProfile(result.profile); setSelectedProfile(result.profile.id!); setDeliveryOpen(false);
      setProfiles(current => [result.profile, ...current.filter(item => item.id !== result.profile.id)]);
      setNotice('Contact profile saved on this computer.');
    });
  }
  async function deleteProfile() {
    if (!profile.id) return;
    await operation('delete', async () => {
      await api(`/profiles/${profile.id}`, 'DELETE');
      setProfiles(current => current.filter(item => item.id !== profile.id)); setProfile({ ...profile, id: undefined }); setSelectedProfile(''); setNotice('Saved profile removed.');
    });
  }
  async function inspect() {
    await operation('inspect', async () => {
      const result = await api<{ product: ProductInfo }>('/inspect', 'POST', { productUrl, profile: payloadProfile() });
      setProduct(result.product); setFocusedId(null);
      if (!maxTotal) setMaxTotal(((result.product.priceCents * Number(quantity || 1) + result.product.deliveryCents) / 100).toFixed(2));
    });
  }
  async function refreshCards() { await operation('cards', async () => { const result = await api<{ cards: SavedCard[] }>('/browser/cards', 'POST', {}); setCards(result.cards); setCard(current => ({ ...current, cardId: result.cards[0]?.id ?? '' })); }); }
  async function arm() {
    await operation('arm', async () => {
      const result = await api<{ armed: ArmedCheckout }>('/arm', 'POST', { productUrl, quantity: Number(quantity), maxTotal, profile: payloadProfile() });
      setArmed(result.armed);
      setNotice(`Checkout armed. The cart is prepared — the next matching start skips straight to payment.`);
    });
  }
  async function disarm() { await operation('disarm', async () => { await api('/arm', 'DELETE'); setArmed(null); setNotice('Armed checkout cleared.'); }); }
  // A hint only: the server re-checks the armed cart against the run itself.
  const armedStale = !!armed && (
    armed.productUrl !== productUrl.trim() || armed.quantity !== Number(quantity) ||
    armed.profile.name !== profile.name || armed.profile.phone !== profile.phone ||
    armed.profile.deliveryAddress.postcode !== profile.deliveryAddress.postcode ||
    armed.profile.deliveryAddress.line1 !== profile.deliveryAddress.line1 ||
    armed.profile.deliveryAddress.suburb !== profile.deliveryAddress.suburb ||
    armed.profile.deliveryAddress.state !== profile.deliveryAddress.state);
  async function start(event?: FormEvent) {
    event?.preventDefault();
    if (busy || active || !localOnline) return;
    if (!formRef.current?.reportValidity()) return;
    await operation('start', async () => {
      requestId.current ??= crypto.randomUUID();
      const payment: PaymentInput | undefined = (mode === 'assist' || mode === 'purchase')
        ? (card.kind === 'new' ? { kind: 'new', number: card.number, expiry: card.expiry, cvv: card.cvv } : { kind: 'saved', cardId: card.cardId, cvv: card.cvv })
        : undefined;
      const result = await api<{ run: CheckoutRun }>('/runs', 'POST', { requestId: requestId.current, productUrl, quantity: Number(quantity), maxTotal, mode, profile: payloadProfile(), card: payment });
      setCard({ ...emptyCard(), cardId: card.cardId }); requestId.current = null;
      setFocusedId(result.run.id);
      receiveRuns([result.run], ['queued', 'running', 'action_required'].includes(result.run.status) ? result.run.id : null);
    });
  }
  async function cancel() { if (activeId) await operation('cancel', () => api(`/runs/${activeId}/cancel`, 'POST', {})); }
  async function focus() { await operation('focus', () => api('/browser/focus', 'POST', {})); }
  async function resolveOutcome(resolution: 'confirmed' | 'not_purchased', orderNumber?: string) {
    if (!displayedRun) return;
    await operation('resolve', async () => { const result = await api<{ run: CheckoutRun }>(`/runs/${displayedRun.id}/resolve`, 'POST', { resolution, orderNumber }); receiveRuns([result.run], activeId); });
  }
  function chooseProfile(id: string) {
    setSelectedProfile(id); setError(null); requestId.current = null;
    const selected = profiles.find(item => item.id === id);
    setProfile(selected ? structuredClone(selected) : emptyProfile()); setDeliveryOpen(!selected);
  }
  function editDraft() { setFocusedId(null); requestId.current = null; }

  return <div className="workspace">
    <header className="app-header">
      <a href="/" className="brand" title="duke/checkout"><span className="brand-mark" aria-hidden="true" /><span>duke<span className="brand-divider">/</span><span className="brand-product">checkout</span></span></a>
      <div className="header-right"><span className="local-label"><span /> Local workspace</span><button type="button" className={`connection-button ${connection.status}`} onClick={connect} disabled={!!busy || connection.status === 'connecting'}><span className="connection-dot" /><span>{connection.status === 'connected' ? 'Chrome connected' : connection.status === 'connecting' ? 'Waiting for Chrome' : 'Connect Chrome'}</span><Icon name="browser" size={16} /></button></div>
    </header>
    <main>
      <div className="page-intro"><div><div className="eyebrow intro-eyebrow"><span className="tiny-line" /> LESS BETWEEN YOU AND CHECKOUT</div><h1>Your next checkout,<br /><em>a little quicker.</em></h1><p>A BIG W link, your details, and the browser you already use.</p></div><div className="intro-note"><span className="note-index">01 / LOCAL FIRST</span><span>Prepared by requests.<br />Finished in your browser.</span></div></div>
      {(connection.status !== 'connected' || setupOpen) && <div className="connection-guide"><div className="guide-top"><Icon name="browser" size={18} /><div><strong>{connection.status === 'connecting' ? 'Chrome may be asking for permission.' : connection.status === 'error' ? 'Chrome needs a connection check.' : 'Use your existing Chrome session.'}</strong><p>{connection.message}</p></div><button type="button" className="text-button" onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? 'Less detail' : 'Setup help'}</button></div>{setupOpen && <div className="setup-instructions"><p>In Chrome, open <code>chrome://inspect/#remote-debugging</code> and enable remote debugging for this browser. Click <strong>Connect Chrome</strong> here, then allow <strong>Duke Checkout</strong> if Chrome asks. Sign in to BIG W once in that browser.</p><button className="secondary-button compact" type="button" onClick={() => { void navigator.clipboard.writeText('chrome://inspect/#remote-debugging').then(() => setNotice('Chrome setup address copied.')); }}>Copy Chrome setup address</button></div>}</div>}
      {error && <div className="feedback error-feedback" role="alert"><span className="feedback-mark">!</span><div><strong>{error.message}</strong>{error.code === 'LOGIN_REQUIRED' && <button type="button" className="text-button" onClick={focus}>Open BIG W to sign in <Icon name="external" size={13} /></button>}</div><button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError(null)}><Icon name="close" size={16} /></button></div>}
      {notice && <div className="feedback notice-feedback" role="status"><Icon name="check" size={16} /><span>{notice}</span><button type="button" className="icon-button" aria-label="Dismiss message" onClick={() => setNotice('')}><Icon name="close" size={16} /></button></div>}
      <div className="checkout-grid">
        <form ref={formRef} className="checkout-form" onSubmit={start} noValidate={false} onInput={() => setError(current => (current ? null : current))}>
          <fieldset disabled={active || (!!busy && busy !== 'focus')}>
            <section className="form-section"><div className="section-heading"><span className="section-number">01</span><div><h2>The product</h2><p>One product link. One focused checkout.</p></div><span className="retailer-label">BIG W AU</span></div>
              <div className="product-link-row"><Field name="productUrl" label="Product URL" value={productUrl} onChange={value => { setProductUrl(value); setProduct(undefined); editDraft(); }} type="url" placeholder="https://www.bigw.com.au/product/…/p/…" autoComplete="off" required errors={fields} /><button type="button" className="inspect-button" onClick={inspect} disabled={!!busy || !productUrl}>{busy === 'inspect' ? <span className="spinner dark-spinner" /> : <Icon name="link" size={17} />}<span>{busy === 'inspect' ? 'Checking' : 'Inspect'}</span></button></div>
              <div className="quantity-budget"><Field name="quantity" label="Quantity" value={quantity} onChange={value => { setQuantity(value); editDraft(); }} type="number" min="1" max="20" step="1" inputMode="numeric" required errors={fields} /><Field name="maxTotal" label="Maximum delivered total" value={maxTotal} onChange={value => { setMaxTotal(value); editDraft(); }} inputMode="decimal" placeholder="0.00" required suffix={<span className="currency-label">AUD</span>} hint="Includes the item and delivery. Never exceeded." errors={fields} /></div>
              {product && <div className={`inspection-result ${product.available ? 'available' : 'unavailable'}`}><Icon name={product.available ? 'check' : 'close'} size={15} /><span>{product.available ? `${product.stockLabel}${product.deliveryEstimate ? ` · ${product.deliveryEstimate}` : ''}` : 'This item is unavailable for delivery to this address.'}</span></div>}
            </section>
            <section className="form-section"><div className="section-heading"><span className="section-number">02</span><div><h2>Delivery & contact</h2><p>Use a profile or bring details across from BIG W.</p></div></div>
              <div className="profile-toolbar"><div className="field"><label htmlFor="profile-select">Contact profile</label><select id="profile-select" value={selectedProfile} onChange={event => chooseProfile(event.target.value)}><option value="">New contact profile</option>{profiles.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><button type="button" className="secondary-button import-button" onClick={importProfile} disabled={!!busy}><Icon name="browser" size={15} />{busy === 'import' ? 'Importing…' : 'Import from BIG W'}</button></div>
              {!deliveryOpen && profile.deliveryAddress.line1 ? <div className="profile-preview"><span className="profile-monogram">{profile.firstName.charAt(0)}{profile.lastName.charAt(0)}</span><div><strong>{profile.firstName} {profile.lastName}</strong><span>{profile.deliveryAddress.line1}{profile.deliveryAddress.line2 ? `, ${profile.deliveryAddress.line2}` : ''}</span><span>{profile.deliveryAddress.suburb}, {profile.deliveryAddress.state} {profile.deliveryAddress.postcode} <span className="contact-separator">·</span> {profile.phone}</span></div><button type="button" className="icon-button" onClick={() => setDeliveryOpen(true)} aria-label="Edit delivery profile"><Icon name="edit" size={17} /></button></div> : <div className="expanded-profile"><DeliveryFields profile={profile} setProfile={value => { setProfile(value); editDraft(); }} errors={fields} /></div>}
              <div className="profile-save-row"><Field name="name" label="Profile name" value={profile.name} onChange={name => setProfile({ ...profile, name })} placeholder="Home delivery" errors={fields} /><button type="button" className="secondary-button" onClick={saveProfile} disabled={!!busy}>{busy === 'save' ? 'Saving…' : selectedProfile ? 'Update profile' : 'Save profile'}</button>{profile.id && <button type="button" className="text-button delete-profile" onClick={deleteProfile} disabled={!!busy}>Remove</button>}</div>
              <p className="fine-print">Contact details stay in this local workspace. The signed-in BIG W account provides the checkout email.</p>
            </section>
            <section className="form-section last-section"><div className="section-heading"><span className="section-number">03</span><div><h2>How far should it go?</h2><p>Choose once, before the run starts.</p></div></div>
              <div className="mode-options" role="group" aria-label="Execution mode"><button type="button" aria-pressed={mode === 'prepare'} className={mode === 'prepare' ? 'mode-option selected' : 'mode-option'} onClick={() => { setMode('prepare'); setCard(emptyCard()); editDraft(); }}><span className="mode-indicator" /><div><strong>Prepare checkout</strong><span>Ready in Chrome. No payment.</span></div></button><button type="button" aria-pressed={mode === 'assist'} className={mode === 'assist' ? 'mode-option selected' : 'mode-option'} onClick={() => { setMode('assist'); editDraft(); }}><span className="mode-indicator" /><div><strong>Fill card only</strong><span>Fill the card, you press Pay.</span></div></button><button type="button" aria-pressed={mode === 'purchase'} className={mode === 'purchase' ? 'mode-option selected' : 'mode-option'} onClick={() => { setMode('purchase'); editDraft(); }}><span className="mode-indicator" /><div><strong>Purchase automatically</strong><span>Fill the card and place the order.</span></div></button><button type="button" aria-pressed={mode === 'afterpay'} className={mode === 'afterpay' ? 'mode-option selected' : 'mode-option'} onClick={() => { setMode('afterpay'); setCard(emptyCard()); editDraft(); }}><span className="mode-indicator" /><div><strong>Afterpay</strong><span>Open Afterpay for you to complete.</span></div></button></div>
              {mode === 'assist' || mode === 'purchase' ? <PaymentFields card={card} setCard={setCard} cards={cards} errors={fields} refresh={refreshCards} refreshing={busy === 'cards'} /> : mode === 'afterpay' ? <div className="prepare-note"><Icon name="lock" size={16} /><p>No card needed. Duke prepares the cart, selects Afterpay, and opens Afterpay’s checkout for you to sign in and confirm.</p></div> : <div className="prepare-note"><Icon name="lock" size={16} /><p>No card details needed. Duke prepares the cart, applies your details, and opens the secure payment step.</p></div>}
            </section>
          </fieldset>
          <div className={`armed-strip ${armed ? (armedStale ? 'stale' : 'armed') : ''}`}>
            {armed ? <Icon name="check" size={15} /> : <Icon name="lock" size={15} />}
            {armed ? (
              <span>{armed.level === 'standby'
                ? `Armed (standby): ${armed.note ?? 'the product cannot be added to the cart yet.'} Starting at the release moment adds it and checks out.`
                : armedStale
                  ? `Armed for ${armed.product.title} ×${armed.quantity}, but the form changed — a start will prepare from scratch.`
                  : `Armed: cart ready, $${(armed.cart.total / 100).toFixed(2)} delivered — the next matching start skips straight to payment.`}</span>
            ) : (
              <span>Buying at a release moment? Arm the checkout now — session, product, and page are prepared early (even before the product can be added to the cart), so starting later is as fast as possible.</span>
            )}
            {armed
              ? <button type="button" className="text-button" onClick={disarm} disabled={!!busy || active}>Clear</button>
              : <button type="button" className="secondary-button compact" onClick={arm} disabled={!!busy || active || !productUrl || !localOnline}>{busy === 'arm' ? 'Arming…' : 'Arm checkout'}</button>}
          </div>
          <button type="submit" className="visually-hidden" tabIndex={-1}>Start checkout</button>
        </form>
        <RunSummary run={displayedRun} product={product} quantity={Number(quantity) || 1} maxTotal={maxTotal} mode={mode} busy={!!busy || !localOnline} active={active} start={() => { void start(); }} cancel={cancel} focus={focus} resolve={resolveOutcome} />
      </div>
      <RunHistory runs={runs} select={id => { setFocusedId(id); document.querySelector('.summary-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }} />
    </main>
    <footer className="app-footer"><span><span className="footer-mark">d</span> A small tool for fewer steps.</span><span>127.0.0.1 <span>·</span> Built around your browser.</span></footer>
  </div>;
}
