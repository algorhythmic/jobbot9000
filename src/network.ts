// Network is disabled in the foundation slice. Only explicitly injected adapters
// may perform fixture I/O; no environment variable enables live requests.
export const NETWORK_DISABLED = "Network disabled: this foundation supports local previews and explicitly injected offline adapters only.";
export const disabledFetch: typeof fetch = async () => {
  throw new Error(NETWORK_DISABLED);
};
