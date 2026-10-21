import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { STAGES, type Address, type CheckoutRun, type ProductInfo, type Profile, type RunMode, type SavedCard } from '../shared/types.ts';

export function Icon({ name, size = 18 }: { name: 'arrow' | 'check' | 'browser' | 'link' | 'close' | 'edit' | 'lock' | 'plus' | 'external' | 'eye' | 'user' | 'card' | 'sliders' | 'clock' | 'shield' | 'spark' | 'store'; size?: number }) {
  const paths: Record<string, ReactNode> = {
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    browser: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.1M10 6.5h.1" /></>,
    link: <><path d="m10 14 4-4m-5 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 8a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    edit: <><path d="m15 4 5 5-11 11H4v-5L15 4Zm-3 3 5 5" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    external: <><path d="M14 3h7v7m0-7L10 14" /><path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5" /></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
    card: <><rect x="2.5" y="5" width="19" height="14" rx="3" /><path d="M2.5 10h19" /><path d="M6 15h4" /></>,
    sliders: <><path d="M4 7h9m4 0h3M4 17h3m4 0h9" /><circle cx="15" cy="7" r="2.2" /><circle cx="9" cy="17" r="2.2" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    shield: <><path d="M12 3.5 19 6v5.2c0 4.4-2.9 7.6-7 9.3-4.1-1.7-7-4.9-7-9.3V6l7-2.5Z" /><path d="m9.2 12 2 2 3.8-4" /></>,
    spark: <><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" /><path d="M18.5 16.5 19 18l1.5.5-1.5.5-.5 1.5-.5-1.5L16.5 18l1.5-.5.5-1Z" /></>,
    store: <><path d="M3.5 9.5 5 4h14l1.5 5.5" /><path d="M4 9.5h16V20H4z" /><path d="M9.5 20v-6h5v6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export const money = (cents: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
export const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const terminal = (run: CheckoutRun) => ['ready', 'succeeded', 'failed', 'cancelled', 'payment_unknown'].includes(run.status);

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  name: string; label: string; value: string; onChange(value: string): void; errors?: Record<string, string>; hint?: string; suffix?: ReactNode;
}
export function Field({ name, label, value, onChange, errors = {}, hint, suffix, className = '', ...props }: FieldProps) {
  const id = `field-${name.replace(/\./g, '-')}`, error = errors[name];
  return <div className={`field ${error ? 'has-error' : ''} ${className}`}>
    <label htmlFor={id}>{label}{props.required && <span className="required-mark" aria-hidden="true">*</span>}</label>
    <div className={`input-wrap ${suffix ? 'with-suffix' : ''}`}>
      <input {...props} id={id} name={name} value={value} onChange={event => onChange(event.target.value)} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} />
      {suffix && <span className="input-suffix">{suffix}</span>}
    </div>
    {error ? <span className="field-error" id={`${id}-error`}>{error}</span> : hint && <span className="field-hint" id={`${id}-hint`}>{hint}</span>}
  </div>;
}

