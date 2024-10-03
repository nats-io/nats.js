export function stripNatsMetadata(md?: Record<string, string>) {
  if (md) {
    for (const p in md) {
      if (p.startsWith("_nats.")) {
        delete md[p];
      }
    }
  }
}
