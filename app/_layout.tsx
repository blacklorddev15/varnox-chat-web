import "@/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import "@/lib/_core/nativewind-pressable";
import { ThemeProvider } from "@/lib/theme-provider";
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  initialWindowMetrics,
} from "react-native-safe-area-context";
import type { EdgeInsets, Metrics, Rect } from "react-native-safe-area-context";

import { trpc, createTRPCClient } from "@/lib/trpc";
import { createCachePersister, restoreQueryCache } from "@/lib/query-cache";
import { initManusRuntime, subscribeSafeAreaInsets } from "@/lib/_core/manus-runtime";
import { useAuth } from "@/hooks/use-auth";
import { CallProvider } from "@/lib/call-context";
import { CallOverlay } from "@/components/call-overlay";
import { LockGate } from "@/components/lock-gate";

const DEFAULT_WEB_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const DEFAULT_WEB_FRAME: Rect = { x: 0, y: 0, width: 0, height: 0 };

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const { user, loading } = useAuth();

  // Registering the service worker is what makes the site installable as an app. Production
  // only - in development it would sit in front of the hot-reload bundle.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  const initialInsets = initialWindowMetrics?.insets ?? DEFAULT_WEB_INSETS;
  const initialFrame = initialWindowMetrics?.frame ?? DEFAULT_WEB_FRAME;

  const [insets, setInsets] = useState<EdgeInsets>(initialInsets);
  const [frame, setFrame] = useState<Rect>(initialFrame);

  useEffect(() => {
    if (loading) return;
    const inAuthRoute = segments[0] === "login" || segments[0] === "oauth" || segments[0] === "account-status" || segments[0] === "password-reset";
    if (!user && !inAuthRoute) router.replace("/login");
    if (user && segments[0] === "login") router.replace("/(tabs)");
  }, [loading, router, segments, user]);

  // Initialize Manus runtime for cookie injection from parent container
  useEffect(() => {
    initManusRuntime();
  }, []);

  useEffect(() => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
    if (Platform.OS !== "android") return;
    Notifications.setNotificationChannelAsync("messages", {
      name: "Messages",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#00A884",
    }).catch((error) => console.warn("[Notifications] Channel setup failed", error));
  }, []);

  const handleSafeAreaUpdate = useCallback((metrics: Metrics) => {
    setInsets(metrics.insets);
    setFrame(metrics.frame);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const unsubscribe = subscribeSafeAreaInsets(handleSafeAreaUpdate);
    return () => unsubscribe();
  }, [handleSafeAreaUpdate]);

  // Create clients once and reuse them
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          // Disable automatic refetching on window focus for mobile
          refetchOnWindowFocus: false,
          // Retry failed requests once
          retry: 1,
        },
        mutations: {
          // Reads keep the default "online" mode, so offline they pause instead of failing and
          // resume by themselves on reconnect. Writes do not: a paused mutation is a tap that never
          // resolves and never reports anything, and a message that appears to be sending while it
          // is really parked in memory is worse than one that is plainly refused. `lib/trpc.ts`
          // turns a write attempted offline into an immediate, readable error.
          networkMode: "always",
        },
      },
    });
    // Whatever was on screen last time goes back in before the first render. This is what makes the
    // app readable when it is opened with no connection: without it every query starts empty, the
    // screens show a spinner that never resolves, and there is nothing to read. Restored entries
    // keep their original `updatedAt`, so React Query still treats stale data as stale and refetches
    // it the moment there is a connection again.
    restoreQueryCache(client);
    return client;
  });
  const [trpcClient] = useState(() => createTRPCClient());

  // Writes the cache back to storage after it settles, so the next launch has something to restore.
  useEffect(() => createCachePersister(queryClient), [queryClient]);

  // Ensure minimum 8px padding for top and bottom on mobile
  const providerInitialMetrics = useMemo(() => {
    const metrics = initialWindowMetrics ?? { insets: initialInsets, frame: initialFrame };
    return {
      ...metrics,
      insets: {
        ...metrics.insets,
        top: Math.max(metrics.insets.top, 16),
        bottom: Math.max(metrics.insets.bottom, 12),
      },
    };
  }, [initialInsets, initialFrame]);

  const content = (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {/* Default to hiding native headers so raw route segments don't appear (e.g. "(tabs)", "products/[id]"). */}
          {/* If a screen needs the native header, explicitly enable it and set a human title via Stack.Screen options. */}
          {/* in order for ios apps tab switching to work properly, use presentation: "fullScreenModal" for login page, whenever you decide to use presentation: "modal*/}
          <CallProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="login" />
              <Stack.Screen name="account-status" />
              <Stack.Screen name="oauth/callback" />
            </Stack>
            {/* Above every route, so a call survives navigation and tab switches. */}
            <CallOverlay />
            {/* Also above every route: a two-step PIN that a navigation could dodge is not a lock. */}
            <LockGate />
          </CallProvider>
          <StatusBar style="auto" />
        </QueryClientProvider>
      </trpc.Provider>
    </GestureHandlerRootView>
  );

  const shouldOverrideSafeArea = Platform.OS === "web";

  if (shouldOverrideSafeArea) {
    return (
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={providerInitialMetrics}>
          <SafeAreaFrameContext.Provider value={frame}>
            <SafeAreaInsetsContext.Provider value={insets}>
              {content}
            </SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
        </SafeAreaProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>{content}</SafeAreaProvider>
    </ThemeProvider>
  );
}
