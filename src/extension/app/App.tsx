import { useEffect, useRef, useState } from 'react';
import { STAGES, type ArmedCheckout, type CheckoutRun, type PaymentInput, type ProductInfo, type Profile, type RunMode, type SavedCard, type Stage } from '../../shared/types.ts';
import { DeliveryFields, Field, Icon, PaymentFields, RunHistory, StatusBadge, duration, terminal, type CardForm } from '../../client/components.tsx';
import type { DukeSettings, SessionCard } from '../lib/storage.ts';
import { mergeRuns } from '../../client/run-state.ts';
import { connectRunPort, onEvent, request } from './transport.ts';
import { modeNeedsCard } from '../../shared/validation.ts';

interface BootstrapData {
  settings: DukeSettings;
  profile: Profile | null;
  armed: ArmedCheckout | null;
}

const emptyProfile = (): Profile => ({ name: 'Home delivery', firstName: '', lastName: '', phone: '', deliveryAddress: { line1: '', line2: '', suburb: '', postcode: '', state: 'VIC', country: 'AU' }, billingSame: true });
const emptyCard = (): CardForm => ({ kind: 'new', number: '', expiry: '', cvv: '', cardId: '' });
const money = (cents: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);

const modes: { value: RunMode; label: string; blurb: string }[] = [
  { value: 'prepare', label: 'Prepare checkout', blurb: 'Ready in Chrome. No payment.' },
  { value: 'assist', label: 'Fill card only', blurb: 'Fill the card, you press Pay.' },
  { value: 'purchase', label: 'Purchase automatically', blurb: 'Fill the card and place the order.' },
  { value: 'afterpay', label: 'Afterpay', blurb: 'Open Afterpay for you to complete.' },
];

const stageLabels: Record<Stage, string> = { connect: 'Browser & session', inspect: 'Product & availability', cart: 'Cart & delivery', contact: 'Contact & billing', payment: 'Secure payment', complete: 'Complete' };
const runningStatuses: CheckoutRun['status'][] = ['queued', 'running', 'action_required'];
const isRunning = (run: CheckoutRun) => runningStatuses.includes(run.status);

