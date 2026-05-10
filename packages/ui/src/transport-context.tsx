"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Transport } from "@data-view/core";

const TransportContext = createContext<Transport | null>(null);

export function TransportProvider({
  transport,
  children,
}: {
  transport: Transport;
  children: ReactNode;
}) {
  return <TransportContext.Provider value={transport}>{children}</TransportContext.Provider>;
}

export function useTransport(): Transport {
  const t = useContext(TransportContext);
  if (!t) throw new Error("useTransport must be used inside <TransportProvider>");
  return t;
}
