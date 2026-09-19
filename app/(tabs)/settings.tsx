import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";

const menu = [
  { id: "account", icon: "person-outline" as const, title: "Account", subtitle: "Security notifications, change number" },
  { id: "verify-email", icon: "verified" as const, title: "Verify email", subtitle: "Protect your account and recovery access" },
  { id: "privacy", icon: "lock-outline" as const, title: "Privacy", subtitle: "Blocked contacts, disappearing messages" },
  { id: "chats", icon: "chat-bubble-outline" as const, title: "Chats", subtitle: "Theme, wallpapers, chat history" },
  { id: "notifications", icon: "notifications-none" as const, title: "Notifications", subtitle: "Messages, groups, calls" },
  { id: "starred", icon: "star-border" as const, title: "Starred messages", subtitle: "Find saved messages across chats" },
  { id: "storage", icon: "folder-open" as const, title: "Storage and data", subtitle: "Media usage, downloads, network" },
  { id: "blocked", icon: "block" as const, title: "Blocked contacts", subtitle: "Manage people you have blocked" },
  { id: "appeals", icon: "history" as const, title: "Appeal history", subtitle: "Track account review requests" },
  { id: "support", icon: "support-agent" as const, title: "Varnox Support Bot", subtitle: "Get help with login, privacy, and safety" },
  { id: "admin", icon: "admin-panel-settings" as const, title: "Admin moderation", subtitle: "Manage bans and suspensions" },
];

export default function SettingsScreen() {
  const colors = useColors(); const router = useRouter(); const { user } = useAuth();
  const isAdmin = (user as (typeof user & { role?: string }) | null)?.role === "admin";
  const [readReceipts, setReadReceipts] = useState(true); const [lastSeen, setLastSeen] = useState(true); const [darkTheme, setDarkTheme] = useState(false);
  const settingsQuery = trpc.settings.get.useQuery(undefined, { enabled: Boolean(user) });
  const saveSettings = trpc.settings.update.useMutation({ onSuccess: () => settingsQuery.refetch() });
  useEffect(() => { const data = settingsQuery.data; if (!data) return; setReadReceipts(Boolean(data.readReceipts)); setLastSeen(Boolean(data.lastSeen)); setDarkTheme(Boolean(data.darkTheme)); }, [settingsQuery.data]);
  const persist = (key: "readReceipts" | "lastSeen" | "darkTheme", value: boolean) => { if (key === "readReceipts") setReadReceipts(value); if (key === "lastSeen") setLastSeen(value); if (key === "darkTheme") setDarkTheme(value); saveSettings.mutate({ [key]: value }); };
  const openItem = (item: typeof menu[number]) => {
    if (item.id === "starred") return router.push("/chat/starred");
    if (item.id === "chats") return router.push("/chat/settings");
    if (item.id === "account") return router.push("/chat/profile");
    if (item.id === "verify-email") return router.push("/verify-email");
    if (item.id === "support") return router.push("/chat/support");
    if (item.id === "appeals") return router.push("/chat/appeals");
    if (item.id === "admin") return router.push("/admin");
    return router.push({ pathname: "/chat/setting-detail", params: { section: item.id, title: item.title, subtitle: item.subtitle } });
  };
  return <ScreenContainer className="bg-background" edges={["top", "left", "right"]}><StatusBar style="dark" /><ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator bounces><View style={styles.header}><Text style={[styles.heading, { color: colors.foreground }]}>Settings</Text><Pressable onPress={() => router.push({ pathname: "/chat/setting-detail", params: { section: "search", title: "Settings search", subtitle: "Search and manage Varnox preferences." } })} hitSlop={12} style={({ pressed }) => [styles.searchButton, pressed && styles.pressed]}><MaterialIcons name="search" size={23} color={colors.foreground}/></Pressable></View><Pressable onPress={() => router.push("/chat/profile")} style={({ pressed }) => [styles.profileCard, pressed && styles.pressed]}><View style={[styles.profileAvatar, { backgroundColor: colors.primary }]}><Text style={styles.profileInitials}>AL</Text></View><View style={styles.profileCopy}><Text style={[styles.profileName, { color: colors.foreground }]}>Alex Morgan</Text><Text style={[styles.profileHandle, { color: colors.muted }]}>@alexm · available</Text></View><MaterialIcons name="qr-code-2" size={25} color={colors.primary}/><MaterialIcons name="chevron-right" size={21} color={colors.muted}/></Pressable><View style={styles.menuList}>{menu.filter((item) => item.id !== "admin" || isAdmin).map((item) => <Pressable key={item.id} onPress={() => openItem(item)} style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}><View style={[styles.menuIcon, { backgroundColor: "rgba(245, 158, 11, 0.13)" }]}><MaterialIcons name={item.icon} size={21} color={colors.primary}/></View><View style={[styles.menuCopy, { borderBottomColor: colors.border }]}><Text style={[styles.menuTitle, { color: colors.foreground }]}>{item.title}</Text><Text style={[styles.menuSubtitle, { color: colors.muted }]} numberOfLines={1}>{item.subtitle}</Text></View><MaterialIcons name="chevron-right" size={21} color={colors.muted}/></Pressable>)}</View><Text style={[styles.preferenceLabel, { color: colors.muted }]}>PREFERENCES</Text><PreferenceRow icon="done-all" iconColor={colors.success} title="Read receipts" subtitle="Let contacts know when you’ve read messages" value={readReceipts} onChange={(value) => persist("readReceipts", value)} colors={colors}/><PreferenceRow icon="visibility" iconColor="#8B5CF6" title="Last seen and online" subtitle="Control who can see your activity" value={lastSeen} onChange={(value) => persist("lastSeen", value)} colors={colors}/><PreferenceRow icon="dark-mode" iconColor="#0EA5E9" title="Theme and wallpaper" subtitle="Light, dark, and five chat wallpapers" value={darkTheme} onChange={(value) => persist("darkTheme", value)} colors={colors}/><Text style={[styles.version, { color: colors.muted }]}>Varnox v1.0 · made for meaningful conversations</Text></ScrollView></ScreenContainer>;
}

