export const STAGES = ['connect', 'inspect', 'cart', 'contact', 'payment', 'complete'] as const;
export type Stage = typeof STAGES[number];
export type RunMode = 'prepare' | 'assist' | 'purchase' | 'afterpay';
export type RunStatus = 'queued' | 'running' | 'action_required' | 'ready' | 'succeeded' | 'failed' | 'cancelled' | 'payment_unknown';

export interface Address {
  line1: string;
  line2: string;
  suburb: string;
  postcode: string;
  state: string;
  country: 'AU';
}

export interface Profile {
  id?: string;
  name: string;
  firstName: string;
  lastName: string;
  phone: string;
  deliveryAddress: Address;
  billingSame: boolean;
  billingAddress?: Address;
}

export type PaymentInput =
  | { kind: 'new'; number: string; expiry: string; cvv: string }
  | { kind: 'saved'; cardId: string; cvv: string };

export interface RunRequest {
  requestId?: string;
  productUrl: string;
  quantity: number;
  maxTotalCents: number;
  mode: RunMode;
  profile: Profile;
  card?: PaymentInput;
  // If the account's cart already has other items, replace them with this
  // checkout's item instead of failing. Defaults to true when omitted.
  replaceCart?: boolean;
}

export interface ProductInfo {
  code: string;
  url: string;
  title: string;
  imageUrl?: string;
  priceCents: number;
  deliveryCents: number;
  available: boolean;
  stockLabel: string;
  releaseLabel?: string;
  deliveryEstimate?: string;
  seller?: string;
  requiresVariant?: boolean;
}

export interface CartState {
  id: string;
  version: number;
  entries: { productCode: string; quantity: number }[];
  total: number;
  deliveryCost: number;
  deliveryAddress?: Record<string, unknown> | null;
  billingAddress?: Record<string, unknown> | null;
  customer?: Record<string, unknown> | null;
  validation?: { isValid: boolean; failedValidation?: unknown[] };
  fulfilment?: Record<string, unknown>;
}

export interface PreparedCheckout {
  cartId: string;
  cart: CartState;
  product: ProductInfo;
}

export interface RunEvent {
  stage: Stage;
  message: string;
  at: string;
  elapsedMs: number;
}

export interface CheckoutRun {
  id: string;
  requestId: string;
  mode: RunMode;
  status: RunStatus;
  stage: Stage;
  productCode: string;
  productUrl: string;
  quantity: number;
  maxTotalCents: number;
  profileName: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  paymentSubmittedAt?: string;
  elapsedMs: number;
  product?: ProductInfo;
  totalCents?: number;
  deliveryCents?: number;
  orderNumber?: string;
  error?: { code: string; message: string };
  events: RunEvent[];
}

export interface ConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  message: string;
  browser?: string;
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expiryMonth?: number;
  expiryYear?: number;
}

export type PaymentOutcome =
  | { status: 'confirmed'; orderNumber: string }
  | { status: 'declined'; message: string }
  | { status: 'blocked'; code: string; message: string }
  | { status: 'unknown'; message: string };

export type StageReporter = (stage: Stage, message: string) => void;

// A checkout prepared ahead of time ("armed") so a later run can skip
// inspection and all cart mutations: only a cart re-check, the page, and the
// payment step remain at the moment of purchase. A 'standby' arm covers
// pre-release products that cannot be added to the cart yet: session, product
// details, and page warm-up are done early, and the run adds the cart itself.
export interface ArmedCheckout {
  productUrl: string;
  productCode: string;
  quantity: number;
  maxTotalCents: number;
  profile: Profile;
  product: ProductInfo;
  cartId: string;
  cart: CartState;
  armedAt: string;
  level: 'cart-ready' | 'standby';
  note?: string;
}

export interface StoreAdapter {
  connect(): Promise<ConnectionState>;
  inspect(productUrl: string, profile: Profile): Promise<ProductInfo>;
  prepare(input: RunRequest, product: ProductInfo, report: StageReporter, signal: AbortSignal): Promise<PreparedCheckout>;
  verify(prepared: PreparedCheckout, input: RunRequest): Promise<CartState>;
  arm?(input: RunRequest, report: StageReporter, signal: AbortSignal): Promise<ArmedCheckout>;
  armedState?(): ArmedCheckout | null;
  disarm?(): void;
  revealPrepared?(prepared: PreparedCheckout, report: StageReporter, signal: AbortSignal, opts?: { reuseMountedPage?: boolean }): Promise<void>;
  keepSessionFresh?(): Promise<void>;
  fillCard(card: PaymentInput, opts?: { programmaticSubmit?: boolean }): Promise<void>;
  startAfterpay(): Promise<boolean>;
  pay(prepared: PreparedCheckout, card: PaymentInput, onActionRequired: () => void): Promise<PaymentOutcome>;
  clearSensitiveFields(): Promise<void>;
}

export interface Bootstrap {
  csrfToken: string;
  profiles: Profile[];
  runs: CheckoutRun[];
  connection: ConnectionState;
  activeRunId: string | null;
  armed: ArmedCheckout | null;
}
