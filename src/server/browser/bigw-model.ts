import { z } from 'zod';
import type { CartState, ProductInfo } from '../../shared/types.ts';
import { parseProductLink } from '../../shared/validation.ts';
import { AppError } from '../errors.ts';

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function string(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }

function productImage(value: unknown, depth = 0): string | undefined {
  if (depth > 8) return;
  if (typeof value === 'string' && value.length < 1200) {
    if (!/\/medias\/|\/is\/image\//.test(value)) return;
    try {
      const url = new URL(value, 'https://www.bigw.com.au');
      if (url.protocol === 'https:' && (url.hostname === 'www.bigw.com.au' || url.hostname.endsWith('.scene7.com'))) return url.href;
    } catch { return; }
  }
  if (value && typeof value === 'object') {
    const entries = Array.isArray(value) ? value.slice(0, 30) : Object.entries(value).filter(([key]) => !/description|categories/i.test(key)).map(([, item]) => item);
    for (const item of entries) { const image = productImage(item, depth + 1); if (image) return image; }
  }
}

export function buildProductInfo(url: string, productData: unknown, priceData: unknown, availabilityData: unknown): ProductInfo {
  const link = parseProductLink(url);
  const products = Array.isArray(productData) ? productData : [];
  const product = record(products.find(row => string(record(row).code) === link.code) ?? products[0]);
  if (!product.name) throw new AppError('PRODUCT_NOT_FOUND', 'BIG W did not return this product. Check the product link.');
  const prices = Array.isArray(priceData) ? priceData : [];
  const price = record(prices[0]);
  const cents = record(price.price).centAmount;
  if (!Number.isSafeInteger(cents) || Number(cents) <= 0) throw new AppError('PRICE_UNAVAILABLE', 'A current price is not available for this product and state.');
  const availability = record(record(record(availabilityData).products)[link.code]);
  const standard = record(record(availability.delivery)['Standard Delivery']);
  const labels = record(price.promoLabels).labels;
  const release = Array.isArray(labels) ? record(labels.find(item => record(item).labelType === 'RELEASE_DETAIL')).text : undefined;
  const preorder = /pre.?order/i.test(string(price.label));
  // A missing availability payload means the advisory lookup could not run; the
  // cart's fulfilment response remains authoritative, so defer rather than deny.
  const checked = Object.keys(standard).length > 0;
  const available = checked ? standard.available === true : true;
  const variants = Array.isArray(product.variants) ? product.variants.map(record) : [];
  const selectedVariant = variants.find(variant => variant.code === link.code || variant.sku === link.code);
  return {
    code: link.code, url: link.url, title: string(product.name), imageUrl: productImage(selectedVariant?.assets) ?? productImage(product),
    priceCents: Number(cents), deliveryCents: Number.isSafeInteger(availability.minDeliveryFee) ? Number(availability.minDeliveryFee) : 0,
    available, stockLabel: !checked ? 'Availability checked at checkout' : available ? preorder ? 'Pre-order' : 'Available for delivery' : 'Delivery unavailable',
    releaseLabel: typeof release === 'string' ? release : undefined,
    deliveryEstimate: string(standard.estimatedDelivery) || undefined,
    seller: string(record(product.vendorInformation).name, 'BIG W'),
    requiresVariant: product.soldByItself === false && variants.length > 1 && !selectedVariant,
  };
}

const cartSchema = z.object({
  id: z.string().min(1).max(150), version: z.number().int().nonnegative(),
  entries: z.array(z.object({ productCode: z.string(), quantity: z.number().int().positive() })),
  total: z.number().int().nonnegative(), deliveryCost: z.number().int().nonnegative(),
  deliveryAddress: z.record(z.string(), z.unknown()).nullable().optional(),
  billingAddress: z.record(z.string(), z.unknown()).nullable().optional(),
  customer: z.record(z.string(), z.unknown()).nullable().optional(),
  validation: z.object({ isValid: z.boolean(), failedValidation: z.array(z.unknown()).optional() }).optional(),
  fulfilment: z.record(z.string(), z.unknown()).optional(),
});

export function parseCartState(value: unknown): CartState {
  const parsed = cartSchema.safeParse(value);
  if (!parsed.success) throw new AppError('STORE_SCHEMA', 'BIG W returned an unfamiliar cart format. Preparation stopped before payment.');
  return parsed.data;
}
