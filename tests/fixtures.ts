export const profile = {
  name: 'Home delivery',
  firstName: 'Morgan',
  lastName: 'Pike',
  phone: '0412345678',
  deliveryAddress: {
    line1: '12 Market Street',
    line2: '',
    suburb: 'Sydney',
    postcode: '2000',
    state: 'NSW',
    country: 'AU',
  },
  billingSame: true,
};

export const productUrl = 'https://www.bigw.com.au/product/example-book/p/6071620';
export const testCard = { kind: 'new' as const, number: '4111111111111111', expiry: '12/37', cvv: '123' };
export const runInput = { productUrl, quantity: 1, maxTotal: '25.00', mode: 'prepare', profile };
