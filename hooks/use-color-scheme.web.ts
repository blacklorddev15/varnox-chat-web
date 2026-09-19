import { useEffect, useState } from "react";
import { useColorScheme as useRNColorScheme } from "react-native";

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme() {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  // VARNOX uses a fixed dark palette (near-black surfaces, gold accents) rather than
  // following the device preference, which previously rendered the site near-white for
  // anyone whose phone or browser was in light mode.
  useRNColorScheme();

  return "dark";
}
