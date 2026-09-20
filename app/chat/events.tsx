import { useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

type Answer = "going" | "maybe" | "no";

const ANSWERS: Array<{ value: Answer; label: string }> = [
  { value: "going", label: "Going" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "Can't" },
];

/**
 * Reads a date and time typed as "YYYY-MM-DD HH:MM".
 *
 * There is no date picker in this app and adding one is a dependency and a screen of its own. The
 * format is spelled out in the placeholder rather than guessed at, and an unparseable value is
 * refused with the format repeated back, because silently storing `Invalid Date` would produce an
 * event that is impossible to cancel for the wrong reason.
 */
function parseWhen(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(date.getTime()) ? null : date;
}

export default function EventsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ conversationId?: string }>();
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : "";
  const myId = (user as (typeof user & { id?: number }) | null)?.id ?? null;

  const events = trpc.events.list.useQuery({ conversationId }, { enabled: conversationId.length > 0 });
  const createEvent = trpc.events.create.useMutation({ onSuccess: () => { void events.refetch(); setTitle(""); setDescription(""); setWhen(""); setWhere(""); } });
  const rsvp = trpc.events.rsvp.useMutation({ onSuccess: () => events.refetch() });
  const cancelEvent = trpc.events.cancel.useMutation({ onSuccess: () => events.refetch() });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [when, setWhen] = useState("");
  const [where, setWhere] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const submit = async () => {
    setError(null);
    const startsAt = parseWhen(when);
    if (!startsAt) {
      setError("Give the start as YYYY-MM-DD HH:MM, for example 2026-10-04 18:30.");
      return;
    }
    try {
      await createEvent.mutateAsync({
        conversationId,
        title: title.trim(),
        description: description.trim() || undefined,
        startsAt: startsAt.toISOString(),
        location: where.trim() || undefined,
      });
      setComposing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That event could not be created");
    }
  };

  const now = Date.now();

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Events</Text>
        <Pressable onPress={() => setComposing((open) => !open)} hitSlop={10}>
          <MaterialIcons name={composing ? "close" : "add"} size={22} color={colors.primary} />
        </Pressable>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {composing ? (
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="What is it?"
                placeholderTextColor={colors.muted}
                maxLength={120}
                style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
              />
              <TextInput
                value={when}
                onChangeText={setWhen}
                placeholder="YYYY-MM-DD HH:MM"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
              />
              <TextInput
                value={where}
                onChangeText={setWhere}
                placeholder="Where (optional)"
                placeholderTextColor={colors.muted}
                maxLength={200}
                style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
              />
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="Anything else (optional)"
                placeholderTextColor={colors.muted}
                multiline
                maxLength={2000}
                style={[styles.input, styles.multiline, { color: colors.foreground, borderColor: colors.border }]}
              />
              {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
              <Pressable
                disabled={!title.trim() || !when.trim() || createEvent.isPending}
                onPress={() => void submit()}
                style={[styles.primary, { backgroundColor: colors.primary, opacity: !title.trim() || !when.trim() || createEvent.isPending ? 0.5 : 1 }]}
              >
                <Text style={styles.primaryText}>{createEvent.isPending ? "Creating…" : "Create event"}</Text>
              </Pressable>
            </View>
          ) : null}

          {events.isLoading ? <ActivityIndicator color={colors.primary} /> : null}

          {(events.data ?? []).map((event) => {
            const starts = new Date(event.startsAt);
            const past = starts.getTime() < now;
            return (
              <View key={event.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, event.cancelledAt ? styles.cancelled : null]}>
                <View style={styles.eventHead}>
                  <Text style={[styles.eventTitle, { color: colors.foreground }, event.cancelledAt ? styles.struck : null]} numberOfLines={2}>
                    {event.title}
                  </Text>
                  {event.cancelledAt ? (
                    <Text style={[styles.badge, { color: colors.error, borderColor: colors.error }]}>Cancelled</Text>
                  ) : past ? (
                    <Text style={[styles.badge, { color: colors.muted, borderColor: colors.border }]}>Past</Text>
                  ) : null}
                </View>

                <Text style={[styles.eventWhen, { color: colors.primary }]}>
                  {starts.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                </Text>
                {event.location ? <Text style={[styles.eventMeta, { color: colors.muted }]}>at {event.location}</Text> : null}
                {event.description ? <Text style={[styles.eventMeta, { color: colors.muted }]}>{event.description}</Text> : null}
                <Text style={[styles.eventMeta, { color: colors.muted }]}>
                  by {event.creatorName} · {event.going} going
                  {event.maybe ? `, ${event.maybe} maybe` : ""}
                  {event.declined ? `, ${event.declined} can’t` : ""}
                </Text>

                {!event.cancelledAt ? (
                  <View style={styles.answers}>
                    {ANSWERS.map((answer) => {
                      const chosen = event.myAnswer === answer.value;
                      return (
                        <Pressable
                          key={answer.value}
                          disabled={rsvp.isPending}
                          onPress={() => rsvp.mutate({ eventId: event.id, response: answer.value })}
                          style={[styles.answer, { borderColor: chosen ? colors.primary : colors.border }, chosen && { backgroundColor: colors.primary }]}
                        >
                          <Text style={[styles.answerText, { color: chosen ? "#FFFFFF" : colors.foreground }]}>{answer.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}

                {/* Only the creator may cancel, and the server enforces that - so the button is
                    shown to them alone rather than offered and then refused. */}
                {event.creatorId === myId && !event.cancelledAt ? (
                  <Pressable onPress={() => void cancelEvent.mutate({ eventId: event.id })} style={styles.cancelLink}>
                    <Text style={[styles.actionText, { color: colors.error }]}>Cancel this event</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}

          {!events.isLoading && (events.data ?? []).length === 0 && !composing ? (
            <Text style={[styles.empty, { color: colors.muted }]}>
              No events in this chat yet. Tap + to add one — everyone in the conversation can say whether they are coming.
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 10 },
  card: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 },
  cancelled: { opacity: 0.65 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5 },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  primary: { borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 2 },
  primaryText: { color: "#FFFFFF", fontSize: 14.5, fontWeight: "800" },
  eventHead: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  eventTitle: { flex: 1, fontSize: 16, fontWeight: "800" },
  struck: { textDecorationLine: "line-through" },
  badge: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 2, fontSize: 10.5, fontWeight: "800", overflow: "hidden" },
  eventWhen: { fontSize: 13.5, fontWeight: "700" },
  eventMeta: { fontSize: 12.5, lineHeight: 18 },
  answers: { flexDirection: "row", gap: 8, marginTop: 4 },
  answer: { flex: 1, borderWidth: 1, borderRadius: 11, paddingVertical: 9, alignItems: "center" },
  answerText: { fontSize: 12.5, fontWeight: "700" },
  cancelLink: { marginTop: 4 },
  actionText: { fontSize: 12.5, fontWeight: "700" },
  empty: { fontSize: 12.5, lineHeight: 18 },
  error: { fontSize: 12.5, fontWeight: "700" },
});
