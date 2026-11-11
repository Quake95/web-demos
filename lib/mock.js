// Canned data for MOCK_API=1. Raw model-shaped rows only: policy maths still runs over them.

/** Delay so the UI shows its loading state. */
export const mockDelay = (ms = 600) => new Promise((r) => setTimeout(r, ms));

/** Canned identify result. */
export function mockProduct() {
  return {
    is_product: true,
    name: "Nurofen Zavance 256mg Tablets",
    brand: "Nurofen",
    size: "96 pack",
    variant: "Zavance 256mg",
    barcode: "9300631234567",
    search_query: "Nurofen Zavance 256mg 96 tablets",
    confidence: 0.9,
    notes: "",
  };
}

/** Canned model output for compare, same shape the real model emits. */
export function mockModelCompare() {
  const n = "nurofen-zavance-256mg-96";
  return {
    stores: [
      { retailer: "Chemist Warehouse", url: `https://www.chemistwarehouse.com.au/buy/${n}`, price: 14.99, was_price: null, promo: false, in_stock: true, notes: "" },
      { retailer: "Amcal", url: `https://www.amcal.com.au/products/${n}`, price: 16.49, was_price: null, promo: false, in_stock: true, notes: "" },
      { retailer: "Woolworths", url: `https://www.woolworths.com.au/shop/productdetails/${n}`, price: 12.5, was_price: 15, promo: true, in_stock: true, notes: "Half price this week" },
      { retailer: "Coles", url: `https://www.coles.com.au/product/${n}`, price: 13.5, was_price: null, promo: false, in_stock: true, notes: "" },
      { retailer: "Priceline", url: `https://www.priceline.com.au/${n}`, price: 17.99, was_price: null, promo: false, in_stock: true, notes: "" },
      { retailer: "Amazon AU", url: `https://www.amazon.com.au/dp/B0MOCK0001`, price: 11.9, was_price: null, promo: false, in_stock: true, notes: "Third-party seller" },
      { retailer: "iHerb", url: `https://au.iherb.com/pr/${n}`, price: 10.75, was_price: null, promo: false, in_stock: true, notes: "Ships from overseas" },
    ],
    summary: "Woolworths has it on special this week. Chemist Warehouse should be able to match that price.",
  };
}
