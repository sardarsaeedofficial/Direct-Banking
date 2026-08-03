// Prisma returns monetary columns as BigInt. JSON.stringify cannot serialize
// BigInt by default, so teach it to emit a Number (pence always fit in 2^53).
// Imported once at startup before any response is sent.
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) {
  return Number(this);
};
export {};