function PreferenceRow({ icon, iconColor, title, subtitle, value, onChange, colors }: { icon: React.ComponentProps<typeof MaterialIcons>["name"]; iconColor: string; title: string; subtitle: string; value: boolean; onChange: (value: boolean) => void; colors: ReturnType<typeof useColors> }) { return <View style={[styles.preferenceCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable onPress={() => onChange(!value)} style={({ pressed }) => [styles.preferenceRow, pressed && styles.pressed]}><View style={[styles.preferenceIcon, { backgroundColor: `${iconColor}22` }]}><MaterialIcons name={icon} size={20} color={iconColor}/></View><View style={styles.preferenceCopy}><Text style={[styles.menuTitle, { color: colors.foreground }]}>{title}</Text><Text style={[styles.menuSubtitle, { color: colors.muted }]}>{subtitle}</Text></View><Switch value={value} onValueChange={onChange} trackColor={{ false: colors.border, true: `${iconColor}66` }} thumbColor={value ? iconColor : "#FFFFFF"}/></Pressable></View>; }

const styles = StyleSheet.create({ scrollContent: { paddingBottom: 110 }, header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 22, paddingBottom: 20 }, heading: { fontSize: 32, lineHeight: 38, fontWeight: "800", letterSpacing: -1 }, searchButton: { width: 37, height: 37, borderRadius: 19, alignItems: "center", justifyContent: "center" }, pressed: { opacity: 0.58 }, profileCard: { flexDirection: "row", alignItems: "center", marginHorizontal: 20, paddingBottom: 22 }, profileAvatar: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center" }, profileInitials: { color: "#FFFFFF", fontSize: 20, fontWeight: "800" }, profileCopy: { flex: 1, marginLeft: 14 }, profileName: { fontSize: 18, fontWeight: "800" }, profileHandle: { fontSize: 13, marginTop: 5 }, menuList: { marginTop: 10 }, menuRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, minHeight: 73 }, menuIcon: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" }, menuCopy: { flex: 1, marginLeft: 13, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth }, menuTitle: { fontSize: 14, fontWeight: "750" as any }, menuSubtitle: { fontSize: 11, marginTop: 4 }, preferenceLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginHorizontal: 20, marginTop: 21, marginBottom: 10 }, preferenceCard: { marginHorizontal: 20, borderRadius: 18, borderWidth: 1, marginBottom: 10 }, preferenceRow: { flexDirection: "row", alignItems: "center", padding: 14 }, preferenceIcon: { width: 41, height: 41, borderRadius: 13, alignItems: "center", justifyContent: "center" }, preferenceCopy: { flex: 1, marginLeft: 12, paddingRight: 8 }, version: { textAlign: "center", fontSize: 11, marginTop: 12, marginBottom: 18 } });
