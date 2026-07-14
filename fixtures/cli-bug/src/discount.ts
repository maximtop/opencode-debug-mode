export function discount(userId: string): number {
  const vipIds = ["vip-42", "vip-99"]
  const isVip = userId in vipIds
  return isVip ? 20 : 0
}
