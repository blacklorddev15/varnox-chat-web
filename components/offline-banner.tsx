import { StyleSheet, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";
import { useOnline } from "@/hooks/use-online";

/**
 * The strip that says the app is offline.
 *
 * It draws nothing while there is a connection, so a screen can drop it in unconditionally rather
 * than threading a boolean through every caller. It subscribes itself for the same reason - one
 * component that knows about the connection is one place to change.
 *
 * It exists because a disabled send button with no explanation reads as a bug. WhatsApp says the
 * same thing in the same place, and it is the difference between "this app is broken" and "I am
 * out of signal".
 */
export function OfflineBanner() {
  const colors = useColors();
  const online = useOnline();

  if (online) return null;

  return (
    <View
      style={[
        styles.bar,
        // Warning-coloured rather than an error red: nothing has failed, the app is working
        // correctly and simply has nothing to send over.
        { backgroundColor: colors.warning },
      ]}
      accessibilityRole="alert"
    >
      <MaterialIcons name="cloud-off" size={15} color="#3A2A05" />
      <Text style={styles.text} numberOfLines={2}>
        No connection. You can still read your chats — sending and calling need the internet.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  // Fixed dark ink rather than the theme's foreground: this sits on the warning colour in both
  // schemes, and the light scheme's dark ink is the one that is readable on amber.
  text: { flex: 1, fontSize: 12, lineHeight: 16, fontWeight: "700", color: "#3A2A05" },
});
