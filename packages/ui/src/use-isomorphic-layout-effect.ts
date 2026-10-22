import { useEffect, useLayoutEffect } from "react";

/** useLayoutEffect on the client (runs before paint, so state read from
 * localStorage after hydration doesn't flash), useEffect on the server where
 * layout effects don't run. */
export const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
