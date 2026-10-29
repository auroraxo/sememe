// Slot range of a harvest without spreading the array into the call stack.
//
// A large block harvest collects hundreds of thousands of slot entries: the
// original `Math.min(...slots)` form crashed with
// `RangeError: Maximum call stack size exceeded` AFTER all RPC work was done,
// i.e. it destroyed the run right before the file was written. Reducing in a
// loop scales with array length instead of argument count.
export function slotRange(slots) {
  if (!Array.isArray(slots) || slots.length === 0) return null;
  let oldest = Infinity;
  let newest = -Infinity;
  for (const slot of slots) {
    if (!Number.isSafeInteger(slot)) continue;
    if (slot < oldest) oldest = slot;
    if (slot > newest) newest = slot;
  }
  if (oldest === Infinity) return null;
  return { oldest, newest };
}
