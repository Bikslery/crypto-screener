export function getPrecisionFromTickSize(tickSize: string | number): number {
  const str = String(tickSize)
  const dotIndex = str.indexOf('.')
  if (dotIndex === -1) return 0
  const decimals = str.length - dotIndex - 1
  const trimmed = str.replace(/0+$/, '')
  const trimmedDotIndex = trimmed.indexOf('.')
  if (trimmedDotIndex === -1) return 0
  return trimmed.length - trimmedDotIndex - 1
}

export function getPrecisionFromPrice(price: number): number {
  if (price <= 0 || !isFinite(price)) return 2
  const str = price.toPrecision(15)
  const dotIndex = str.indexOf('.')
  if (dotIndex === -1) return 2
  let firstSignificant = -1
  for (let i = dotIndex + 1; i < str.length; i++) {
    if (str[i] !== '0' && str[i] !== 'e' && str[i] !== 'E') {
      firstSignificant = i
      break
    }
  }
  if (firstSignificant === -1) return 2
  if (price >= 1) return Math.max(2, firstSignificant - dotIndex)
  return firstSignificant - dotIndex + 3
}

export function formatPrice(price: number, precision: number): string {
  if (!price || !isFinite(price)) return ''
  if (price >= 1000 && precision <= 2) {
    return price.toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
  }
  return price.toFixed(precision)
}

export function formatCompact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`
  return String(Math.round(n))
}
