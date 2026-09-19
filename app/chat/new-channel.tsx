import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

export default function NewChannelScreen() {
  const colors = useColors();
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = trpc.channels.create.useMutation();

  const trimmed = name.trim();
  const canCreate = trimmed.length >= 3 && !create.isPending;

  const submit = async () => {
    setError(null);
    try {
      const result = await create.mutateAsync({ name: trimmed, description: description.trim() || undefined });
      // replace, not push: going "back" from the new channel should return to Updates.
      router.replace({ pathname: "/chat/channel", params: { channelId: result.channelId, name: trimmed } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the channel.");
    }
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.foreground }]}>New channel</Text>
            <Text style={[styles.sub, { color: colors.muted }]}>Anyone can follow. Only you can post.</Text>
          </View>
        </View>

        <View style={styles.body}>
          <Text style={[styles.label, { color: colors.muted }]}>Channel name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Product updates"
            placeholderTextColor={colors.muted}
            maxLength={80}
            style={[styles.input, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]}
          />
          <Text style={[styles.label, { color: colors.muted }]}>Description</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What this channel is about (optional)"
            placeholderTextColor={colors.muted}
            maxLength={255}
            multiline
            style={[styles.input, styles.multiline, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]}
          />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Pressable onPress={submit} disabled={!canCreate} style={({ pressed }) => [styles.primary, { backgroundColor: canCreate ? colors.primary : colors.surface }, (pressed || !canCreate) && styles.pressed]}>
            <Text style={[styles.primaryText, { color: canCreate ? "#FFFFFF" : colors.muted }]}>{create.isPending ? "Creating…" : "Create channel"}</Text>
          </Pressable>
          {trimmed.length > 0 && trimmed.length < 3 ? <Text style={[styles.hint, { color: colors.muted }]}>Names need at least 3 characters.</Text> : null}
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, padding: 18 },
  headerCopy: { flex: 1 },
  title: { fontSize: 20, fontWeight: "800" },
  sub: { fontSize: 12, marginTop: 3 },
  body: { paddingHorizontal: 18 },
  label: { fontSize: 11, fontWeight: "800", letterSpacing: 1, marginTop: 16, marginBottom: 7 },
  input: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, height: 48, fontSize: 15 },
  multiline: { height: 96, paddingTop: 13, textAlignVertical: "top" },
  error: { fontSize: 12, lineHeight: 17, marginTop: 14 },
  primary: { marginTop: 22, height: 50, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  primaryText: { fontSize: 14, fontWeight: "800" },
  pressed: { opacity: 0.7 },
  hint: { fontSize: 11, marginTop: 9 },
});
