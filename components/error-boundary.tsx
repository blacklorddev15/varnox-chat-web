import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

/**
 * Catches a render crash and shows it, instead of leaving a blank screen.
 *
 * A React tree that throws while rendering is unmounted, and what is left on the device is the
 * background colour and nothing else - indistinguishable from a screen that is merely waiting, from
 * a page that failed to load, and from an app that has hung. That is the single most useless state a
 * UI can be in, and it is the state a call on this app has been reported in three times.
 *
 * The report is deliberately not thrown away: `onError` sends it to the server, because the only
 * place this code runs is a phone, and a phone's console is not somewhere anybody can look.
 *
 * A class component because there is still no hook equivalent of `componentDidCatch`.
 */
export function ErrorBoundary({
  children,
  onError,
  label = "This screen",
}: {
  children: ReactNode;
  onError?: (message: string, stack: string, where: string) => void;
  label?: string;
}) {
  return (
    <ErrorBoundaryInner onError={onError} label={label}>
      {children}
    </ErrorBoundaryInner>
  );
}

type State = { message: string | null; stack: string | null };

class ErrorBoundaryInner extends Component<{ children: ReactNode; onError?: (message: string, stack: string, where: string) => void; label: string }, State> {
  state: State = { message: null, stack: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = `${error instanceof Error ? error.stack ?? "" : ""}\n${info.componentStack ?? ""}`.slice(0, 400);
    this.setState({ stack });
    try {
      this.props.onError?.(message, stack, `render:${this.props.label}`);
    } catch {
      // A reporter that throws must not take the error screen down with it.
    }
  }

  render() {
    if (!this.state.message) return this.props.children;

    // Rendered on the app's dark background with the message in the foreground, so a screenshot or a
    // glance is enough to say what went wrong without a developer console.
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>{this.props.label} stopped responding</Text>
        <Text style={styles.message}>{this.state.message}</Text>
        <ScrollView style={styles.stackBox} contentContainerStyle={styles.stackInner}>
          <Text style={styles.stack}>{this.state.stack ?? "no stack"}</Text>
        </ScrollView>
        <Pressable onPress={() => this.setState({ message: null, stack: null })} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
        <Text style={styles.note}>This report has been sent. Note what you were doing and tell whoever maintains the app.</Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: "#0B0B10", padding: 22, justifyContent: "center" },
  title: { color: "#F4F4F5", fontSize: 17, fontWeight: "800", marginBottom: 10 },
  message: { color: "#FCA5A5", fontSize: 13, lineHeight: 19, fontWeight: "700", marginBottom: 14 },
  stackBox: { maxHeight: 200, borderWidth: 1, borderColor: "#2A2A33", borderRadius: 12, backgroundColor: "#14141A" },
  stackInner: { padding: 12 },
  stack: { color: "#9CA3AF", fontSize: 10, lineHeight: 14, fontFamily: "monospace" },
  button: { marginTop: 18, backgroundColor: "#10B981", borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  buttonText: { color: "#FFFFFF", fontSize: 14.5, fontWeight: "800" },
  pressed: { opacity: 0.75 },
  note: { color: "#6B7280", fontSize: 11.5, lineHeight: 16, marginTop: 14, textAlign: "center" },
});