export default function App() {
  const [settings, setSettings] = useState<DukeSettings | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [productUrl, setProductUrl] = useState('');
  const [product, setProduct] = useState<ProductInfo | null>(null);
  const [armed, setArmed] = useState<ArmedCheckout | null>(null);
  const [card, setCard] = useState<CardForm>(emptyCard);
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [runs, setRuns] = useState<CheckoutRun[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [orderReference, setOrderReference] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [onboarding, setOnboarding] = useState(false);
  const [rememberCard, setRememberCard] = useState(true);
  const [sessionCard, setSessionCard] = useState<SessionCard | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const runsRef = useRef<CheckoutRun[]>([]);
  const requestId = useRef<string | null>(null);
  const runPort = useRef<(() => void) | null>(null);
  const runPortStarted = useRef(false);
  const handledTerminal = useRef<string | null>(null);

  function receiveRuns(incoming: CheckoutRun[]) {
    const next = mergeRuns(runsRef.current, incoming);
    runsRef.current = next;
    setRuns(next);
  }

  useEffect(() => {
    let closed = false;
    // First-run and trigger intents travel in the query string (the service
    // worker opens app.html?onboarding=1&product=<url> from a trigger).
    const params = new URLSearchParams(location.search);
    const productParam = params.get('product');
    if (params.get('onboarding') === '1') setOnboarding(true);
    if (productParam) setProductUrl(productParam);
    const unsubscribe = onEvent(event => {
      if (event.type === 'arm.update') setArmed(event.payload as ArmedCheckout | null);
      else if (event.type === 'run.update') {
        const run = event.payload as CheckoutRun | null;
        if (run && run.id) receiveRuns([run]);
      }
    });
    void request<BootstrapData>('bootstrap.get').then(data => {
      if (closed) return;
      setSettings(data.settings);
      if (data.profile) setProfile(data.profile);
      setArmed(data.armed);
      if (data.armed?.productUrl && !productParam) setProductUrl(data.armed.productUrl);
      setReady(true);
    }).catch(failure => { if (!closed) { setError(failure instanceof Error ? failure.message : 'Could not reach the extension background.'); setReady(true); } });
    void request<CheckoutRun[]>('run.list').then(list => { if (!closed) receiveRuns(list); }).catch(() => undefined);
    void request<SavedCard[]>('cards.list').then(list => { if (!closed && list.length) setCards(list); }).catch(() => undefined);
    void request<SessionCard | null>('card.session.get').then(stored => { if (!closed && stored) setSessionCard(stored); }).catch(() => undefined);
    return () => { closed = true; unsubscribe(); };
  }, []);

  // A remembered card is reused the moment the selected mode needs one, which
  // is what lets a later one-click trigger start without the app form.
  useEffect(() => {
    if (!settings || !sessionCard || !modeNeedsCard(settings.mode)) return;
    setCard(current => (current.number || current.kind === 'saved' ? current : { kind: 'new', number: sessionCard.number, expiry: sessionCard.expiry, cvv: sessionCard.cvv, cardId: '' }));
  }, [settings, sessionCard]);

  const activeRun = runs.find(isRunning);
  const active = !!activeRun;
  const displayedRun = runs.find(run => run.id === (activeRun?.id ?? focusedId));

  useEffect(() => {
    if (!runs.some(isRunning)) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [runs]);

  // The `duke-run` port exists only while a run is in flight. Keep it open from
  // the moment start is requested until the run reaches a terminal state.
  useEffect(() => {
    if (!runPortStarted.current || runs.some(isRunning)) return;
    runPort.current?.();
    runPort.current = null;
    runPortStarted.current = false;
  }, [runs]);

  // Clear the one-run card fields once the focused run finishes, except when the
  // retailer kept them in its own fields (assist-ready) or the outcome is still
  // unknown and a resolution is pending.
  useEffect(() => {
    if (!displayedRun || !terminal(displayedRun) || handledTerminal.current === displayedRun.id) return;
    handledTerminal.current = displayedRun.id;
    const keep = displayedRun.status === 'payment_unknown' || (displayedRun.status === 'ready' && displayedRun.mode === 'assist');
    if (!keep) setCard(current => ({ ...emptyCard(), cardId: current.cardId }));
  }, [displayedRun?.id, displayedRun?.status]);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'This action could not finish. Please try again.'); }
    finally { setBusy(''); }
  }
  const sendProfile = () => ({ ...profile, billingAddress: profile.billingSame ? undefined : profile.billingAddress });

  async function saveSettings() {
    if (!settings) return;
    await run('settings', async () => setSettings(await request<DukeSettings>('settings.put', settings)));
  }
  async function saveProfile() {
    await run('profile', async () => setProfile(await request<Profile>('profile.put', sendProfile())));
  }
  async function inspect() {
    if (!productUrl.trim()) return;
    await run('inspect', async () => setProduct(await request<ProductInfo>('inspect.start', { productUrl: productUrl.trim(), profile: sendProfile() })));
  }
  async function arm() {
    if (!settings) return;
    if (!budgetValid) { setError('Enter a delivered budget between $0.01 and $50,000.'); return; }
    if (!productUrl.trim()) return;
    await run('arm', async () => setArmed(await request<ArmedCheckout>('arm.start', {
      productUrl: productUrl.trim(), quantity: settings.quantity,
      maxTotalCents: Math.round(Number(settings.maxTotalAUD) * 100),
      mode: settings.mode, profile: sendProfile(),
    })));
  }
  async function clearArm() {
    await run('clear', async () => { await request('arm.clear'); setArmed(null); });
  }
  async function refreshCards() {
    await run('cards', async () => setCards(await request<SavedCard[]>('cards.list')));
  }

  // Onboarding: pull the BIG W account's address/contact, persist it as the
  // profile, and show how many saved cards came back.
  async function importBigWProfile() {
    await run('import', async () => {
      const imported = await request<{ profile: Profile; savedCards: SavedCard[]; issues?: Record<string, string> }>('profile.import');
      setCards(imported.savedCards);
      setImportedCount(imported.savedCards.length);
      const issues = imported.issues ?? {};
      if (Object.keys(issues).length) {
        // Show what BIG W returned so the user can correct it (for example an
        // account phone that is not an Australian mobile) before saving.
        setProfile(imported.profile);
        throw Object.assign(
          new Error(`Imported your BIG W details. Fix these before saving: ${Object.values(issues).join(' ')}`),
          { code: 'PROFILE_INCOMPLETE', fields: issues },
        );
      }
      setProfile(await request<Profile>('profile.put', imported.profile));
    });
  }
  // Store the entered card in chrome.storage.session so later one-click runs can
  // use it without the form. Honours the remember checkbox: when the user
  // unticked it, nothing is written and one-click runs ask for the card each time.
  async function rememberSessionCard() {
    if (!rememberCard) return;
    await run('remember', async () => {
      const stored = { number: card.number, expiry: card.expiry, cvv: card.cvv };
      await request('card.session.put', stored);
      setSessionCard(stored);
    });
  }
  function finishSetup() {
    history.replaceState({}, '', location.pathname);
    setOnboarding(false);
  }

  async function start() {
    if (!settings || startDisabled) return;
    runPort.current?.();
    runPort.current = connectRunPort();
    runPortStarted.current = true;
    setBusy('start'); setError('');
    let accepted = false;
    try {
      requestId.current ??= crypto.randomUUID();
      // Persist a new card for this browser session before starting, so a later
      // trigger can reuse it. Best-effort: a storage failure must not stop the run.
      if (cardRequired && card.kind === 'new' && rememberCard && card.number.trim()) {
        await request('card.session.put', { number: card.number, expiry: card.expiry, cvv: card.cvv }).catch(() => undefined);
      }
      const payment: PaymentInput | undefined = cardRequired
        ? (card.kind === 'new' ? { kind: 'new', number: card.number, expiry: card.expiry, cvv: card.cvv } : { kind: 'saved', cardId: card.cardId, cvv: card.cvv })
        : undefined;
      const result = await request<CheckoutRun>('run.start', {
        requestId: requestId.current,
        productUrl: productUrl.trim(),
        quantity: settings.quantity,
        maxTotal: settings.maxTotalAUD,
        mode: settings.mode,
        profile: sendProfile(),
        card: payment,
      });
      accepted = true;
      requestId.current = null;
      setFocusedId(result.id);
      receiveRuns([result]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'This action could not finish. Please try again.');
    } finally {
      setBusy('');
      if (!accepted) { runPort.current?.(); runPort.current = null; runPortStarted.current = false; }
    }
  }
  async function cancel() {
    if (!activeRun) return;
    await run('cancel', async () => receiveRuns([await request<CheckoutRun>('run.cancel', { id: activeRun.id })]));
  }
  async function resolveOutcome(resolution: 'confirmed' | 'not_purchased', orderNumber?: string) {
    if (!displayedRun) return;
    handledTerminal.current = null;
    await run('resolve', async () => receiveRuns([await request<CheckoutRun>('run.resolve', { id: displayedRun.id, resolution, orderNumber })]));
  }

  const profileStale = !!armed && (() => {
    const a = armed.profile;
    const sent = sendProfile();
    return a.name !== sent.name || a.firstName !== sent.firstName || a.lastName !== sent.lastName
      || a.phone !== sent.phone || a.billingSame !== sent.billingSame
      || JSON.stringify(a.deliveryAddress) !== JSON.stringify(sent.deliveryAddress)
      || JSON.stringify(a.billingAddress ?? null) !== JSON.stringify(sent.billingAddress ?? null);
  })();
  const stale = !!armed && (armed.productUrl !== productUrl.trim() || armed.quantity !== settings?.quantity || profileStale);
  const maxTotal = settings?.maxTotalAUD ?? '';
  const budgetValid = /^\d{1,5}(\.\d{1,2})?$/.test(maxTotal) && Number(maxTotal) > 0;
  const mode = settings?.mode ?? 'prepare';
  const cardRequired = modeNeedsCard(mode);
  const cardComplete = card.kind === 'new'
    ? card.number.replace(/\D/g, '').length >= 12 && /^(0[1-9]|1[0-2])\/\d{2}$/.test(card.expiry) && /^\d{3,4}$/.test(card.cvv)
    : !!card.cardId && /^\d{3,4}$/.test(card.cvv);
  const profileComplete = !!profile.firstName.trim() && !!profile.lastName.trim() && !!profile.phone.trim()
    && !!profile.deliveryAddress.line1.trim() && !!profile.deliveryAddress.suburb.trim() && /^\d{4}$/.test(profile.deliveryAddress.postcode);
  const update = (patch: Partial<DukeSettings>) => setSettings(current => (current ? { ...current, ...patch } : current));
  const disabled = !!busy || !ready;
  const startDisabled = disabled || active || !budgetValid || !productUrl.trim() || !profileComplete || (cardRequired && !cardComplete);
  const elapsed = displayedRun ? (terminal(displayedRun) ? displayedRun.elapsedMs : Math.max(0, now - Date.parse(displayedRun.startedAt))) : undefined;

  return <div className="workspace">
    <main>
      {error && <div className="feedback error-feedback" role="alert"><span className="feedback-mark">!</span><div><strong>{error}</strong></div><button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
      <div className="connection-guide"><div className="guide-top"><Icon name="browser" size={18} /><div><strong>Running inside your Chrome</strong><p>The session is local — settings, profile, and history stay on this computer.</p></div></div></div>
      {settings && <>
        {onboarding && <section className="form-section onboarding-panel">
          <div className="section-heading"><span className="section-number">00</span><div><h2>Set up Duke</h2><p>Import your BIG W details, then store a card so one-click runs need no form.</p></div></div>
          <div className="summary-actions">
            <button type="button" className="secondary-button" onClick={() => void importBigWProfile()} disabled={disabled}>{busy === 'import' ? 'Importing…' : 'Import my BIG W profile'}</button>
          </div>
          {importedCount !== null && <p className="fine-print">Imported {importedCount} saved {importedCount === 1 ? 'card' : 'cards'} from your BIG W account.</p>}
          <PaymentFields card={card} setCard={setCard} cards={cards} errors={{}} refresh={() => void refreshCards()} refreshing={busy === 'cards'} />
          <label className="check-row"><input type="checkbox" checked={rememberCard} onChange={event => setRememberCard(event.target.checked)} /><span>Remember this card for this browser session</span></label>
          {!rememberCard && <p className="fine-print">One-click runs will ask for the card each time.</p>}
          <div className="summary-actions">
            <button type="button" className="secondary-button" onClick={() => void rememberSessionCard()} disabled={disabled || !cardComplete || !rememberCard}>{busy === 'remember' ? 'Saving…' : 'Save card for one-click runs'}</button>
            <button type="button" className="primary-button" onClick={finishSetup}>Finish setup</button>
          </div>
        </section>}
        <section className="form-section">
          <div className="section-heading"><span className="section-number">01</span><div><h2>Settings</h2><p>Defaults used by every inspection and checkout.</p></div></div>
          <div className="quantity-budget">
            <Field name="quantity" label="Quantity" value={String(settings.quantity)} onChange={value => update({ quantity: Math.min(20, Math.max(1, Math.round(Number(value) || 1))) })} type="number" min={1} max={20} step={1} inputMode="numeric" required />
            <Field name="maxTotalAUD" label="Maximum delivered total" value={settings.maxTotalAUD} onChange={value => update({ maxTotalAUD: value })} inputMode="decimal" placeholder="0.00" required suffix={<span className="currency-label">AUD</span>} hint="Includes the item and delivery. Never exceeded." />
          </div>
          <div className="mode-options" role="group" aria-label="Execution mode">{modes.map(item => (
            <button key={item.value} type="button" data-mode={item.value} aria-pressed={settings.mode === item.value} className={settings.mode === item.value ? 'mode-option selected' : 'mode-option'} onClick={() => { update({ mode: item.value }); if (!modeNeedsCard(item.value)) setCard(emptyCard()); }}><span className="mode-indicator" /><div><strong>{item.label}</strong><span>{item.blurb}</span></div></button>
          ))}</div>
          <label className="check-row"><input type="checkbox" checked={settings.hoverChip} onChange={event => update({ hoverChip: event.target.checked })} /><span>Show a checkout chip when you hover a BIG W product link on any site</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.autoArm} onChange={event => update({ autoArm: event.target.checked })} /><span>Arm the checkout automatically after an inspection</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.confirmBeforePay} onChange={event => update({ confirmBeforePay: event.target.checked })} /><span>Ask before submitting payment</span></label>
          <label className="check-row"><input type="checkbox" checked={settings.cardClearAfterOrder} onChange={event => update({ cardClearAfterOrder: event.target.checked })} /><span>Clear card details after every order</span></label>
          <button type="button" className="secondary-button" onClick={saveSettings} disabled={disabled}>{busy === 'settings' ? 'Saving…' : 'Save settings'}</button>
        </section>
        <section className="form-section">
          <div className="section-heading"><span className="section-number">02</span><div><h2>The product</h2><p>One product link. One focused checkout.</p></div></div>
          <div className="product-link-row">
            <Field name="productUrl" label="Product URL" value={productUrl} onChange={value => { setProductUrl(value); setProduct(null); }} type="url" placeholder="https://www.bigw.com.au/product/…/p/…" autoComplete="off" required />
            <button type="button" className="inspect-button" onClick={inspect} disabled={disabled || !productUrl}>{busy === 'inspect' ? <span className="spinner dark-spinner" /> : <Icon name="link" size={17} />}<span>{busy === 'inspect' ? 'Checking' : 'Inspect'}</span></button>
          </div>
          {product && <div className={`inspection-result ${product.available ? 'available' : 'unavailable'}`}><Icon name={product.available ? 'check' : 'close'} size={15} /><span>{money(product.priceCents)} · {product.stockLabel}{!product.available ? ' — unavailable for delivery to this address.' : product.deliveryEstimate ? ` · ${product.deliveryEstimate}` : ''}</span></div>}
          <div className={`armed-strip ${armed ? (stale ? 'stale' : 'armed') : ''}`}>
            {armed ? <Icon name="check" size={15} /> : <Icon name="lock" size={15} />}
            <span>{armed
              ? armed.level === 'standby'
                ? `Armed (standby): ${armed.note ?? 'the product cannot be added to the cart yet.'} Starting at the release moment adds it and checks out.`
                : stale
                  ? `Armed for ${armed.product.title} ×${armed.quantity}, but the form changed — starting will prepare from scratch.`
                  : `Armed: cart ready, ${money(armed.cart.total)} delivered — the next matching start skips straight to payment.`
              : 'Buying at a release moment? Arm the checkout now so the session, product, and page are prepared early.'}</span>
            {armed
              ? <button type="button" className="text-button" onClick={clearArm} disabled={disabled}>Clear</button>
              : <button type="button" className="secondary-button compact" onClick={arm} disabled={disabled || !productUrl.trim() || !budgetValid}>{busy === 'arm' ? 'Arming…' : 'Arm checkout'}</button>}
          </div>
        </section>
        <section className="form-section">
          <div className="section-heading"><span className="section-number">03</span><div><h2>Delivery & contact</h2><p>Your details, stored on this computer.</p></div></div>
          <DeliveryFields profile={profile} setProfile={setProfile} errors={{}} />
          <div className="profile-save-row"><button type="button" className="secondary-button" onClick={saveProfile} disabled={disabled} data-action="save-profile">{busy === 'profile' ? 'Saving…' : 'Save profile'}</button><button type="button" className="secondary-button" onClick={() => void importBigWProfile()} disabled={disabled} data-action="import-profile">{busy === 'import' ? 'Importing…' : 'Import from BIG W'}</button></div>
          <p className="fine-print">Contact details stay on this computer. The signed-in BIG W account provides the checkout email.</p>
        </section>
        <section className="form-section">
          <div className="section-heading"><span className="section-number">04</span><div><h2>Start a checkout</h2><p>{cardRequired ? 'Card details are used for this run only.' : 'No card details are needed for this mode.'}</p></div></div>
          {cardRequired
            ? <>
                <PaymentFields card={card} setCard={setCard} cards={cards} errors={{}} refresh={() => void refreshCards()} refreshing={busy === 'cards'} />
                {card.kind === 'new' && <label className="check-row"><input type="checkbox" checked={rememberCard} onChange={event => setRememberCard(event.target.checked)} /><span>Remember this card for this browser session</span></label>}
                {card.kind === 'new' && !rememberCard && <p className="fine-print">One-click runs will ask for the card each time.</p>}
              </>
            : <div className="prepare-note"><Icon name="lock" size={16} /><p>{mode === 'afterpay' ? 'No card needed. Duke prepares the cart, selects Afterpay, and opens Afterpay’s checkout for you to sign in and confirm.' : 'No card details needed. Duke prepares the cart, applies your details, and opens the secure payment step.'}</p></div>}
          <div className="summary-actions">
            <button type="button" className="primary-button start-button" onClick={() => void start()} disabled={startDisabled}><span>{busy === 'start' ? 'Starting…' : mode === 'prepare' ? 'Prepare checkout' : mode === 'assist' ? "Fill card (I'll pay)" : mode === 'afterpay' ? 'Open Afterpay' : 'Purchase automatically'}</span>{busy === 'start' ? <span className="spinner" /> : <Icon name="arrow" size={20} />}</button>
          </div>
          {displayedRun && <div className={`summary-panel run-progress ${displayedRun.status}`} data-run-id={displayedRun.id}>
            <div className="summary-heading"><span className="eyebrow">RUN SUMMARY</span><StatusBadge run={displayedRun} /></div>
            {displayedRun.product && <p className="summary-intro">{displayedRun.product.title} ×{displayedRun.quantity}</p>}
            <div className="progress-header"><span className="eyebrow">CHECKOUT PROGRESS</span>{elapsed !== undefined && <span className="mono elapsed">{duration(elapsed)}</span>}</div>
            <ol className="progress-list" aria-label="Checkout progress" aria-live="polite">{STAGES.map((stage, stageIndex) => {
              const successful = ['ready', 'succeeded'].includes(displayedRun.status);
              const complete = successful || stageIndex < STAGES.indexOf(displayedRun.stage);
              const current = displayedRun.stage === stage && !successful;
              return <li key={stage} className={`${complete ? 'done' : ''} ${current ? 'current' : ''} ${current && displayedRun.status === 'failed' ? 'stopped' : ''}`}><span className="step-marker">{complete ? <Icon name="check" size={11} /> : <span>{stageIndex + 1}</span>}</span><span>{stageLabels[stage]}</span>{current && active && <span className="activity-dot" />}</li>;
            })}</ol>
            {displayedRun.events.length > 0 && <div className={`run-message ${displayedRun.error ? 'message-error' : ''}`} role={displayedRun.error ? 'alert' : 'status'}>{displayedRun.error?.message ?? displayedRun.events.at(-1)?.message}</div>}
            {displayedRun.orderNumber && <div className="order-reference"><span>Order reference</span><strong>{displayedRun.orderNumber}</strong></div>}
            {displayedRun.status === 'payment_unknown' && <div className="resolution-panel">
              <a href="https://www.bigw.com.au/my-account/orders" target="_blank" rel="noreferrer">Check BIG W order history <Icon name="external" size={13} /></a>
              <Field name="orderNumber" label="Confirmed order number" value={orderReference} onChange={setOrderReference} placeholder="From BIG W order history" />
              <button type="button" className="secondary-button resolve-confirmed" disabled={!orderReference.trim() || !!busy} onClick={() => void resolveOutcome('confirmed', orderReference.trim())}>I confirmed the order</button>
              <button type="button" className="text-button resolve-not-purchased" disabled={!!busy} onClick={() => void resolveOutcome('not_purchased')}>It was not purchased</button>
            </div>}
            <div className="summary-actions">
              {active && !activeRun?.paymentSubmittedAt && <button type="button" className="text-button cancel-button" onClick={() => void cancel()} disabled={!!busy}>Cancel this run</button>}
            </div>
          </div>}
        </section>
        <section className="form-section last-section">
          <RunHistory runs={runs} select={id => setFocusedId(id)} />
        </section>
      </>}
    </main>
  </div>;
}
