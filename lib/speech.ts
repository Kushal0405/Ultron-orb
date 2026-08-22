// Speaks Claude's answers aloud via the Web Speech Synthesis API. There's no
// conversation/transcript panel in the HUD by design, so audio is the only
// feedback surface for open-ended answers (vs. the silent, instant allowlist
// actions for known commands).

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function speak(text: string): void {
  if (!isSpeechSynthesisSupported() || !text.trim()) return;
  window.speechSynthesis.cancel(); // don't queue behind a previous answer
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.02;
  utterance.pitch = 0.95;
  window.speechSynthesis.speak(utterance);
}
