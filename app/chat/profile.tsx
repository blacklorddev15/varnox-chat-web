import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/** Absolute URL for a same-origin API path (relative URLs do not resolve on native). */
function apiUrl(path: string): string {
  if (Platform.OS === "web" && typeof window !== "undefined") return window.location.origin + path;
  const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? "";
  return base.replace(/\/+$/, "") + path;
}

function initialsOf(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Shrinks a picked photo to a 256px square JPEG on web, so a camera photo does not land in
 * the database at several megabytes. Falls back to the picker's own base64 elsewhere.
 */
async function toAvatarPayload(
  asset: ImagePicker.ImagePickerAsset,
): Promise<{ base64: string; mimeType: string } | null> {
  if (Platform.OS === "web" && typeof document !== "undefined" && asset.uri) {
    try {
      const img = document.createElement("img");
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Could not read that image"));
        img.src = asset.uri;
      });
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      const side = Math.min(width, height);
      if (side > 0) {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, (width - side) / 2, (height - side) / 2, side, side, 0, 0, size, size);
          const base64 = canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
          if (base64) return { base64, mimeType: "image/jpeg" };
        }
      }
    } catch {
      // fall through to whatever the picker gave us
    }
  }
  if (asset.base64) return { base64: asset.base64, mimeType: asset.mimeType ?? "image/jpeg" };
  return null;
}

export default function ProfileScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);

  const updateProfile = trpc.profile.update.useMutation();
  const setAvatar = trpc.profile.setAvatar.useMutation();
  const clearAvatar = trpc.profile.clearAvatar.useMutation();

  useEffect(() => {
    if (!user) return;
    setName(user.name ?? user.username ?? "");
    setAbout(user.about ?? "");
  }, [user]);

  const busy = updateProfile.isPending || setAvatar.isPending || clearAvatar.isPending;
  const avatarUpdatedAt = user?.avatarUpdatedAt ?? null;
  const avatarUri = user?.id && avatarUpdatedAt
    ? apiUrl(`/api/avatar/${user.id}?v=${encodeURIComponent(avatarUpdatedAt)}`)
    : null;
  const showPhoto = Boolean(avatarUri) && !imageFailed;

  const pickPhoto = async () => {
    setStatus(null);
    // Track which step we reached: the message then says exactly where it failed instead of
    // a generic "could not update", which is what made this undiagnosable from a screenshot.
    let step = "asking for photo permission";
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setStatus("Photo access was refused. Allow photos for this app, then try again.");
        return;
      }
      step = "opening the photo picker";
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        base64: true,
      });
      if (result.canceled || !result.assets?.length) return;
      step = "reading the chosen image";
      const payload = await toAvatarPayload(result.assets[0]);
      if (!payload) {
        setStatus("Could not read that image: the picker returned no usable data.");
        return;
      }
      const sizeKb = Math.round(payload.base64.length / 1024);
      step = `uploading (${sizeKb} KB as ${payload.mimeType})`;
      await setAvatar.mutateAsync(payload);
      step = "refreshing your account";
      setImageFailed(false);
      await refresh();
      setStatus(`Profile photo updated (${sizeKb} KB).`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Failed while ${step}: ${detail}`);
    }
  };

  const removePhoto = async () => {
    setStatus(null);
    try {
      await clearAvatar.mutateAsync();
      setImageFailed(false);
      await refresh();
      setStatus("Profile photo removed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not remove your photo.");
    }
  };

  const save = async () => {
    setStatus(null);
    try {
      await updateProfile.mutateAsync({ name: name.trim() || undefined, about: about.trim() });
      await refresh();
      router.back();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save your profile.");
    }
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Profile</Text>
        <Pressable onPress={save} disabled={busy}>
          {busy ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={[styles.save, { color: colors.primary }]}>Save</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.content}>
        <Pressable onPress={pickPhoto} style={styles.avatarWrap}>
          {showPhoto ? (
            <Image
              source={{ uri: avatarUri as string }}
              style={styles.avatarImage}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
              <Text style={styles.initials}>{initialsOf(name || user?.username || "VARNOX")}</Text>
            </View>
          )}
          <View style={styles.camera}>
            <MaterialIcons name="photo-camera" size={15} color="#fff" />
          </View>
        </Pressable>

        <Text style={[styles.hint, { color: colors.muted }]}>
          Tap your photo to {showPhoto ? "change" : "add"} a picture
        </Text>
        {showPhoto ? (
          <Pressable onPress={removePhoto}>
            <Text style={[styles.remove, { color: colors.muted }]}>Remove photo</Text>
          </Pressable>
        ) : null}
        {status ? <Text style={[styles.status, { color: colors.muted }]}>{status}</Text> : null}

        <Text style={[styles.label, { color: colors.muted }]}>NAME</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder=""
          style={[styles.input, { color: colors.foreground, borderBottomColor: colors.border }]}
        />

        <Text style={[styles.label, { color: colors.muted }]}>ABOUT</Text>
        <TextInput
          value={about}
          onChangeText={setAbout}
          placeholder=""
          maxLength={140}
          style={[styles.input, { color: colors.foreground, borderBottomColor: colors.border }]}
        />

        <View style={[styles.private, { backgroundColor: colors.surface }]}>
          <MaterialIcons name="lock" size={18} color={colors.success} />
          <Text style={[styles.privateText, { color: colors.muted }]}>
            Your email and phone are private. Only your name, photo, and about line are visible to contacts.
          </Text>
        </View>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  save: { fontSize: 14, fontWeight: "800" },
  content: { padding: 24, alignItems: "stretch" },
  avatarWrap: { alignSelf: "center", marginBottom: 12 },
  avatar: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center" },
  avatarImage: { width: 96, height: 96, borderRadius: 48 },
  initials: { color: "#fff", fontSize: 30, fontWeight: "800" },
  camera: { position: "absolute", bottom: 0, right: 0, width: 30, height: 30, borderRadius: 15, backgroundColor: "#0EA5E9", alignItems: "center", justifyContent: "center" },
  hint: { fontSize: 12, textAlign: "center", marginBottom: 6 },
  remove: { fontSize: 12, fontWeight: "700", textAlign: "center", textDecorationLine: "underline", marginBottom: 6 },
  status: { fontSize: 12, textAlign: "center", marginTop: 10 },
  label: { fontSize: 11, letterSpacing: 1.2, fontWeight: "800", marginTop: 18 },
  input: { height: 48, borderBottomWidth: 1, fontSize: 16 },
  private: { flexDirection: "row", gap: 10, padding: 14, borderRadius: 15, marginTop: 28 },
  privateText: { flex: 1, fontSize: 12, lineHeight: 17 },
});
