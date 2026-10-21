import { useEffect, useRef, useState } from 'react';
import { STAGES, type ArmedCheckout, type CheckoutRun, type PaymentInput, type ProductInfo, type Profile, type RunMode, type SavedCard, type Stage } from '../../shared/types.ts';
import { DeliveryFields, Field, Icon, PaymentFields, ProductPreview, RunHistory, StatusBadge, duration, terminal, type CardForm } from '../../client/components.tsx';
import type { DukeSettings, SessionCard } from '../lib/storage.ts';
import { mergeRuns } from '../../client/run-state.ts';
import { connectRunPort, onEvent, request } from './transport.ts';
import { modeNeedsCard } from '../../shared/validation.ts';

interface CardStatus { session: boolean; device: boolean; vaultAvailable: boolean }
interface BootstrapData { settings: DukeSettings; profile: Profile | null; armed: ArmedCheckout | null; card?: CardStatus }
interface CardRecord { card: SessionCard; source: 'session' | 'device' }
interface SessionStatus { available: boolean; authenticated: boolean; tokenSecondsRemaining: number }

const emptyProfile = (): Profile => ({ name: 'Home delivery', firstName: '', lastName: '', phone: '', deliveryAddress: { line1: '', line2: '', suburb: '', postcode: '', state: 'VIC', country: 'AU' }, billingSame: true });
const emptyCard = (): CardForm => ({ kind: 'new', number: '', expiry: '', cvv: '', cardId: '' });
const money = (cents: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
const masked = (card: SessionCard) => `${card.number.replace(/\s/g, '').slice(-4)} · ${card.expiry}`;

const modes: { value: RunMode; label: string; blurb: string }[] = [
  { value: 'purchase', label: 'Purchase automatically', blurb: 'Fill the card and place the order.' },
  { value: 'assist', label: 'Fill card only', blurb: 'Fill the card, you press Pay.' },
  { value: 'prepare', label: 'Prepare checkout', blurb: 'Ready in Chrome. No payment.' },
  { value: 'afterpay', label: 'Afterpay', blurb: 'Open Afterpay for you to complete.' },
];

const stageLabels: Record<Stage, string> = { connect: 'Browser & session', inspect: 'Product & availability', cart: 'Cart & delivery', contact: 'Contact & billing', payment: 'Secure payment', complete: 'Complete' };
const runningStatuses: CheckoutRun['status'][] = ['queued', 'running', 'action_required'];
const isRunning = (run: CheckoutRun) => runningStatuses.includes(run.status);
const setupError = (code?: string) => ['PROFILE_REQUIRED', 'CARD_REQUIRED', 'VALIDATION', 'PROFILE_INCOMPLETE', 'LOGIN_REQUIRED'].includes(code ?? '');

export default function App() {
  const popup = new URLSearchParams(location.search).get('popup') === '1';
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
  const [cardRecord, setCardRecord] = useState<CardRecord | null>(null);
  const [cardStatus, setCardStatus] = useState<CardStatus>({ session: false, device: false, vaultAvailable: true });
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [savedAt, setSavedAt] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const runsRef = useRef<CheckoutRun[]>([]);
  const requestId = useRef<string | null>(null);
  const runPort = useRef<(() => void) | null>(null);
  const runPortStarted = useRef(false);
  const handledTerminal = useRef<string | null>(null);
  const settingsLoaded = useRef<DukeSettings | null>(null);
  const profileLoaded = useRef<Profile | null>(null);

  function receiveRuns(incoming: CheckoutRun[]) {
    const next = mergeRuns(runsRef.current, incoming);
    runsRef.current = next;
    setRuns(next);
  }

  // Derived before the autosave effects: the profile effect reads it as a
  // dependency, so it must exist by the time the hook call is evaluated.
  const profileComplete = !!profile.firstName.trim() && !!profile.lastName.trim() && !!profile.phone.trim()
    && !!profile.deliveryAddress.line1.trim() && !!profile.deliveryAddress.suburb.trim() && /^\d{4}$/.test(profile.deliveryAddress.postcode);

  useEffect(() => {
    let closed = false;
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
      if (data.card) setCardStatus(data.card);
      setReady(true);
    }).catch(failure => { if (!closed) { setError(failure instanceof Error ? failure.message : 'Could not reach the extension background.'); setReady(true); } });
    void request<CheckoutRun[]>('run.list').then(list => { if (!closed) receiveRuns(list); }).catch(() => undefined);
    void request<SavedCard[]>('cards.list').then(list => { if (!closed && list.length) setCards(list); }).catch(() => undefined);
    void request<CardRecord | null>('card.get').then(stored => {
      if (closed || !stored) return;
      setCardRecord(stored);
      setCard({ kind: 'new', number: stored.card.number, expiry: stored.card.expiry, cvv: stored.card.cvv, cardId: '' });
    }).catch(() => undefined);
    void request<SessionStatus>('session.status').then(value => { if (!closed) setSession(value); }).catch(() => undefined);
    return () => { closed = true; unsubscribe(); };
  }, []);

  // Settings save themselves. The explicit Save buttons are gone because a
  // chip run reads storage directly: an unsaved quantity was a real bug.
  useEffect(() => {
    if (!settings) return;
    if (!settingsLoaded.current) { settingsLoaded.current = settings; return; }
    if (JSON.stringify(settings) === JSON.stringify(settingsLoaded.current)) return;
    setSavedAt('saving');
    const timer = setTimeout(() => {
      void request<DukeSettings>('settings.put', settings)
        .then(next => { settingsLoaded.current = next; setSavedAt('saved'); })
        .catch(failure => { setSavedAt('error'); setError(failure instanceof Error ? failure.message : 'Settings could not be saved.'); });
    }, 400);
    return () => clearTimeout(timer);
  }, [settings]);

  // A profile is saved when it is complete, so a half-typed address never
  // overwrites a good one. Field-level errors surface on the next run.
  const profileForSave = (value: Profile) => ({ ...value, billingAddress: value.billingSame ? undefined : value.billingAddress });
  useEffect(() => {
    if (!ready) return;
    if (!profileLoaded.current) { profileLoaded.current = profile; return; }
    if (JSON.stringify(profileForSave(profile)) === JSON.stringify(profileForSave(profileLoaded.current))) return;
    if (!profileComplete) return;
    const timer = setTimeout(() => {
      void request<Profile>('profile.put', profileForSave(profile))
        .then(next => { profileLoaded.current = next; setProfileErrors({}); setSavedAt('saved'); })
        .catch(failure => {
          const fields = (failure as { fields?: Record<string, string> }).fields ?? {};
          setProfileErrors(fields);
          setSavedAt('error');
          if (!Object.keys(fields).length) setError(failure instanceof Error ? failure.message : 'The profile could not be saved.');
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [profile, ready, profileComplete]);

  // A remembered card is prefilled the moment the settings load, which is what
  // lets a later one-click trigger start without the form.
  useEffect(() => {
    if (!settings || !cardRecord || !modeNeedsCard(settings.mode)) return;
    setCard(current => (current.number || current.kind === 'saved' ? current : { kind: 'new', number: cardRecord.card.number, expiry: cardRecord.card.expiry, cvv: cardRecord.card.cvv, cardId: '' }));
  }, [settings, cardRecord]);

  const activeRun = runs.find(isRunning);
  const active = !!activeRun;
  const displayedRun = runs.find(run => run.id === (activeRun?.id ?? focusedId));
  const lastRun = runs[0];

  useEffect(() => {
    if (!runs.some(isRunning)) return;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [runs]);

  useEffect(() => {
    if (!runPortStarted.current || runs.some(isRunning)) return;
    runPort.current?.();
    runPort.current = null;
    runPortStarted.current = false;
  }, [runs]);

  useEffect(() => {
    if (!displayedRun || !terminal(displayedRun) || handledTerminal.current === displayedRun.id) return;
    handledTerminal.current = displayedRun.id;
    const keep = displayedRun.status === 'payment_unknown' || (displayedRun.status === 'ready' && displayedRun.mode === 'assist');
    if (keep) return;
    // Keep the manual start form usable: a saved card is the same card the
    // vault/session already holds, so refill from it instead of making the user
    // press "Update saved card" after every order.
    setCard(current => cardRecord
      ? { kind: 'new', number: cardRecord.card.number, expiry: cardRecord.card.expiry, cvv: cardRecord.card.cvv, cardId: '' }
      : { ...emptyCard(), cardId: current.cardId });
  }, [displayedRun?.id, displayedRun?.status, cardRecord]);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'This action could not finish. Please try again.'); }
    finally { setBusy(''); }
  }
  const sendProfile = () => profileForSave(profile);

  async function refreshCardStatus() {
    const status = await request<CardStatus>('card.status').catch(() => null);
    if (status) setCardStatus(status);
    const stored = await request<CardRecord | null>('card.get').catch(() => null);
    setCardRecord(stored);
  }

  async function saveCardNow(): Promise<void> {
    if (!settings || !card.number.trim()) return;
    await run('card', async () => {
      const result = await request<{ source: 'session' | 'device'; persisted: boolean }>('card.save', {
        card: { number: card.number.replace(/\s/g, ''), expiry: card.expiry, cvv: card.cvv },
        persist: settings.rememberCardOnDevice,
      });
      setCardRecord({ card: { number: card.number, expiry: card.expiry, cvv: card.cvv }, source: result.source });
      await refreshCardStatus();
      if (!result.persisted && settings.rememberCardOnDevice) {
        setError('This browser could not keep the card on this device. It is saved for this browser session only.');
      }
    });
  }

  async function forgetCard() {
    await run('card', async () => {
      await request('card.forget');
      setCard(emptyCard());
      setCardRecord(null);
      await refreshCardStatus();
    });
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
      mode: settings.mode, profile: sendProfile(), replaceCart: settings.replaceCart,
    })));
  }
  async function clearArm() {
    await run('clear', async () => { await request('arm.clear'); setArmed(null); });
  }
  async function refreshCards() {
    await run('cards', async () => setCards(await request<SavedCard[]>('cards.list')));
  }
  async function checkSession() {
    await run('session', async () => setSession(await request<SessionStatus>('session.status')));
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
        setProfile(imported.profile);
        setProfileErrors(issues);
        throw Object.assign(
          new Error(`Imported your BIG W details. Fix these before saving: ${Object.values(issues).join(' ')}`),
          { code: 'PROFILE_INCOMPLETE', fields: issues },
        );
      }
      setProfile(await request<Profile>('profile.put', imported.profile));
      profileLoaded.current = imported.profile;
    });
  }
  async function finishSetup() {
    // Flush what autosave may not have written yet, then leave onboarding.
    await request('settings.put', settings).catch(() => undefined);
    if (profileComplete) await request('profile.put', profileForSave(profile)).catch(() => undefined);
    history.replaceState({}, '', location.pathname);
    setOnboarding(false);
    await refreshCardStatus();
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
      // Persist a new card before starting, so a later chip trigger can reuse
      // it. Best-effort: a storage failure must not stop the run.
      if (cardRequired && card.kind === 'new' && card.number.trim()) {
        await request('card.save', {
          card: { number: card.number.replace(/\s/g, ''), expiry: card.expiry, cvv: card.cvv },
          persist: settings.rememberCardOnDevice,
        }).catch(() => undefined);
        await refreshCardStatus();
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
        replaceCart: settings.replaceCart,
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
  const update = (patch: Partial<DukeSettings>) => setSettings(current => (current ? { ...current, ...patch } : current));
  // Turning the device vault off removes the on-disk copy immediately; the
  // session copy (and any card the user is editing) stays until it is saved or
  // forgotten.
  const setRememberOnDevice = (value: boolean) => {
    update({ rememberCardOnDevice: value });
    if (!value && cardStatus.device) {
      void request<CardStatus>('card.device.clear')
        .then(status => { if (status) setCardStatus(status); return refreshCardStatus(); })
        .catch(() => undefined);
    }
  };
  const disabled = !!busy || !ready;
  const startDisabled = disabled || active || !budgetValid || !productUrl.trim() || !profileComplete || (cardRequired && !cardComplete);
  const elapsed = displayedRun ? (terminal(displayedRun) ? displayedRun.elapsedMs : Math.max(0, now - Date.parse(displayedRun.startedAt))) : undefined;
  const cardSource = cardStatus.device ? 'device' : cardRecord?.source ?? null;
  const readyForOneClick = profileComplete && !!cardSource && !!session?.authenticated;
  const needs: string[] = [
    ...(profileComplete ? [] : ['delivery details']),
    ...(cardSource ? [] : ['a card']),
    ...(session?.authenticated ? [] : ['a signed-in BIG W tab']),
  ];

  if (popup) {
    return <div className="popup-workspace">
      <header className="popup-header">
        <span className="popup-mark">d</span>
        <div><strong>Duke</strong><span>BIG W one-click checkout</span></div>
        <span className={`ready-dot ${readyForOneClick ? 'ok' : 'warn'}`} aria-hidden="true" />
      </header>
      <div className="popup-hero">
        <h2>{readyForOneClick ? 'Ready to check out.' : needs.length ? 'A little setup left.' : 'Checking your session…'}</h2>
        <p>{readyForOneClick ? 'Hover a BIG W product link and press Checkout. Duke handles the cart, contact, and checkout locally.' : needs.length ? `Still needed: ${needs.join(', ')}.` : 'Reading your BIG W session…'}</p>
      </div>
      {error && <div className="feedback error-feedback" role="alert"><span className="feedback-mark">!</span><div><strong>{error}</strong></div></div>}
      <div className="popup-status-card">
        <Readiness profileComplete={profileComplete} cardSource={cardSource} session={session} />
      </div>
      {settings && <div className="popup-toggles">
        <label className="check-row switch-row"><input type="checkbox" checked={settings.hoverChip} onChange={event => update({ hoverChip: event.target.checked })} /><span>Checkout card on product links</span></label>
        <label className="check-row switch-row"><input type="checkbox" checked={settings.inlineBadges} onChange={event => update({ inlineBadges: event.target.checked })} /><span>“Duke” badge next to links</span></label>
        <label className="check-row switch-row"><input type="checkbox" checked={settings.autoArm} onChange={event => update({ autoArm: event.target.checked })} /><span>Arm automatically on product pages</span></label>
      </div>}
      {lastRun && <div className="popup-last">
        <span className="eyebrow">Last run</span>
        <div><strong>{lastRun.product?.title ?? `Article ${lastRun.productCode}`}</strong><StatusBadge run={lastRun} /></div>
        <span>{lastRun.quantity} × · {new Date(lastRun.startedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
      </div>}
      <div className="popup-actions">
        <button type="button" className="primary-button" onClick={() => { void chrome.runtime.openOptionsPage(); }}>Open Duke settings <Icon name="arrow" size={17} /></button>
      </div>
      <p className="popup-hint">Hover any BIG W product link on any page for the checkout card.</p>
    </div>;
  }

  const modeLabel = ({ prepare: 'Prepare', assist: 'Fill card', purchase: 'Purchase', afterpay: 'Afterpay' } as Record<RunMode, string>)[mode];
  const moneyLimit = budgetValid ? money(Math.round(Number(maxTotal) * 100)) : 'Not set';

  return <div className="app-shell">
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div><strong>Duke</strong><span>BIG W one-click checkout</span></div>
        </div>
        <div className="topbar-right">
          <span className={`topbar-status ${readyForOneClick ? 'ok' : 'warn'}`}><span className="status-dot" aria-hidden="true" />{readyForOneClick ? 'Ready' : needs.length ? `${needs.length} to fix` : 'Checking…'}</span>
          {savedAt !== 'idle' && <span className={`save-state ${savedAt}`}>{savedAt === 'saving' ? 'Saving…' : savedAt === 'saved' ? 'Saved' : 'Not saved'}</span>}
        </div>
      </div>
    </header>

    <main className="app-main">
      {error && <div className="feedback error-feedback" role="alert"><span className="feedback-mark">!</span><div><strong>{error}</strong></div><button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><Icon name="spark" size={13} /> One-click BIG W checkout</span>
          <h1>{readyForOneClick ? 'You’re ready to check out.' : needs.length ? 'A little setup, then one click.' : 'Checking your session…'}</h1>
          <p className="hero-sub">Hover any BIG W product link, choose a quantity, and Duke prepares the cart, contact details, and checkout — locally in your Chrome. No server, no second browser.</p>
          <div className="hero-actions">
            <button type="button" className="secondary-button" onClick={() => void checkSession()} disabled={disabled}>{busy === 'session' ? <span className="spinner dark-spinner" /> : <Icon name="browser" size={16} />}{busy === 'session' ? 'Checking…' : 'Check BIG W session'}</button>
            <button type="button" className="text-button" onClick={() => document.getElementById('checkout-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Start with a link <Icon name="arrow" size={15} /></button>
          </div>
        </div>
        <aside className="hero-card">
          <div className="hero-card-head">
            <strong>{readyForOneClick ? 'Ready for one-click' : 'One-click setup'}</strong>
            <span className={`ready-pill ${readyForOneClick ? 'ok' : 'warn'}`}><span className="ready-dot" aria-hidden="true" />{readyForOneClick ? 'Ready' : needs.length ? `${needs.length} to fix` : 'Checking'}</span>
          </div>
          <Readiness profileComplete={profileComplete} cardSource={cardSource} session={session} />
          <div className="hero-card-foot"><Icon name="lock" size={13} /> Local to this Chrome <span className={`save-state ${savedAt}`}>{savedAt === 'saving' ? 'Saving…' : savedAt === 'saved' ? 'Saved' : ''}</span></div>
        </aside>
      </section>

      {settings && <>
        <div className="layout-grid">
          <div className="main-col">
            {onboarding && <section className="panel onboarding-panel">
              <div className="section-heading"><span className="section-icon"><Icon name="spark" size={18} /></span><div><h2>Set up Duke</h2><p>Import your BIG W details, then store a card so one-click runs need no form.</p></div></div>
              <div className="summary-actions">
                <button type="button" className="secondary-button" onClick={() => void importBigWProfile()} disabled={disabled}>{busy === 'import' ? 'Importing…' : 'Import my BIG W profile'}</button>
              </div>
              {importedCount !== null && <p className="fine-print">Imported {importedCount} saved {importedCount === 1 ? 'card' : 'cards'} from your BIG W account.</p>}
              <PaymentFields card={card} setCard={setCard} cards={cards} errors={{}} refresh={() => void refreshCards()} refreshing={busy === 'cards'} />
              <label className="check-row switch-row"><input type="checkbox" checked={settings.rememberCardOnDevice} onChange={event => setRememberOnDevice(event.target.checked)} /><span>Keep this card ready on this device (encrypted)</span></label>
              <div className="summary-actions">
                <button type="button" className="secondary-button" onClick={() => void saveCardNow()} disabled={disabled || !cardComplete || busy === 'card'}>{busy === 'card' ? 'Saving…' : 'Save card for one-click runs'}</button>
                <button type="button" className="primary-button" onClick={finishSetup}>Finish setup</button>
              </div>
            </section>}

            <section className="panel">
              <div className="section-heading"><span className="section-icon"><Icon name="user" size={18} /></span><div><h2>Delivery & contact</h2><p>Imported from BIG W or entered once. Saved on this computer.</p></div></div>
              <DeliveryFields profile={profile} setProfile={setProfile} errors={profileErrors} />
              <div className="profile-save-row"><button type="button" className="secondary-button" onClick={() => void importBigWProfile()} disabled={disabled} data-action="import-profile">{busy === 'import' ? 'Importing…' : 'Import from BIG W'}</button><span className="fine-print">Changes save automatically.</span></div>
              <p className="fine-print">Contact details stay on this computer. The signed-in BIG W account provides the checkout email.</p>
            </section>

            <section className="panel">
              <div className="section-heading"><span className="section-icon"><Icon name="card" size={18} /></span><div><h2>Payment</h2><p>{cardSource ? (cardSource === 'device' ? 'A card is ready — sealed on this device.' : 'A card is ready for this browser session.') : 'One card is enough for every one-click run.'}</p></div></div>
              {cardSource && cardRecord && <div className="card-status"><Icon name="lock" size={15} /><span>Card •••• {masked(cardRecord.card)}{cardSource === 'device' ? ' · encrypted on this device' : ' · this browser session only'}</span><button type="button" className="text-button" onClick={() => void forgetCard()} disabled={disabled}>Forget</button></div>}
              <PaymentFields card={card} setCard={setCard} cards={cards} errors={{}} refresh={() => void refreshCards()} refreshing={busy === 'cards'} />
              <div className="card-controls">
                <label className="check-row switch-row"><input type="checkbox" checked={settings.rememberCardOnDevice} onChange={event => setRememberOnDevice(event.target.checked)} /><span>Keep this card ready on this device (encrypted at rest)</span></label>
                <div className="summary-actions">
                  <button type="button" className="secondary-button" onClick={() => void saveCardNow()} disabled={disabled || !cardComplete || busy === 'card'}>{busy === 'card' ? 'Saving…' : cardSource ? 'Update saved card' : 'Save card for one-click'}</button>
                </div>
              </div>
              <p className="fine-print">{settings.rememberCardOnDevice
                ? (cardStatus.vaultAvailable ? 'The card is sealed with a non-extractable device key. “Forget” removes it completely.' : 'This browser cannot keep the card across restarts; it stays for this session only.')
                : 'The card is kept in memory for this browser session and cleared when Chrome closes.'}</p>
            </section>

            <section className="panel">
              <div className="section-heading"><span className="section-icon"><Icon name="sliders" size={18} /></span><div><h2>Checkout defaults</h2><p>What the hover card and this page use.</p></div></div>
              <div className="quantity-budget">
                <Field name="quantity" label="Quantity" value={String(settings.quantity)} onChange={value => update({ quantity: Math.min(20, Math.max(1, Math.round(Number(value) || 1))) })} type="number" min={1} max={20} step={1} inputMode="numeric" required hint="The card starts here and remembers your last choice." />
                <Field name="maxTotalAUD" label="Maximum delivered total" value={settings.maxTotalAUD} onChange={value => update({ maxTotalAUD: value })} inputMode="decimal" placeholder="0.00" required suffix={<span className="currency-label">AUD</span>} hint="Includes the item and delivery. Never exceeded." />
              </div>
              <div className="mode-options" role="group" aria-label="Execution mode">{modes.map(item => (
                <button key={item.value} type="button" data-mode={item.value} aria-pressed={settings.mode === item.value} className={settings.mode === item.value ? 'mode-option selected' : 'mode-option'} onClick={() => { update({ mode: item.value }); if (!modeNeedsCard(item.value)) setCard(emptyCard()); }}><span className="mode-indicator" /><div><strong>{item.label}</strong><span>{item.blurb}</span></div></button>
              ))}</div>
              <div className="toggle-grid">
                <label className="check-row switch-row"><input type="checkbox" checked={settings.hoverChip} onChange={event => update({ hoverChip: event.target.checked })} /><span>Show the checkout card when hovering a BIG W product link on any site</span></label>
                <label className="check-row switch-row"><input type="checkbox" checked={settings.inlineBadges} onChange={event => update({ inlineBadges: event.target.checked })} /><span>Mark BIG W product links with a small “Duke” badge</span></label>
                <label className="check-row switch-row"><input type="checkbox" checked={settings.autoArm} onChange={event => update({ autoArm: event.target.checked })} /><span>Arm the checkout automatically after opening a product page</span></label>
                <label className="check-row switch-row"><input type="checkbox" checked={settings.confirmBeforePay} onChange={event => update({ confirmBeforePay: event.target.checked })} /><span>Fill the card but let me press Pay (no automatic submit)</span></label>
                <label className="check-row switch-row"><input type="checkbox" checked={settings.cardClearAfterOrder} onChange={event => update({ cardClearAfterOrder: event.target.checked })} /><span>Forget the session card after every order</span></label>
                <label className="check-row switch-row"><input type="checkbox" checked={settings.replaceCart} onChange={event => update({ replaceCart: event.target.checked })} /><span>Replace other items in my BIG W cart with the one-click product</span></label>
              </div>
              <p className="fine-print">BIG W keeps one cart per account. With replacement on, a one-click checkout makes that cart contain exactly the product and quantity you chose; anything else in it is removed. Turn it off to be stopped instead.</p>
            </section>
          </div>

          <aside className="rail">
            <section className="panel checkout-panel" id="checkout-panel">
              <div className="section-heading"><span className="section-icon"><Icon name="link" size={18} /></span><div><h2>Checkout</h2><p>Start now, or hover any product link.</p></div></div>
              <div className="summary-strip">
                <div><span>Quantity</span><strong>×{settings.quantity}</strong></div>
                <div><span>Mode</span><strong>{modeLabel}</strong></div>
                <div><span>Limit</span><strong>{moneyLimit}</strong></div>
              </div>
              <div className="product-link-row">
                <Field name="productUrl" label="Product URL" value={productUrl} onChange={value => { setProductUrl(value); setProduct(null); }} type="url" placeholder="bigw.com.au/product/…/p/…" autoComplete="off" required />
                <button type="button" className="inspect-button" onClick={inspect} disabled={disabled || !productUrl}>{busy === 'inspect' ? <span className="spinner dark-spinner" /> : <Icon name="link" size={17} />}<span>{busy === 'inspect' ? 'Checking' : 'Inspect'}</span></button>
              </div>
              {product && <div className="selected-product" style={{ marginTop: 12 }}>
                <ProductPreview product={product} quantity={settings.quantity} compact />
                <div className={`inspection-result ${product.available ? 'available' : 'unavailable'}`}><Icon name={product.available ? 'check' : 'close'} size={14} /><span>{money(product.priceCents)} · {product.stockLabel}{!product.available ? ' — unavailable for delivery to this address.' : product.deliveryEstimate ? ` · ${product.deliveryEstimate}` : ''}</span></div>
              </div>}
              <div className={`armed-strip ${armed ? (stale ? 'stale' : 'armed') : ''}`}>
                {armed ? <Icon name="check" size={15} /> : <Icon name="lock" size={15} />}
                <span>{armed
                  ? armed.level === 'standby'
                    ? `Armed (standby): ${armed.note ?? 'the product cannot be added to the cart yet.'} Starting at the release moment adds it and checks out.`
                    : stale
                      ? `Armed for ${armed.product.title} ×${armed.quantity}, but the form changed — starting will prepare from scratch.`
                      : `Armed: cart ready, ${money(armed.cart.total)} delivered — the next matching start skips straight to payment.`
                  : 'Buying at a release moment? Arm now so the session, product, and page are ready early.'}</span>
                {armed
                  ? <button type="button" className="text-button" onClick={clearArm} disabled={disabled}>Clear</button>
                  : <button type="button" className="secondary-button compact" onClick={arm} disabled={disabled || !productUrl.trim() || !budgetValid}>{busy === 'arm' ? 'Arming…' : 'Arm'}</button>}
              </div>
              <div className="summary-actions">
                <button type="button" className="primary-button start-button" onClick={() => void start()} disabled={startDisabled}><span>{busy === 'start' ? 'Starting…' : mode === 'prepare' ? 'Prepare checkout' : mode === 'assist' ? "Fill card (I'll pay)" : mode === 'afterpay' ? 'Open Afterpay' : 'Purchase automatically'}</span>{busy === 'start' ? <span className="spinner" /> : <Icon name="arrow" size={20} />}</button>
              </div>
              {displayedRun && <div className={`summary-panel run-progress ${displayedRun.status}`} data-run-id={displayedRun.id}>
                <div className="summary-heading"><span className="eyebrow">Run summary</span><StatusBadge run={displayedRun} /></div>
                {displayedRun.product && <p className="summary-intro">{displayedRun.product.title} ×{displayedRun.quantity}</p>}
                <div className="progress-header"><span className="eyebrow">Progress</span>{elapsed !== undefined && <span className="mono elapsed">{duration(elapsed)}</span>}</div>
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
                {displayedRun.error && setupError(displayedRun.error.code) && <p className="fine-print">Fix this above, then start again. Duke never opened a settings tab behind your back.</p>}
                <div className="summary-actions">
                  {active && !activeRun?.paymentSubmittedAt && <button type="button" className="text-button cancel-button" onClick={() => void cancel()} disabled={!!busy}>Cancel this run</button>}
                </div>
              </div>}
            </section>
          </aside>
        </div>

        <section className="panel history-panel">
          <RunHistory runs={runs} select={id => setFocusedId(id)} />
        </section>
      </>}
    </main>
  </div>;
}

function Readiness({ profileComplete, cardSource, session }: { profileComplete: boolean; cardSource: 'session' | 'device' | null; session: SessionStatus | null }) {
  const items: Array<{ label: string; detail: string; ok: boolean }> = [
    { label: 'Delivery & contact', detail: profileComplete ? 'Ready' : 'Add your name, phone and address', ok: profileComplete },
    { label: 'Payment card', detail: cardSource === 'device' ? 'Saved on this device' : cardSource === 'session' ? 'Saved for this session' : 'Add a card for one-click', ok: !!cardSource },
    { label: 'BIG W session', detail: session?.authenticated ? 'Signed in' : session?.available ? 'Open BIG W and sign in' : 'No BIG W tab open', ok: !!session?.authenticated },
  ];
  return <div className="readiness">
    {items.map(item => <div key={item.label} className={`readiness-item ${item.ok ? 'ok' : 'warn'}`}><span className="readiness-mark">{item.ok ? <Icon name="check" size={12} /> : '!'}</span><div><strong>{item.label}</strong><span>{item.detail}</span></div></div>)}
  </div>;
}
