/** Synthetic in-memory transport. This module has no remote effects or user callbacks. */
export type MockBehavior = "success" | "reject" | "accept_then_timeout";
export interface MockReceipt { state: "succeeded" | "rejected"; receiptId: string }
export interface TransportAdapter {
  send(request: { idempotencyKey: string }): Promise<MockReceipt>;
  lookup(idempotencyKey: string): Promise<MockReceipt | undefined>;
}
const authentic = new WeakSet<object>();
class MockTransport implements TransportAdapter {
  readonly #records = new Map<string, MockReceipt>();
  readonly #behavior: MockBehavior;
  #sendCalls = 0;
  #lookupCalls = 0;
  constructor(behavior: MockBehavior) { this.#behavior = behavior; authentic.add(this); Object.freeze(this); }
  get sendCalls(): number { return this.#sendCalls; }
  get lookupCalls(): number { return this.#lookupCalls; }
  async send(request: { idempotencyKey: string }): Promise<MockReceipt> {
    if (!/^[a-f0-9]{64}$/.test(request.idempotencyKey)) throw new Error("mock request denied");
    this.#sendCalls++;
    const prior = this.#records.get(request.idempotencyKey);
    if (prior) return { ...prior };
    const receipt: MockReceipt = { state: this.#behavior === "reject" ? "rejected" : "succeeded", receiptId: request.idempotencyKey };
    this.#records.set(request.idempotencyKey, receipt);
    if (this.#behavior === "accept_then_timeout") throw new Error("mock outcome unknown");
    return { ...receipt };
  }
  async lookup(idempotencyKey: string): Promise<MockReceipt | undefined> {
    this.#lookupCalls++;
    const receipt = this.#records.get(idempotencyKey);
    return receipt && { ...receipt };
  }
}
Object.freeze(MockTransport.prototype);
export function createMockTransport(options: { behavior?: MockBehavior } = {}): TransportAdapter & { readonly sendCalls: number; readonly lookupCalls: number } {
  const behavior = options.behavior ?? "success";
  if (!["success", "reject", "accept_then_timeout"].includes(behavior)) throw new Error("mock behavior denied");
  return new MockTransport(behavior);
}
export function isMockTransport(value: unknown): value is TransportAdapter { return typeof value === "object" && value !== null && authentic.has(value); }
