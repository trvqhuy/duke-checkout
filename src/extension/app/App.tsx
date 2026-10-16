import { useEffect, useState } from 'react';
import type { ArmedCheckout, ProductInfo, Profile, RunMode } from '../../shared/types.ts';
import { DeliveryFields, Field, Icon } from '../../client/components.tsx';
import type { DukeSettings } from '../lib/storage.ts';
import { onEvent, request } from './transport.ts';

interface BootstrapData {
  settings: DukeSettings;
  profile: Profile | null;
  history: { id: string; status: string; startedAt?: string }[];
  armed: ArmedCheckout | null;
}

const emptyProfile = (): Profile => ({ name: 'Home delivery', firstName: '', lastName: '', phone: '', deliveryAddress: { line1: '', line2: '', suburb: '', postcode: '', state: 'VIC', country: 'AU' }, billingSame: true });
const money = (cents: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);

const modes: { value: RunMode; label: string; blurb: string }[] = [
  { value: 'prepare', label: 'Prepare checkout', blurb: 'Ready in Chrome. No payment.' },
  { value: 'assist', label: 'Fill card only', blurb: 'Fill the card, you press Pay.' },
  { value: 'purchase', label: 'Purchase automatically', blurb: 'Fill the card and place the order.' },
  { value: 'afterpay', label: 'Afterpay', blurb: 'Open Afterpay for you to complete.' },
];

export default function App() {
  const [settings, setSettings] = useState<DukeSettings | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [productUrl, setProductUrl] = useState('');
  const [product, setProduct] = useState<ProductInfo | null>(null);
  const [armed, setArmed] = useState<ArmedCheckout | null>(null);
  const [history, setHistory] = useState<BootstrapData['history']>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let closed = false;
    const unsubscribe = onEvent(event => { if (event.type === 'arm.update') setArmed(event.payload as ArmedCheckout | null); });
    void request<BootstrapData>('bootstrap.get').then(data => {
      if (closed) return;
      setSettings(data.settings);
      if (data.profile) setProfile(data.profile);
      setHistory(data.history);
      setArmed(data.armed);
      if (data.armed?.productUrl && !productUrl) setProductUrl(data.armed.productUrl);
      setReady(true);
    }).catch(failure => { if (!closed) { setError(failure instanceof Error ? failure.message : 'Could not reach the extension background.'); setReady(true); } });
    return () => { closed = true; unsubscribe(); };
  }, []);

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
  const update = (patch: Partial<DukeSettings>) => setSettings(current => (current ? { ...current, ...patch } : current));
  const disabled = !!busy || !ready;

  return <div className="workspace">
    <main>
      {error && <div className="feedback error-feedback" role="alert"><span className="feedback-mark">!</span><div><strong>{error}</strong></div><button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
      <div className="connection-guide"><div className="guide-top"><Icon name="browser" size={18} /><div><strong>Running inside your Chrome</strong><p>The session is local — settings, profile, and history stay on this computer.</p></div></div></div>
      {settings && <>
        <section className="form-section">
          <div className="section-heading"><span className="section-number">01</span><div><h2>Settings</h2><p>Defaults used by every inspection and checkout.</p></div></div>
          <div className="quantity-budget">
            <Field name="quantity" label="Quantity" value={String(settings.quantity)} onChange={value => update({ quantity: Math.min(20, Math.max(1, Math.round(Number(value) || 1))) })} type="number" min={1} max={20} step={1} inputMode="numeric" required />
            <Field name="maxTotalAUD" label="Maximum delivered total" value={settings.maxTotalAUD} onChange={value => update({ maxTotalAUD: value })} inputMode="decimal" placeholder="0.00" required suffix={<span className="currency-label">AUD</span>} hint="Includes the item and delivery. Never exceeded." />
          </div>
          <div className="mode-options" role="group" aria-label="Execution mode">{modes.map(item => (
            <button key={item.value} type="button" aria-pressed={settings.mode === item.value} className={settings.mode === item.value ? 'mode-option selected' : 'mode-option'} onClick={() => update({ mode: item.value })}><span className="mode-indicator" /><div><strong>{item.label}</strong><span>{item.blurb}</span></div></button>
          ))}</div>
          <label className="check-row"><input type="checkbox" checked={settings.hoverChip} onChange={event => update({ hoverChip: event.target.checked })} /><span>Show the Duke hover chip on BIG W product pages</span></label>
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
          <div className="profile-save-row"><button type="button" className="secondary-button" onClick={saveProfile} disabled={disabled}>{busy === 'profile' ? 'Saving…' : 'Save profile'}</button></div>
          <p className="fine-print">Contact details stay on this computer. The signed-in BIG W account provides the checkout email.</p>
        </section>
        <section className="form-section last-section">
          <div className="section-heading"><span className="section-number">04</span><div><h2>Runs</h2><p>Checkout runs arrive in stage 2.</p></div></div>
          {history.length
            ? <ul className="history-list">{history.slice(0, 8).map(entry => <li key={entry.id}><span className="mono">{entry.id.slice(0, 8)}</span><span>{entry.status}</span><span>{entry.startedAt ? new Date(entry.startedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span></li>)}</ul>
            : <p className="fine-print">No runs yet.</p>}
        </section>
      </>}
    </main>
  </div>;
}
