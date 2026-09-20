import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

const TIMERS: Array<{ seconds: number; label: string }> = [
  { seconds: 0, label: "Off" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 604800, label: "7 days" },
  { seconds: 7776000, label: "90 days" },
];

/**
 * Account-wide chat defaults.
 *
 * Every control here is stored on the server. This screen used to hold three switches in local state
 * and two rows with nothing behind them, which meant it reported choices it had not made - and a chat
 * could show a value this screen had never really set. Anything a single chat can override lives in
 * that chat's own settings instead, reached from the chat itself.
 */
export default function ChatSettingsScreen() {
  const colors = useColors();
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [showTimers, setShowTimers] = useState(false);

  const settingsQuery = trpc.settings.get.useQuery();
  const update = trpc.settings.update.useMutation();
  const setMessageTimer = trpc.settings.setMessageTimer.useMutation();

  const [readReceipts, setReadReceipts] = useState(true);
  const [autoDownload, setAutoDownload] = useState(true);

  useEffect(() => {
    const data = settingsQuery.data;
    if (!data) return;
    setReadReceipts(data.readReceipts !== 0);
    setAutoDownload(data.autoDownloadMedia !== 0);
  }, [settingsQuery.data]);

  const persist = (key: "readReceipts" | "autoDownloadMedia", value: boolean, optimistic: (next: boolean) => void, previous: boolean) => {
    optimistic(value);
    update
      .mutateAsync({ [key]: value })
      .then(() => settingsQuery.refetch())
      .catch((error: unknown) => {
        // Put the switch back: leaving it flipped would show a choice the server refused.
        optimistic(previous);
        setStatus(error instanceof Error && error.message ? error.message : "Could not save that setting");
      });
  };

  const timerSeconds = settingsQuery.data?.defaultDisappearSeconds ?? 0;
  const timerLabel = TIMERS.find((entry) => entry.seconds === timerSeconds)?.label ?? (timerSeconds > 0 ? `${Math.round(timerSeconds / 3600)} hours` : "Off");

  const row = (icon: React.ComponentProps<typeof MaterialIcons>["name"], title: string, subtitle: string, control?: React.ReactNode, onPress?: () => void) => {
    const inner = (
      <>
        <View style={[styles.icon, { backgroundColor: "rgba(0,168,132,.14)" }]}>
          <MaterialIcons name={icon} size={20} color={colors.primary} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.rowTitle, { color: colors.foreground }]}>{title}</Text>
          <Text style={[styles.sub, { color: colors.muted }]}>{subtitle}</Text>
        </View>
        {control ?? <MaterialIcons name="chevron-right" size={20} color={colors.muted} />}
      </>
    );
    return onPress ? (
      <Pressable key={title} onPress={onPress} style={[styles.row, { borderBottomColor: colors.border }]}>
        {inner}
      </Pressable>
    ) : (
      <View key={title} style={[styles.row, { borderBottomColor: colors.border }]}>
        {inner}
      </View>
    );
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Chat settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.hero, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.heroTitle, { color: colors.foreground }]}>Varnox conversations</Text>
          <Text style={[styles.sub, { color: colors.muted }]}>Defaults for every chat. Any chat can be given its own settings from the chat header.</Text>
        </View>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {row(
            "timer",
            "Default message timer",
            timerSeconds > 0 ? `New chats disappear after ${timerLabel.toLowerCase()}` : "Off · no chat disappears by default",
            <Text style={[styles.value, { color: colors.primary }]}>{timerLabel}</Text>,
            () => setShowTimers((current) => !current),
          )}
          {showTimers
            ? TIMERS.map((entry) => (
                <Pressable
                  key={entry.label}
                  onPress={() => {
                    setShowTimers(false);
                    void setMessageTimer
                      .mutateAsync({ seconds: entry.seconds })
                      .then(() => settingsQuery.refetch())
                      .catch((error: unknown) => setStatus(error instanceof Error && error.message ? error.message : "Could not save the timer"));
                  }}
                  style={[styles.timerRow, { borderBottomColor: colors.border }]}
                >
                  <Text style={[styles.timerLabel, { color: timerSeconds === entry.seconds ? colors.primary : colors.foreground }]}>{entry.label}</Text>
                  {timerSeconds === entry.seconds ? <MaterialIcons name="check" size={17} color={colors.primary} /> : null}
                </Pressable>
              ))
            : null}
          {row(
            "done-all",
            "Read receipts",
            "Show when you have read messages. Turning it off also hides other people's.",
            <Switch
              value={readReceipts}
              onValueChange={(value) => persist("readReceipts", value, setReadReceipts, readReceipts)}
              trackColor={{ false: colors.border, true: "#A7E8CD" }}
              thumbColor={readReceipts ? colors.success : "#fff"}
            />,
          )}
          {row(
            "photo-library",
            "Media auto-download",
            "Open photos and videos as they arrive, unless a chat says otherwise.",
            <Switch
              value={autoDownload}
              onValueChange={(value) => persist("autoDownloadMedia", value, setAutoDownload, autoDownload)}
              trackColor={{ false: colors.border, true: "#A7E8CD" }}
              thumbColor={autoDownload ? colors.success : "#fff"}
            />,
          )}
        </View>

        <Text style={[styles.footnote, { color: colors.muted }]}>Looking for “Export chat”? It is per conversation now — open a chat, use the menu, then Export chat.</Text>
        {status ? <Text style={[styles.footnote, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { padding: 20, paddingTop: 0 },
  hero: { borderWidth: 1, borderRadius: 20, padding: 18, marginBottom: 14 },
  heroTitle: { fontSize: 18, fontWeight: "800", marginBottom: 5 },
  card: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 14 },
  row: { minHeight: 76, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth },
  icon: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, marginLeft: 12 },
  rowTitle: { fontSize: 14, fontWeight: "800" },
  sub: { fontSize: 12, lineHeight: 17, marginTop: 4 },
  value: { fontSize: 13, fontWeight: "700" },
  timerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 14, paddingLeft: 52 },
  timerLabel: { fontSize: 14, fontWeight: "600" },
  footnote: { fontSize: 12, lineHeight: 17, marginTop: 14 },
});