export function AddressFields({ address, onChange, prefix, errors }: { address: Address; onChange(value: Address): void; prefix: string; errors: Record<string, string> }) {
  const set = (key: keyof Address, value: string) => onChange({ ...address, [key]: value });
  return <div className="address-fields">
    <Field name={`${prefix}.line1`} label="Street address" value={address.line1} onChange={value => set('line1', value)} autoComplete={prefix.startsWith('billing') ? 'billing address-line1' : 'shipping address-line1'} required errors={errors} />
    <Field name={`${prefix}.line2`} label="Apartment, unit, etc." value={address.line2} onChange={value => set('line2', value)} autoComplete={prefix.startsWith('billing') ? 'billing address-line2' : 'shipping address-line2'} placeholder="Optional" errors={errors} />
    <div className="address-bottom">
      <Field name={`${prefix}.suburb`} label="Suburb / town" value={address.suburb} onChange={value => set('suburb', value)} autoComplete="address-level2" required errors={errors} />
      <div className={`field ${errors[`${prefix}.state`] ? 'has-error' : ''}`}>
        <label htmlFor={`${prefix}-state`}>State <span className="required-mark" aria-hidden="true">*</span></label>
        <select id={`${prefix}-state`} name={`${prefix}.state`} value={address.state} onChange={event => set('state', event.target.value)} autoComplete="address-level1" aria-invalid={!!errors[`${prefix}.state`]}>
          {['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'].map(state => <option key={state}>{state}</option>)}
        </select>
        {errors[`${prefix}.state`] && <span className="field-error">{errors[`${prefix}.state`]}</span>}
      </div>
      <Field name={`${prefix}.postcode`} label="Postcode" value={address.postcode} onChange={value => set('postcode', value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" autoComplete="postal-code" maxLength={4} required errors={errors} />
    </div>
  </div>;
}

export function DeliveryFields({ profile, setProfile, errors }: { profile: Profile; setProfile(value: Profile): void; errors: Record<string, string> }) {
  return <>
    <div className="recipient-grid">
      <Field name="firstName" label="First name" value={profile.firstName} onChange={firstName => setProfile({ ...profile, firstName })} autoComplete="given-name" required errors={errors} />
      <Field name="lastName" label="Last name" value={profile.lastName} onChange={lastName => setProfile({ ...profile, lastName })} autoComplete="family-name" required errors={errors} />
    </div>
    <Field name="phone" label="Australian delivery phone" value={profile.phone} onChange={phone => setProfile({ ...profile, phone })} type="tel" autoComplete="tel" placeholder="04xx xxx xxx or +61" required hint="An Australian contact number is required by BIG W." errors={errors} />
    <AddressFields prefix="deliveryAddress" address={profile.deliveryAddress} onChange={deliveryAddress => setProfile({ ...profile, deliveryAddress })} errors={errors} />
    <label className="check-row"><input type="checkbox" checked={profile.billingSame} onChange={event => setProfile({ ...profile, billingSame: event.target.checked, billingAddress: profile.billingAddress ?? { ...profile.deliveryAddress } })} /><span>Use delivery address for billing</span></label>
    {!profile.billingSame && <div className="billing-fields"><h4>Billing address</h4><AddressFields prefix="billingAddress" address={profile.billingAddress ?? profile.deliveryAddress} onChange={billingAddress => setProfile({ ...profile, billingAddress })} errors={errors} />{errors.billingAddress && <p className="field-error">{errors.billingAddress}</p>}</div>}
  </>;
}

export interface CardForm { kind: 'new' | 'saved'; number: string; expiry: string; cvv: string; cardId: string }
export function PaymentFields({ card, setCard, cards, errors, refresh, refreshing }: { card: CardForm; setCard(value: CardForm): void; cards: SavedCard[]; errors: Record<string, string>; refresh(): void; refreshing: boolean }) {
  const [show, setShow] = useState(false);
  return <div className="payment-fields">
    <div className="payment-choice-row">
      <div className="small-segment" role="group" aria-label="Card source"><button type="button" className={card.kind === 'new' ? 'selected' : ''} onClick={() => setCard({ ...card, kind: 'new', cvv: '' })}>New card</button><button type="button" className={card.kind === 'saved' ? 'selected' : ''} onClick={() => setCard({ ...card, kind: 'saved', cvv: '', cardId: card.cardId || cards[0]?.id || '' })}>Saved card</button></div>
      <span className="subtle-label"><Icon name="lock" size={13} /> Wpay secure fields</span>
    </div>
    {card.kind === 'new' ? <>
      <Field name="card.number" label="Card number" value={card.number} onChange={number => setCard({ ...card, number: number.replace(/[^\d -]/g, '').slice(0, 23) })} type={show ? 'text' : 'password'} inputMode="numeric" autoComplete="cc-number" placeholder="Card number" required errors={errors} suffix={<button type="button" className="icon-button" onClick={() => setShow(!show)} aria-label={show ? 'Hide card number' : 'Show card number'} aria-pressed={show}><Icon name="eye" size={17} /></button>} />
      <div className="card-bottom">
        <Field name="card.expiry" label="Expiry date" value={card.expiry} onChange={value => { const digits = value.replace(/\D/g, ''); const normalized = digits.length >= 6 ? digits.slice(0, 2) + digits.slice(-2) : digits.slice(0, 4); setCard({ ...card, expiry: normalized.length > 2 ? normalized.slice(0, 2) + '/' + normalized.slice(2) : normalized }); }} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" required errors={errors} />
        <Field name="card.cvv" label="Security code" value={card.cvv} onChange={cvv => setCard({ ...card, cvv: cvv.replace(/\D/g, '').slice(0, 4) })} type="password" inputMode="numeric" autoComplete="cc-csc" placeholder="CVV" maxLength={4} required errors={errors} />
      </div>
      <p className="fine-print">Filled into BIG W’s Wpay secure fields. BIG W’s current checkout saves new cards to your retailer account. Duke keeps the card only when you ask it to, and never in run history.</p>
    </> : <>
      <div className="field"><label htmlFor="saved-card">BIG W saved card</label><select id="saved-card" value={card.cardId} onChange={event => setCard({ ...card, cardId: event.target.value })} aria-invalid={!!errors['card.cardId']}><option value="">{cards.length ? 'Choose a saved card' : 'No cards loaded'}</option>{cards.map(saved => <option value={saved.id} key={saved.id}>{saved.brand} ending {saved.last4}</option>)}</select>{errors['card.cardId'] && <span className="field-error">{errors['card.cardId']}</span>}</div>
      <div className="saved-card-bottom"><Field name="card.cvv" label="Security code" value={card.cvv} onChange={cvv => setCard({ ...card, cvv: cvv.replace(/\D/g, '').slice(0, 4) })} type="password" inputMode="numeric" autoComplete="cc-csc" placeholder="CVV" required errors={errors} /><button type="button" className="text-button" onClick={refresh} disabled={refreshing}>{refreshing ? 'Loading…' : 'Refresh saved cards'}</button></div>
      <p className="fine-print">Uses a card already stored with BIG W. The security code is needed for the purchase; Duke only keeps it when you save the card for one-click.</p>
    </>}
    {errors.card && <p className="field-error">{errors.card}</p>}
  </div>;
}

export function ProductPreview({ product, quantity, compact = false }: { product: ProductInfo; quantity: number; compact?: boolean }) {
  const [broken, setBroken] = useState(false);
  return <div className={`product-preview ${compact ? 'compact' : ''}`}>
    <div className="product-image">{product.imageUrl && !broken ? <img src={product.imageUrl} alt="" onError={() => setBroken(true)} /> : <span>BW</span>}</div>
    <div className="product-description"><div className="product-eyebrow">BIG W <span>·</span> {product.code}</div><h3>{product.title}</h3>{!compact && <div className="product-meta"><span className={`badge ${product.available ? 'sage' : 'rose'}`}>{product.stockLabel}</span><span className="mono">{money(product.priceCents)} × {quantity}</span></div>}{!compact && product.releaseLabel && <p className="product-release">{product.releaseLabel}</p>}</div>
  </div>;
}

const stageLabels = { connect: 'Browser & session', inspect: 'Product & availability', cart: 'Cart & delivery', contact: 'Contact & billing', payment: 'Secure payment', complete: 'Complete' };
const statusLabels: Record<CheckoutRun['status'], string> = { queued: 'Queued', running: 'In progress', action_required: 'Authentication needed', ready: 'Checkout ready', succeeded: 'Order confirmed', failed: 'Stopped', cancelled: 'Cancelled', payment_unknown: 'Check order outcome' };
export function StatusBadge({ run }: { run: CheckoutRun }) {
  const color = ['ready', 'succeeded'].includes(run.status) ? 'sage' : ['failed', 'payment_unknown'].includes(run.status) ? 'rose' : run.status === 'action_required' ? 'sand' : 'neutral';
  return <span className={`badge ${color}`}>{statusLabels[run.status]}</span>;
}

export function RunSummary({ run, product, quantity, maxTotal, mode, busy, active, start, cancel, focus, resolve }: { run?: CheckoutRun; product?: ProductInfo; quantity: number; maxTotal: string; mode: RunMode; busy: boolean; active: boolean; start(): void; cancel(): void; focus(): void; resolve(resolution: 'confirmed' | 'not_purchased', reference?: string): void }) {
  const [now, setNow] = useState(Date.now());
  const [reference, setReference] = useState('');
  useEffect(() => { if (!run || terminal(run)) return; const interval = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(interval); }, [run?.id, run?.status]);
  const currentProduct = run?.product ?? product;
  const elapsed = run && !terminal(run) ? Math.max(0, now - Date.parse(run.startedAt)) : run?.elapsedMs;
  const index = run ? STAGES.indexOf(run.stage) : -1;
  const successful = run && ['ready', 'succeeded'].includes(run.status);
  return <aside className="summary-panel">
    <div className="summary-heading"><span className="eyebrow">RUN SUMMARY</span>{run ? <StatusBadge run={run} /> : <span className="draft-tag">Draft</span>}</div>
    <h2>{run?.status === 'succeeded' ? 'Order, sorted.' : run?.status === 'ready' ? 'Ready in Chrome.' : active ? 'On its way.' : 'Ready when you are.'}</h2>
    <p className="summary-intro">{mode === 'prepare' ? 'A ready-to-pay checkout, without submitting payment.' : mode === 'assist' ? 'Fills the card in Chrome and stops — you press Pay.' : mode === 'afterpay' ? 'Prepares the cart and opens Afterpay for you to complete.' : 'One start. Checkout and payment handled automatically.'}</p>
    {currentProduct ? <ProductPreview product={currentProduct} quantity={run?.quantity ?? quantity} /> : <div className="preview-empty"><div className="empty-mark"><Icon name="link" size={24} /></div><p>Your product will appear here.</p><span>Paste a BIG W link to get started.</span></div>}
    <dl className="summary-totals"><div><dt>Quantity</dt><dd>{run?.quantity ?? quantity}</dd></div><div><dt>{run?.totalCents !== undefined ? 'Delivery' : 'Est. delivery'}</dt><dd>{run?.deliveryCents !== undefined ? money(run.deliveryCents) : product ? money(product.deliveryCents) : '—'}</dd></div><div><dt>Maximum delivered total</dt><dd>{run ? money(run.maxTotalCents) : Number(maxTotal) > 0 ? money(Math.round(Number(maxTotal) * 100)) : 'Not set'}</dd></div><div className="summary-total"><dt>{run?.totalCents !== undefined ? 'Delivered total' : 'Estimated total'}</dt><dd>{run?.totalCents !== undefined ? money(run.totalCents) : product ? money(product.priceCents * quantity + product.deliveryCents) : '—'}</dd></div></dl>
    <div className="progress-header"><span className="eyebrow">CHECKOUT PROGRESS</span>{elapsed !== undefined && <span className="mono elapsed">{duration(elapsed)}</span>}</div>
    <ol className={`progress-list ${run ? '' : 'draft-progress'}`} aria-label="Checkout progress" aria-live="polite">{STAGES.map((stage, stageIndex) => {
      const complete = successful || stageIndex < index;
      const current = run?.stage === stage && !successful;
      return <li key={stage} className={`${complete ? 'done' : ''} ${current ? 'current' : ''} ${current && run?.status === 'failed' ? 'stopped' : ''}`}><span className="step-marker">{complete ? <Icon name="check" size={11} /> : <span>{stageIndex + 1}</span>}</span><span>{stageLabels[stage]}</span>{current && active && <span className="activity-dot" />}</li>;
    })}</ol>
    {run?.events.length ? <div className={`run-message ${run.error ? 'message-error' : ''}`} role={run.error ? 'alert' : 'status'}>{run.error?.message ?? run.events.at(-1)?.message}</div> : null}
    {run?.orderNumber && <div className="order-reference"><span>Order reference</span><strong>{run.orderNumber}</strong></div>}
    {run?.status === 'payment_unknown' && <div className="resolution-panel"><a href="https://www.bigw.com.au/my-account/orders" target="_blank" rel="noreferrer">Check BIG W order history <Icon name="external" size={13} /></a><Field name="orderReference" label="Confirmed order reference" value={reference} onChange={setReference} placeholder="From BIG W order history" /><button className="secondary-button" type="button" disabled={!reference || busy} onClick={() => resolve('confirmed', reference)}>Mark order confirmed</button><button className="text-button" type="button" disabled={busy} onClick={() => resolve('not_purchased')}>I checked: no order was placed</button></div>}
    <div className="summary-actions">
      <button className="primary-button" type="button" disabled={busy || active} onClick={start}><span>{active ? 'Checkout in progress' : busy ? 'Working…' : mode === 'prepare' ? 'Prepare checkout' : mode === 'assist' ? "Fill card (I'll pay)" : mode === 'afterpay' ? 'Open Afterpay' : 'Purchase automatically'}</span>{busy || active ? <span className="spinner" /> : <Icon name="arrow" size={20} />}</button>
      {active && !run?.paymentSubmittedAt && <button type="button" className="text-button cancel-button" onClick={cancel}>Cancel this run</button>}
      {(run || active) && <button type="button" className="open-browser-button" onClick={focus}><Icon name="browser" size={15} /> Open BIG W tab <Icon name="external" size={12} /></button>}
    </div>
    <div className="summary-footnote"><Icon name="lock" size={13} /><span>Runs locally, in your existing browser.</span></div>
  </aside>;
}

export function RunHistory({ runs, select }: { runs: CheckoutRun[]; select(id: string): void }) {
  return <section className="history-section"><div className="history-heading"><h2>Recent runs <span>{runs.length}</span></h2><span className="subtle-label">Saved on this computer</span></div>{!runs.length ? <div className="history-empty"><span className="history-empty-line" /><p>A little less manual, starting with your first run.</p><span className="mono">No runs yet</span></div> : <div className="history-table-wrap"><table><thead><tr><th>Product</th><th>Mode</th><th>Outcome</th><th>Total</th><th>Time</th></tr></thead><tbody>{runs.slice(0, 8).map(run => <tr key={run.id} onClick={() => select(run.id)}><td><button type="button" className="history-product" onClick={event => { event.stopPropagation(); select(run.id); }}>{run.product?.title ?? `BIG W article ${run.productCode}`}</button><span>{new Date(run.startedAt).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></td><td>{run.mode === 'prepare' ? 'Prepare' : run.mode === 'assist' ? 'Fill only' : run.mode === 'afterpay' ? 'Afterpay' : 'Purchase'}</td><td><StatusBadge run={run} /></td><td className="mono">{run.totalCents === undefined ? '—' : money(run.totalCents)}</td><td className="mono">{duration(run.elapsedMs)}</td></tr>)}</tbody></table></div>}</section>;
}
