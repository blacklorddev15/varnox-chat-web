import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";

/**
 * Emoji picker for the composer.
 *
 * The set is a fixed, hand-picked list rather than the full Unicode table. A complete table is
 * roughly 3,600 entries and would be a megabyte of source shipped to every client to serve the same
 * few hundred glyphs people actually type. These are all long-established characters that render
 * everywhere, including the Android WebView shell, so nothing shows up as a tofu box.
 *
 * The list is written as space-separated strings split at module load: it keeps the data readable
 * and saves the quoting overhead of a literal array per group.
 */
type EmojiGroup = { id: string; label: string; emoji: string[] };

const group = (id: string, label: string, emoji: string): EmojiGroup => ({
  id,
  label,
  emoji: emoji.split(" "),
});

const GROUPS: EmojiGroup[] = [
  group(
    "smileys",
    "Smileys",
    "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕",
  ),
  group(
    "people",
    "People",
    "👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💪 🦵 🦶 👂 👃 👀 👁️ 👅 👄 🧠 🫀 🫁 🦷 🦴 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙈 🙉 🙊 💁 🙅 🙆 🙋 🧏 🤦 🤷 👮 🕵️ 💂 👷 🤴 👸 🧙 🧚 🧜 🧝 🦸 🦹 🧞 💃 🕺 👯 🧖 🧗 🏃 🚶",
  ),
  group(
    "hearts",
    "Hearts",
    "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💋 👋 ✨ ⭐ 🌟 💫 ⚡ 🔥 💥 💯 ✅ ❌ ⚠️ ❓ ❗ 💤 💢 💬 💭 🗯️ 🎉 🎊 🎈 🎁 🎀 🏆 🥇 🎖️ 🔔 🔕 📢 📣 ⏳ ⌛ 🕐 🕑 🕒 🔒 🔓 🔑 🗝️",
  ),
  group(
    "animals",
    "Animals",
    "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🦗 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦀 🦞 🐠 🐟 🐡 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦏 🐪 🐫 🦒 🐄 🐎 🐖 🐏 🐑 🐐 🦌 🐕 🐩 🐈",
  ),
  group(
    "nature",
    "Nature",
    "🌸 💮 🏵️ 🌹 🌺 🌻 🌼 🌷 🌱 🌲 🌳 🌴 🌵 🌾 🌿 ☘️ 🍀 🍁 🍂 🍃 🌍 🌎 🌏 🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘 🌙 🌚 🌛 🌜 ☀️ 🌝 🌞 ⭐ 🌟 🌠 ☁️ ⛅ ⛈️ 🌤️ 🌥️ 🌦️ 🌧️ 🌨️ 🌩️ 🌪️ 🌫️ 🌬️ 💧 💦 ☔ ☂️ 🌈",
  ),
  group(
    "food",
    "Food",
    "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🥕 🌽 🌶️ 🥒 🥬 🧄 🧅 🥔 🍠 🥐 🍞 🥖 🧀 🥚 🍳 🥞 🧇 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 🍼 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾",
  ),
  group(
    "activity",
    "Activity",
    "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🏑 🥍 🏏 🥊 🥋 🎽 🛹 🛼 🛷 ⛸️ 🥌 🎿 ⛷️ 🏂 🏋️ 🤼 🤸 ⛹️ 🤺 🤾 🏌️ 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 🧩 🎯 🎳 🎮 🎰 🎟️ 🎫",
  ),
  group(
    "travel",
    "Travel",
    "🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚚 🚛 🚜 🛴 🚲 🛵 🏍️ ✈️ 🛫 🛬 🛩️ 🚀 🛰️ 🚁 ⛵ 🚤 🛳️ ⛴️ 🚢 ⚓ 🚧 ⛽ 🚏 🚦 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ ⛱️ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻 🏕️ 🏠 🏡 🏢 🏥 🏦 🏨 🏪 🏫 🏬 🏭 🏯 ⛪ 🕌 🕍 🛕 🏛️",
  ),
  group(
    "objects",
    "Objects",
    "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📽️ 📞 ☎️ 📟 📠 📺 📻 🎙️ ⏰ ⏱️ ⏲️ 🕰️ 🔋 🔌 💡 🔦 🕯️ 🧯 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🪓 🔪 🗡️ ⚔️ 🛡️ 🚬 ⚰️ 🏺 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 🩹 🩺 🌡️ 🧬 🦠 🧫 🧪 🧹 🧺 🧻 🚽 🚿 🛁 🧴 🧷 🧵 🧶 🥽 🥼 🦺 👓 🕶️",
  ),
  group(
    "symbols",
    "Symbols",
    "🏁 🚩 🎌 🏴 🏳️ ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❔ ❕ 🔅 🔆 〽️ ⚜️ 🔱 📛 🔰 ♻️ ✳️ ❇️ ✴️ 💠 Ⓜ️ 🅰️ 🅱️ 🆎 🅾️ 🆑 🅿️ 🆘 🆔 🆚 🈁 🔤 🔡 🔠 🔢 🔣 📶 📳 📴 📵 🔞 🔃 🔄 🔙 🔚 🔛 🔜 🔝 🔀 🔁 🔂 ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ ⏩ ⏪ ⏫ ⏬ ⏯️",
  ),
];

export function EmojiPicker({
  colors,
  onSelect,
  onClose,
}: {
  colors: ReturnType<typeof useColors>;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState(GROUPS[0].id);
  const active = GROUPS.find((entry) => entry.id === activeId) ?? GROUPS[0];

  return (
    <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.heading, { color: colors.foreground }]}>Emoji</Text>
        <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => pressed && styles.pressed}>
          <MaterialIcons name="close" size={18} color={colors.muted} />
        </Pressable>
      </View>

      {/* Horizontal so the group strip never wraps into the grid on a narrow phone. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {GROUPS.map((entry) => {
          const selected = entry.id === activeId;
          return (
            <Pressable
              key={entry.id}
              onPress={() => setActiveId(entry.id)}
              style={[
                styles.tab,
                { borderColor: colors.border },
                selected && { backgroundColor: colors.primary, borderColor: colors.primary },
              ]}
            >
              <Text style={[styles.tabLabel, { color: selected ? "#FFFFFF" : colors.muted }]}>{entry.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* keyboardShouldPersistTaps keeps the composer focused while tapping glyphs. */}
      <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid} keyboardShouldPersistTaps="always">
        {active.emoji.map((emoji) => (
          <Pressable
            key={`${active.id}-${emoji}`}
            onPress={() => onSelect(emoji)}
            style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
          >
            <Text style={styles.glyph}>{emoji}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, paddingBottom: 8 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, marginBottom: 8 },
  heading: { fontSize: 12, fontWeight: "800", letterSpacing: 1.1 },
  tabs: { paddingHorizontal: 12, gap: 8 },
  tab: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 5 },
  tabLabel: { fontSize: 11.5, fontWeight: "700" },
  // Bounded so the picker cannot push the composer off a short screen; the grid scrolls instead.
  gridScroll: { maxHeight: 208, marginTop: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 10, paddingBottom: 6 },
  cell: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  glyph: { fontSize: 23, lineHeight: 30 },
  pressed: { opacity: 0.5 },
});
