export function formatPriceByPrecision(price: number, precision: number): string {
  if (!price || !isFinite(price)) return '0'
  if (price >= 1000 && precision <= 2) {
    return price.toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
  }
  return price.toFixed(precision)
}
