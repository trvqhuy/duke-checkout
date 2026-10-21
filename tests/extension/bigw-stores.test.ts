import { describe, expect, it } from 'vitest';
import { normalizeStores, pickStore } from '../../src/extension/lib/retailers/bigw/adapter.ts';

// The live BIG W endpoint returns this shape (an object keyed by store id).
const liveMap = {
  '0130': { id: '0130', name: 'BIG W Carnes Hill', address: { street: '245 Cowpasture Road', suburb: 'Horningsea Park', state: 'NSW', postcode: '2171' } },
  '0200': { id: '0200', name: 'BIG W Melbourne', address: { suburb: 'Melbourne', state: 'VIC', postcode: '3000' } },
  '0300': { id: '0300', name: 'BIG W Brisbane', address: { suburb: 'Brisbane', state: 'QLD', postcode: '4000' } },
};

describe('store list normalisation', () => {
  it('understands the live object-map response', () => {
    const stores = normalizeStores(liveMap);
    expect(stores.map(store => store.id)).toEqual(['0130', '0200', '0300']);
  });

  it('understands the fixture array and a { stores } wrapper', () => {
    expect(normalizeStores([{ id: 'S1', name: 'Sydney Store' }])).toHaveLength(1);
    expect(normalizeStores({ stores: [{ id: 'S1', name: 'Sydney Store' }] })).toHaveLength(1);
  });

  it('drops metadata keys that are not stores', () => {
    const stores = normalizeStores({ version: 2, total: 1, '0130': liveMap['0130'] });
    expect(stores).toHaveLength(1);
    expect(stores[0].id).toBe('0130');
  });

  it('accepts a store identified only by name', () => {
    const stores = normalizeStores({ a: { name: 'BIG W Somewhere' } });
    expect(stores).toHaveLength(1);
    expect(stores[0].name).toBe('BIG W Somewhere');
  });

  it('returns an empty list for missing or malformed data', () => {
    expect(normalizeStores(null)).toEqual([]);
    expect(normalizeStores(undefined)).toEqual([]);
    expect(normalizeStores({})).toEqual([]);
    expect(normalizeStores('nope')).toEqual([]);
  });
});

describe('store selection', () => {
  it('prefers the delivery postcode', () => {
    expect(pickStore(liveMap, { postcode: '3000', state: 'VIC' })?.id).toBe('0200');
  });

  it('falls back to the delivery state', () => {
    expect(pickStore(liveMap, { postcode: '9999', state: 'QLD' })?.id).toBe('0300');
  });

  it('falls back to the first store when neither matches', () => {
    expect(pickStore(liveMap, { postcode: '6000', state: 'WA' })?.id).toBe('0130');
  });

  it('returns undefined when the endpoint returned no stores', () => {
    expect(pickStore({}, { postcode: '2000', state: 'NSW' })).toBeUndefined();
  });

  it('works with the fixture array shape', () => {
    const stores = [{ id: 'S1', name: 'Sydney Store', address: { state: 'NSW', postcode: '2000' } }];
    expect(pickStore(stores, { postcode: '2000', state: 'NSW' })?.id).toBe('S1');
  });
});
