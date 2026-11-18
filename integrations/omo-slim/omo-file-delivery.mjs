// Explicit file-archive opt-out adapter. No bridge, IO, receipts or part mutation.
// Keep the legacy helper's callable signatures for existing patched consumers.
export async function deliveryMetadata(directory, record) {
  return undefined;
}
export function deliverySuffix(metadata) {
  return '';
}
export function presentDelivery(text, metadata) {
  return text;
}
export async function annotateDeliveryPart(directory, part, record, parentSessionID, isCurrent) {
  // Deliberately do not inspect the part, record, callback or global bridge.
}
